/**
 * Persistence lifecycle — configuration in, a sink and an operational state out.
 *
 * Owns the things the sink deliberately does not: the pool, the store, the
 * readiness probe, and the answer to "is PANOPTIC actually retaining evidence".
 *
 * TWO PROPERTIES SHAPE THIS FILE.
 *
 * 1. A DATABASE OUTAGE MUST NOT TAKE THE GLOBE OFFLINE. Everything here is
 *    optional, bounded and non-fatal: unconfigured is a normal state, and
 *    configured-but-unreachable still starts, still serves, and still reports
 *    the truth.
 * 2. CONNECTIVITY IS NOT RETENTION. A probe proves the database answers and the
 *    table is writable. It does not prove a single observation was stored, so it
 *    can only ever reach `initialising` — `available` is earned by a real write.
 *
 * Normal startup NEVER runs DDL. The schema is created deliberately, by
 * `npm run db:init`, and verified here.
 *
 * @module server/persistence/runtime
 */

import { createEvidencePool } from '../storage/postgres/connect.js';
import { createPostgresObservationStore } from '../storage/postgres/store.js';
import { DEFAULT_DRAIN_TIMEOUT_MS, createObservationSink, createPipelineState } from './sink.js';

/** The production evidence schema. Fixed, not configurable. */
export const EVIDENCE_SCHEMA = 'panoptic';

/** Bound on the startup readiness attempt. An outage costs seconds, not startup. */
export const READINESS_TIMEOUT_MS = 3_000;

/** How often to re-probe while unavailable. No database traffic when healthy. */
export const PROBE_INTERVAL_MS = 30_000;

/**
 * Readiness: the table exists AND this role may insert into it.
 *
 * Stronger than `SELECT 1`, which proves only that something answered on the
 * socket — it would report a database with no schema, or a role that cannot
 * write, as ready. `CASE` guards the privilege check because
 * `has_table_privilege` raises on a table that does not exist.
 */
const READINESS_SQL = `
  SELECT to_regclass($1) IS NOT NULL AS table_present,
         CASE WHEN to_regclass($1) IS NULL THEN false
              ELSE has_table_privilege($1, 'INSERT') END AS may_insert`;

/** Resolve a promise, or a fallback once the bound expires. */
async function withTimeout(promise, timeoutMs, fallback) {
  let timer = null;
  const expiry = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, expiry]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the persistence runtime for a loaded configuration.
 *
 * The pool, store and sink are all constructed SYNCHRONOUSLY. `pg.Pool` does not
 * connect until its first query, so nothing here talks to a database before
 * `start()` — which is what lets a collector receive a working sink immediately,
 * with no deferred wiring.
 *
 * @param {object} options - Runtime options.
 * @param {object} options.config - Loaded PANOPTIC configuration.
 * @param {Pick<Console,'log'|'warn'|'error'>} [options.log] - Log sink.
 * @param {() => number} [options.now] - Clock, injectable for tests.
 * @param {string} [options.schema] - Evidence schema name.
 * @param {number} [options.readinessTimeoutMs] - Startup readiness bound.
 * @param {number} [options.probeIntervalMs] - Recovery probe interval.
 * @param {Function} [options.createPool] - Pool factory (injectable for tests).
 * @param {Function} [options.createStore] - Store factory (injectable for tests).
 * @param {object} [options.sinkOptions] - Extra sink options (bounds, clocks).
 * @returns {object} The persistence runtime.
 */
export function createPersistenceRuntime({
  config,
  log = console,
  now = () => Date.now(),
  schema = EVIDENCE_SCHEMA,
  readinessTimeoutMs = READINESS_TIMEOUT_MS,
  probeIntervalMs = PROBE_INTERVAL_MS,
  createPool = createEvidencePool,
  createStore = createPostgresObservationStore,
  sinkOptions = {},
} = {}) {
  const state = createPipelineState({ now, log });
  const configured = Boolean(config?.persistence?.configured);

  if (!configured) {
    state.set('disabled', null);
    return Object.freeze({
      configured: false,
      sink: null,
      health: () => state.snapshot(),
      start: async () => state.status,
      closeAdmission: () => {},
      drain: async () => true,
      close: async () => true,
    });
  }

  // The ONLY place the connection string is unwrapped.
  const connectionString = config.persistence.databaseUrl.reveal();
  const qualifiedTable = `"${schema}".observation`;

  const pool = createPool(connectionString, {
    onError: (message) => log.error?.(message),
  });
  const store = createStore({ pool, schema });
  const sink = createObservationSink({ store, state, log, ...sinkOptions });

  state.set('initialising', null);

  let probeTimer = null;

  /** One bounded readiness check. Never rejects. */
  async function probeOnce() {
    const query = pool.query(READINESS_SQL, [qualifiedTable])
      .then(({ rows }) => {
        const row = rows?.[0] ?? {};
        if (!row.table_present) return { ok: false, reason: 'schema-not-ready' };
        if (!row.may_insert) return { ok: false, reason: 'schema-not-ready' };
        return { ok: true, reason: null };
      })
      // The error may name a host or a role; only the classification travels.
      .catch(() => ({ ok: false, reason: 'store-unavailable' }));

    return withTimeout(query, readinessTimeoutMs, { ok: false, reason: 'store-unavailable' });
  }

  /**
   * Re-probe while, and only while, the pipeline is unavailable.
   *
   * The timer runs for the process's life but issues no query unless the state
   * is `unavailable`, so a healthy PANOPTIC generates no probe traffic at all.
   * It is unref'd, so it never holds the process open.
   */
  function startProbe() {
    if (probeTimer) return;
    probeTimer = setInterval(() => {
      if (state.status !== 'unavailable') return;
      probeOnce().then((ready) => {
        // Only a REAL successful write may claim `available`; readiness alone
        // returns the pipeline to `initialising` and no further.
        if (ready.ok && state.status === 'unavailable') state.set('initialising', null);
      });
    }, probeIntervalMs);
    probeTimer.unref?.();
  }

  function stopProbe() {
    if (!probeTimer) return;
    clearInterval(probeTimer);
    probeTimer = null;
  }

  return Object.freeze({
    configured: true,
    sink,

    /** A bounded, non-sensitive health fragment. */
    health: () => state.snapshot(),

    /**
     * Bounded readiness attempt. Resolves to the resulting state; never throws,
     * and never prevents the caller from listening.
     */
    async start() {
      const ready = await probeOnce();
      if (ready.ok) state.set('initialising', null);
      else state.set('unavailable', ready.reason);
      startProbe();
      return state.status;
    },

    closeAdmission: () => sink.closeAdmission(),
    drain: (options) => sink.drain(options),

    /** Stop probing, close admission, drain what was accepted, end the pool. */
    async close({ timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS } = {}) {
      stopProbe();
      sink.closeAdmission();
      const drained = await sink.drain({ timeoutMs });
      // A hung database must not hold shutdown open, so even the close is bounded.
      await withTimeout(pool.end().catch(() => {}), timeoutMs, undefined);
      return drained;
    },
  });
}
