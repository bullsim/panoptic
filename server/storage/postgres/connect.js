/**
 * PostgreSQL connection helpers for the Evidence Store.
 *
 * Small on purpose. The store itself takes an injected pool and never owns
 * process-wide lifecycle, so this module exists to make the two things easy to
 * get wrong impossible to forget: attaching a pool error listener, and keeping
 * credentials out of logs and error messages.
 *
 * @module server/storage/postgres/connect
 */

import pg from 'pg';

/**
 * A genuine infrastructure failure: the database could not be reached, or it
 * went away mid-query.
 *
 * Deliberately NOT used for validation errors, semantic errors, or constraint
 * violations. A CHECK that fires or a missing table is an adapter or schema bug,
 * and dressing it as "unavailable" would send an operator to look at the network
 * while the real fault sat in the code.
 *
 * Lives in the adapter rather than in `contract.js` because it describes a
 * PostgreSQL condition; the reference store is never unavailable, so the shared
 * contract has nothing to say about it.
 */
export class EvidenceStoreUnavailable extends Error {
  /**
   * @param {string} message - What failed, with no credentials in it.
   * @param {{cause?: unknown, code?: string}} [options] - Underlying error.
   */
  constructor(message, { cause, code } = {}) {
    super(message, { cause });
    this.name = 'EvidenceStoreUnavailable';
    this.code = code;
  }
}

/**
 * PostgreSQL SQLSTATE classes that mean "the server, not your SQL".
 *
 *   08xxx  connection exception
 *   53300  too many connections
 *   57014  query cancelled (statement timeout)
 *   57P01  admin shutdown
 *   57P02  crash shutdown
 *   57P03  cannot connect now (starting up)
 */
const UNAVAILABLE_SQLSTATE = new Set(['53300', '57014', '57P01', '57P02', '57P03']);

/** Node socket errors that mean the database was not reachable. */
const UNAVAILABLE_SYSCALL = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE',
]);

/**
 * Whether an error is infrastructure rather than a bug in the query.
 *
 * @param {unknown} error - Thrown error.
 * @returns {boolean} True when the database was unreachable or went away.
 */
export function isInfrastructureError(error) {
  const code = error?.code;
  if (typeof code !== 'string') return false;
  return UNAVAILABLE_SYSCALL.has(code) || code.startsWith('08') || UNAVAILABLE_SQLSTATE.has(code);
}

/**
 * Describe a connection without revealing anything secret.
 *
 * Host, port and database only. Never the password, never the user, never the
 * raw URL — connection strings end up in logs and exception reports, and a
 * password that reaches either is a leaked password.
 *
 * @param {string} connectionString - A postgres:// URL.
 * @returns {string} e.g. `postgres://127.0.0.1:54329/panoptic_test`
 */
export function describeConnection(connectionString) {
  try {
    const url = new URL(connectionString);
    const database = url.pathname.replace(/^\//, '') || '(none)';
    return `${url.protocol}//${url.hostname}:${url.port || '5432'}/${database}`;
  } catch {
    return '(unparseable connection string)';
  }
}

/**
 * Read the database name out of a connection string.
 *
 * @param {string} connectionString - A postgres:// URL.
 * @returns {string|null} Database name, or null when it cannot be read.
 */
export function databaseNameOf(connectionString) {
  try {
    return new URL(connectionString).pathname.replace(/^\//, '') || null;
  } catch {
    return null;
  }
}

/**
 * Create a configured pool.
 *
 * THE ERROR LISTENER IS NOT OPTIONAL. When an idle client's connection dies,
 * `pg` emits `'error'` on the pool; with no listener Node treats it as an
 * unhandled error event and terminates the process. In Slice C that would mean a
 * database hiccup taking down the live collector server — persistence must never
 * be able to do that, so the listener is attached here rather than left to each
 * caller to remember.
 *
 * @param {string} connectionString - A postgres:// URL.
 * @param {object} [options] - Overrides.
 * @param {number} [options.max] - Maximum pooled clients.
 * @param {(message: string, error: Error) => void} [options.onError] - Idle-client error sink.
 * @returns {import('pg').Pool} Configured pool.
 */
export function createEvidencePool(connectionString, { max = 4, onError } = {}) {
  if (typeof connectionString !== 'string' || connectionString === '') {
    throw new TypeError('a PostgreSQL connection string is required');
  }

  const pool = new pg.Pool({
    connectionString,
    max,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 10_000,
    statement_timeout: 30_000,
    idle_in_transaction_session_timeout: 30_000,
    application_name: 'panoptic-evidence',
  });

  const target = describeConnection(connectionString);
  pool.on('error', (error) => {
    // Redacted by construction: `target` carries no credentials.
    const message = `[panoptic] evidence pool client error (${target}): ${error?.code || error?.message || error}`;
    if (onError) onError(message, error);
    else console.error(message);
  });

  return pool;
}
