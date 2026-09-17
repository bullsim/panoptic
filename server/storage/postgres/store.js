/**
 * PostgreSQL Evidence Store — a different place to put rows, not different rules.
 *
 * Every semantic decision this adapter makes is made for it, in
 * `server/storage/semantics.js`: what evidence is acceptable, how a batch is
 * prepared, which revision is in force, how results are ordered, which element
 * set answers a question. SQL narrows; the shared code decides. That is what
 * lets one conformance suite test this and the in-memory reference store and
 * hold them to identical behaviour.
 *
 * WHAT SQL IS NOT ALLOWED TO DO HERE:
 *   - derive or rewrite an `observationId`
 *   - build or parse a record key or state key
 *   - canonicalise a candidate key (no zero-padding, no case folding)
 *   - normalise the Observation document
 *   - substitute a commit time for KNOWLEDGE TIME
 *
 * The store takes an injected pool and does not own its lifecycle. Whoever
 * created the pool ends it.
 *
 * @module server/storage/postgres/store
 */

import {
  EMPTY_ENTITY_HISTORY,
  assembleEntityHistory,
  assertObservationId,
  buildElementSetResult,
  byEventTime,
  byKnowledge,
  collapseRevisions,
  compareText,
  deepFreeze,
  prepareBatch,
  prepareElementSetQuery,
  prepareEntityHistoryQuery,
  prepareObservationsBetweenQuery,
  prepareRecordHistoryQuery,
  prepareRevisionsOfQuery,
  prepareStatesAtQuery,
} from '../semantics.js';
import { EvidenceStoreUnavailable, isInfrastructureError } from './connect.js';
import { qualifiedTable } from './schema.js';

/**
 * Rows per INSERT statement.
 *
 * The whole chunk travels as ONE jsonb parameter, so PostgreSQL's 65,535-bind-
 * parameter ceiling is not the constraint — message size is. At roughly 300–600
 * bytes per prepared FIRMS observation, 5,000 rows is a ~2–3 MB statement: large
 * enough that a 311k-detection batch is ~63 statements rather than thousands,
 * small enough to stay well inside libpq's practical message handling and to
 * keep memory flat. Every chunk runs inside ONE transaction, so the batch is
 * still all-or-nothing.
 */
const INSERT_CHUNK_ROWS = 5_000;

/** Columns every read returns, including KNOWLEDGE TIME as exact epoch ms. */
const READ_COLUMNS = `observation_id, observation_type, source_id, source_feed,
  record_key, state_key, candidate_keys, observation,
  (EXTRACT(EPOCH FROM ingested_at) * 1000)::bigint AS ingested_at_ms`;

/** Epoch ms to a timestamptz literal, exactly and unambiguously. */
function toTimestamp(epochMs) {
  return new Date(epochMs).toISOString();
}

/**
 * Rebuild the canonical stored row from a database row.
 *
 * `observedAt` and `sourceRecordId` come from the DOCUMENT, not from columns, so
 * what a caller gets back is exactly what `prepareBatch` produced — including
 * the original JSON types. The columns exist to be filtered and ordered on.
 */
function toRow(dbRow) {
  const observation = deepFreeze(dbRow.observation);
  return Object.freeze({
    observationId: dbRow.observation_id,
    observationType: dbRow.observation_type,
    source: Object.freeze({ id: dbRow.source_id, feed: dbRow.source_feed }),
    sourceRecordId: observation.sourceRecordId,
    observedAt: observation.observedAt,
    // KNOWLEDGE TIME as supplied, read back as exact integer milliseconds.
    ingestedAt: Number(dbRow.ingested_at_ms),
    recordKey: dbRow.record_key,
    stateKey: dbRow.state_key,
    candidateKeys: Object.freeze(dbRow.candidate_keys ?? []),
    observation,
  });
}

/** Accumulate WHERE fragments with bound parameters. Never interpolates values. */
function conditions() {
  const params = [];
  const clauses = [];
  return {
    params,
    where: () => (clauses.length ? clauses.join(' AND ') : 'TRUE'),
    /** Add `fragment`, substituting `$n` for each supplied value in order. */
    add(fragment, ...values) {
      let next = fragment;
      for (const value of values) {
        params.push(value);
        next = next.replace('?', `$${params.length}`);
      }
      clauses.push(next);
    },
    /** The shared window and knowledge filters, identical in every query. */
    window({ from, to, knowledgeTime }) {
      if (from !== null && from !== undefined) this.add('observed_at >= ?::timestamptz', toTimestamp(from));
      if (to !== null && to !== undefined) this.add('observed_at < ?::timestamptz', toTimestamp(to));
      if (knowledgeTime !== null && knowledgeTime !== undefined) {
        this.add('ingested_at <= ?::timestamptz', toTimestamp(knowledgeTime));
      }
    },
    /** Source filters, preserving "absent = no filter" and "null = no feed". */
    source({ sourceId, feed }) {
      if (sourceId !== undefined) this.add('source_id = ?', sourceId);
      if (feed === null) this.add('source_feed IS NULL');
      else if (feed !== undefined) this.add('source_feed = ?', feed);
    },
  };
}

/**
 * Create a PostgreSQL-backed Evidence Store.
 *
 * @param {object} options - Options.
 * @param {import('pg').Pool} options.pool - Pool owned by the caller.
 * @param {string} options.schema - Schema holding the evidence table.
 * @returns {object} A store with the same surface as the memory reference.
 */
export function createPostgresObservationStore({ pool, schema }) {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('createPostgresObservationStore requires a pg Pool');
  }
  const table = qualifiedTable(schema);

  /** Run one statement, distinguishing infrastructure failure from a bug. */
  async function run(text, params = [], executor = pool) {
    try {
      return await executor.query(text, params);
    } catch (error) {
      if (isInfrastructureError(error)) {
        throw new EvidenceStoreUnavailable(
          `evidence store is unavailable (${error.code})`,
          { cause: error, code: error.code },
        );
      }
      throw error;
    }
  }

  /** Read rows and rebuild them as canonical stored rows. */
  async function select(sql, params) {
    const { rows } = await run(sql, params);
    return rows.map(toRow);
  }

  /**
   * Insert a batch. Atomic, and idempotent per observation id.
   *
   * `prepareBatch` runs FIRST and completely: validation, JSON checking, key and
   * token derivation. Nothing touches PostgreSQL unless the whole batch is
   * acceptable, so a rejected batch cannot half-land.
   *
   * `ON CONFLICT DO NOTHING` — never `DO UPDATE`, and never a LEAST()/MIN()
   * rewrite of `ingested_at`. A duplicate is a no-op, so first-known KNOWLEDGE
   * TIME survives re-delivery, which is the property every as-known query rests
   * on. Within-batch duplicates were already resolved by `prepareBatch`, first
   * occurrence winning, so the rows reaching SQL carry no repeated id.
   */
  async function insertBatch(batch) {
    const { rows, observationIds } = prepareBatch(batch);
    if (rows.length === 0) return { inserted: 0, duplicates: observationIds.length, observationIds };

    const payload = rows.map((row) => ({
      observationId: row.observationId,
      observationType: row.observationType,
      observedAt: toTimestamp(row.observedAt),
      ingestedAt: toTimestamp(row.ingestedAt),
      sourceId: row.source.id,
      sourceFeed: row.source.feed,
      recordKey: row.recordKey,
      stateKey: row.stateKey,
      candidateKeys: row.candidateKeys,
      observation: row.observation,
    }));

    const insert = `INSERT INTO ${table}
        (observation_id, observation_type, observed_at, ingested_at, source_id,
         source_feed, record_key, state_key, candidate_keys, observation)
      SELECT r->>'observationId',
             r->>'observationType',
             (r->>'observedAt')::timestamptz,
             (r->>'ingestedAt')::timestamptz,
             r->>'sourceId',
             r->>'sourceFeed',
             r->>'recordKey',
             r->>'stateKey',
             ARRAY(SELECT jsonb_array_elements_text(r->'candidateKeys')),
             r->'observation'
        FROM jsonb_array_elements($1::jsonb) AS t(r)
      ON CONFLICT (observation_id) DO NOTHING
      RETURNING observation_id`;

    const client = await (async () => {
      try {
        return await pool.connect();
      } catch (error) {
        throw new EvidenceStoreUnavailable(
          `evidence store is unavailable (${error?.code || 'connect failed'})`,
          { cause: error, code: error?.code },
        );
      }
    })();

    let inserted = 0;
    try {
      await run('BEGIN', [], client);
      for (let at = 0; at < payload.length; at += INSERT_CHUNK_ROWS) {
        const chunk = payload.slice(at, at + INSERT_CHUNK_ROWS);
        const result = await run(insert, [JSON.stringify(chunk)], client);
        inserted += result.rowCount ?? result.rows.length;
      }
      await run('COMMIT', [], client);
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The transaction is already lost; the original error is what matters.
      }
      throw error;
    } finally {
      client.release();
    }

    return { inserted, duplicates: observationIds.length - inserted, observationIds };
  }

  /** Every observation whose EVENT TIME falls in `[from, to)`. */
  async function observationsBetween(query = {}) {
    const { observationType, from, to, knowledgeTime, sourceId, feed } = prepareObservationsBetweenQuery(query);
    const q = conditions();
    if (observationType !== undefined) q.add('observation_type = ?', observationType);
    q.window({ from, to, knowledgeTime });
    q.source({ sourceId, feed });

    // No revision collapse: this is the raw evidence window.
    const rows = await select(`SELECT ${READ_COLUMNS} FROM ${table} WHERE ${q.where()}`, q.params);
    return rows.sort(byEventTime);
  }

  /**
   * What was in force at `eventTime`, one row per record.
   *
   * `DISTINCT ON (record_key)` with this ORDER BY is exactly the committed
   * two-step selection: within each record the first row is the greatest visible
   * EVENT TIME, and within that state the greatest KNOWLEDGE TIME, then the
   * greatest id. The knowledge filter sits in WHERE, so it applies BEFORE the
   * state is chosen — filtering afterwards would drop the record entirely rather
   * than fall back to the state that was known.
   */
  async function statesAt(query = {}) {
    const { observationType, eventTime, knowledgeTime, sourceId, feed } = prepareStatesAtQuery(query);
    const q = conditions();
    q.add('observation_type = ?', observationType);
    q.add('record_key IS NOT NULL');
    q.add('observed_at <= ?::timestamptz', toTimestamp(eventTime));
    q.window({ knowledgeTime });
    q.source({ sourceId, feed });

    const rows = await select(
      `SELECT DISTINCT ON (record_key) ${READ_COLUMNS}
         FROM ${table} WHERE ${q.where()}
        ORDER BY record_key, observed_at DESC, ingested_at DESC, observation_id DESC`,
      q.params,
    );
    return rows.sort((a, b) => compareText(a.recordKey, b.recordKey));
  }

  /** The ordered STATES one source holds about one record, revisions resolved. */
  async function recordHistory(selector, window = {}) {
    const { recordKey, from, to, knowledgeTime } = prepareRecordHistoryQuery(selector, window);
    const q = conditions();
    q.add('record_key = ?', recordKey);
    q.window({ from, to, knowledgeTime });

    const rows = await select(`SELECT ${READ_COLUMNS} FROM ${table} WHERE ${q.where()}`, q.params);
    return collapseRevisions(rows).sort(byEventTime);
  }

  /** Every version of ONE assertion about ONE instant, oldest known first. */
  async function revisionsOf(selector, options = {}) {
    const { stateKey, knowledgeTime } = prepareRevisionsOfQuery(selector, options);
    const q = conditions();
    q.add('state_key = ?', stateKey);
    q.window({ knowledgeTime });

    const rows = await select(`SELECT ${READ_COLUMNS} FROM ${table} WHERE ${q.where()}`, q.params);
    return rows.sort(byKnowledge);
  }

  /**
   * Candidate-key matching, across sources.
   *
   * `candidate_keys && $tokens` is exact token overlap. The tokens were
   * canonicalised in shared JavaScript on both sides — writing and querying — so
   * `'01361'` matches a stored `noradId=1361` without SQL knowing anything about
   * zero padding, and namespace and value can never be confused for each other.
   */
  async function matchTokens(tokens, { observationType, from, to, knowledgeTime }) {
    if (tokens.length === 0) return EMPTY_ENTITY_HISTORY;

    const q = conditions();
    q.add('candidate_keys && ?::text[]', tokens);
    if (observationType !== undefined) q.add('observation_type = ?', observationType);
    q.window({ from, to, knowledgeTime });

    const rows = await select(`SELECT ${READ_COLUMNS} FROM ${table} WHERE ${q.where()}`, q.params);

    // Revision collapse, ordering and the envelope all come from shared code, so
    // unkeyed rows cannot be collapsed together and `matchedOn` is built once.
    const wanted = new Set(tokens);
    return assembleEntityHistory(
      rows.map((row) => ({ row, matchedOn: row.candidateKeys.filter((token) => wanted.has(token)) })),
    );
  }

  /** Everything matching a candidate key, ACROSS sources. */
  async function entityHistory(query = {}) {
    const { tokens, observationType, from, to, knowledgeTime } = prepareEntityHistoryQuery(query);
    return matchTokens(tokens, { observationType, from, to, knowledgeTime });
  }

  /**
   * Choose the element set to propagate a satellite at `eventTime`.
   *
   * Knowledge horizon and revision collapse happen first, in the same candidate
   * match every other query uses; epoch selection is the only step that reads
   * `mode`, and it happens in shared code. No position is computed, and no
   * geometry exists to compute one from.
   */
  async function elementSetFor(query = {}) {
    const { tokens, eventTime, mode, knowledgeTime } = prepareElementSetQuery(query);
    const { observations } = await matchTokens(tokens, {
      observationType: 'space.orbital_elements',
      knowledgeTime,
    });
    return buildElementSetResult(observations, { eventTime, mode });
  }

  /** One stored row by id, or null when no such evidence is held. */
  async function get(observationId) {
    const rows = await select(
      `SELECT ${READ_COLUMNS} FROM ${table} WHERE observation_id = $1`,
      [assertObservationId(observationId)],
    );
    return rows[0] ?? null;
  }

  /** Number of distinct observations held. */
  async function size() {
    const { rows } = await run(`SELECT count(*)::bigint AS total FROM ${table}`);
    return Number(rows[0].total);
  }

  return Object.freeze({
    insertBatch,
    observationsBetween,
    statesAt,
    recordHistory,
    revisionsOf,
    entityHistory,
    elementSetFor,
    get,
    size,
    /** The schema this store reads and writes. Test and diagnostic support. */
    schema: qualifiedTable(schema),
  });
}

export { INSERT_CHUNK_ROWS };
