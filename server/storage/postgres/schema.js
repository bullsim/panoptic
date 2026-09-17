/**
 * Evidence Store physical schema — DDL only.
 *
 * ONE TABLE. The Evidence Store's whole query surface is served by
 * `observation`; nothing in the committed semantics reads batch membership, so
 * an `observation_batch` table would have to invent a batch identity the v1
 * batch format does not carry — the same class of mistake as inventing an
 * `observationId`. Raw evidence, fetch history, entities and aggregates are
 * deferred, and absent here on purpose.
 *
 * NOTHING IN THIS FILE IMPLEMENTS A RULE. Record keys, state keys, candidate-key
 * tokens, JSON preparation and identity are all computed in shared JavaScript
 * before a row reaches SQL. The database stores what it is given and indexes it.
 * The moment SQL starts canonicalising something, there are two implementations
 * of that rule and they will eventually disagree.
 *
 * @module server/storage/postgres/schema
 */

/**
 * A schema name safe to interpolate into SQL.
 *
 * PostgreSQL cannot parameterise an identifier, so the name is validated against
 * a deliberately narrow pattern and quoted. Everything else in this adapter is a
 * bound parameter; this is the only interpolation, and it never accepts caller
 * input in a query path.
 */
const SCHEMA_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

/** The evidence table's unqualified name. */
export const OBSERVATION_TABLE = 'observation';

/**
 * Validate a schema name, or throw.
 *
 * @param {unknown} schema - Candidate schema name.
 * @returns {string} The validated name.
 */
export function assertSchemaName(schema) {
  if (typeof schema !== 'string' || !SCHEMA_NAME.test(schema)) {
    throw new TypeError(
      `invalid schema name: expected ${SCHEMA_NAME} — identifiers cannot be parameterised, `
      + 'so only a conservative pattern is accepted',
    );
  }
  return schema;
}

/**
 * The quoted, qualified evidence table for a validated schema.
 *
 * @param {string} schema - Schema name.
 * @returns {string} e.g. `"panoptic".observation`
 */
export function qualifiedTable(schema) {
  return `"${assertSchemaName(schema)}".${OBSERVATION_TABLE}`;
}

/**
 * Idempotent DDL for one evidence schema.
 *
 * COLUMN NOTES
 *
 *   observation_id    TEXT, not bytea. The committed tie-break compares ids as
 *                     STRINGS, and the base32 alphabet is not in ASCII order, so
 *                     ordering 16 raw bytes would pick a different revision.
 *                     COLLATE "C" makes PostgreSQL order bytes, matching
 *                     JavaScript's comparison for these ids exactly.
 *   observed_at       EVENT TIME. Also present inside the document; this column
 *                     exists to be filtered and ordered on.
 *   ingested_at       KNOWLEDGE TIME — storage metadata, supplied by the batch
 *                     and never a commit time. Not in the document.
 *   source_id/_feed   Storage metadata: the source lives on the row, not inside
 *                     the Observation, exactly as the reference store holds it.
 *   record_key        Derived query key, computed by shared JavaScript. NULL when
 *   state_key         the source issues no record id — which is a fact about the
 *                     source, and why the two are constrained to agree.
 *   candidate_keys    Canonical `namespace=value` tokens, also computed in shared
 *                     JavaScript. SQL never applies a namespace rule.
 *   observation       The full canonical Observation, already resolved and
 *                     JSON-checked by prepareBatch. Never rewritten here.
 *
 * INDEXES are exactly the access paths the committed operations use; no
 * speculative ones, and no spatial index, because no operation takes a spatial
 * predicate yet.
 *
 * @param {string} schema - Validated schema name.
 * @returns {string[]} Statements to run in order.
 */
export function evidenceSchemaStatements(schema) {
  const name = assertSchemaName(schema);
  const table = `"${name}".${OBSERVATION_TABLE}`;

  return [
    `CREATE SCHEMA IF NOT EXISTS "${name}"`,

    `CREATE TABLE IF NOT EXISTS ${table} (
      observation_id    text        COLLATE "C" NOT NULL,
      observation_type  text        COLLATE "C" NOT NULL,
      observed_at       timestamptz             NOT NULL,
      ingested_at       timestamptz             NOT NULL,
      source_id         text        COLLATE "C" NOT NULL,
      source_feed       text        COLLATE "C",
      record_key        text        COLLATE "C",
      state_key         text        COLLATE "C",
      candidate_keys    text[]                  NOT NULL DEFAULT '{}',
      observation       jsonb                   NOT NULL,
      CONSTRAINT observation_pkey             PRIMARY KEY (observation_id),
      CONSTRAINT observation_id_not_empty     CHECK (observation_id <> ''),
      CONSTRAINT observation_source_not_empty CHECK (source_id <> ''),
      CONSTRAINT observation_feed_not_empty   CHECK (source_feed IS NULL OR source_feed <> ''),
      CONSTRAINT observation_keys_paired      CHECK ((record_key IS NULL) = (state_key IS NULL)),
      CONSTRAINT observation_is_object        CHECK (jsonb_typeof(observation) = 'object')
    )`,

    `CREATE INDEX IF NOT EXISTS observation_type_time
       ON ${table} (observation_type, observed_at, ingested_at, observation_id)`,

    `CREATE INDEX IF NOT EXISTS observation_record_state
       ON ${table} (record_key, observed_at DESC, ingested_at DESC, observation_id DESC)
       WHERE record_key IS NOT NULL`,

    `CREATE INDEX IF NOT EXISTS observation_state_revision
       ON ${table} (state_key, ingested_at, observation_id)
       WHERE state_key IS NOT NULL`,

    `CREATE INDEX IF NOT EXISTS observation_candidate_keys
       ON ${table} USING gin (candidate_keys)`,

    // APPEND-ONLY, enforced by the database rather than by adapter manners.
    // Evidence is immutable: a revised earthquake is a new observation beside the
    // old one. Without this, one careless UPDATE could rewrite KNOWLEDGE TIME and
    // silently falsify every as-known answer that follows.
    `CREATE OR REPLACE FUNCTION "${name}".reject_evidence_mutation() RETURNS trigger
       LANGUAGE plpgsql AS $$
       BEGIN
         RAISE EXCEPTION
           'PANOPTIC evidence is append-only: % rejected on %.%',
           TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
           USING ERRCODE = 'restrict_violation';
       END $$`,

    `CREATE OR REPLACE TRIGGER observation_no_update_delete
       BEFORE UPDATE OR DELETE ON ${table}
       FOR EACH ROW EXECUTE FUNCTION "${name}".reject_evidence_mutation()`,

    `CREATE OR REPLACE TRIGGER observation_no_truncate
       BEFORE TRUNCATE ON ${table}
       FOR EACH STATEMENT EXECUTE FUNCTION "${name}".reject_evidence_mutation()`,
  ];
}

/**
 * Create the evidence schema if it is not already there.
 *
 * Deliberately explicit rather than automatic on store construction: a store
 * should not run DDL against a database just because someone opened it.
 *
 * @param {{query: Function}} executor - A pg Pool or Client.
 * @param {{schema: string}} options - Target schema.
 * @returns {Promise<string>} The schema name.
 */
export async function ensureEvidenceSchema(executor, { schema }) {
  const name = assertSchemaName(schema);
  for (const statement of evidenceSchemaStatements(name)) {
    await executor.query(statement);
  }
  return name;
}

/**
 * Drop an evidence schema and everything in it.
 *
 * ENVIRONMENT ADMINISTRATION, NOT EVIDENCE MUTATION — which is why it is allowed
 * to exist at all while UPDATE, DELETE and TRUNCATE are rejected. It is how an
 * isolated test schema is reclaimed; it is not a way to retract evidence through
 * the store, and the store exposes no path to it.
 *
 * @param {{query: Function}} executor - A pg Pool or Client.
 * @param {{schema: string}} options - Target schema.
 * @returns {Promise<void>} Resolves when dropped.
 */
export async function dropEvidenceSchema(executor, { schema }) {
  const name = assertSchemaName(schema);
  await executor.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`);
}
