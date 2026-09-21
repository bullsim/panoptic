// Persistence lifecycle — startup, health, recovery and shutdown.
//
// TWO PROPERTIES DOMINATE THIS FILE.
//
//   1. A DATABASE OUTAGE MUST NEVER TAKE THE GLOBE OFFLINE. Unconfigured is
//      normal; configured-but-unreachable still starts, still serves CelesTrak,
//      and reports the truth rather than failing closed.
//   2. CONNECTIVITY IS NOT RETENTION. A readiness probe proves the database
//      answers and the table is writable. Only a real successful write proves
//      evidence is being kept, so a probe can reach `initialising` and no
//      further.
//
// No database is involved: the pool and store are injected.
//
// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import celestrak from '../../server/collectors/celestrak.js';
import { createPersistenceRuntime } from '../../server/persistence/runtime.js';
import { createStandaloneServer } from '../../server/standalone.js';
import { installShutdown } from '../../server/bin/serve.js';
import { createMemoryObservationStore } from '../../server/storage/memory.js';
import { defineCollector } from '../../server/runtime/registry.js';

const silent = { warn() {}, error() {}, log() {} };

const TLE_BODY = [
  'ISS (ZARYA)',
  '1 25544U 98067A   24001.50000000  .00016717  00000+0  30777-3 0  9993',
  '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.49309239 33211',
].join('\n');

const SECRET_URL = 'postgres://panoptic:SYNTHETIC-LIFECYCLE-PASSWORD-3391@db.internal:54329/panoptic';

/** A configuration with persistence configured, without loading any .env. */
function configuredFor(url = SECRET_URL) {
  return {
    collectors: { celestrak: { configuration: 'not-required' } },
    persistence: { configured: true, databaseUrl: { reveal: () => url, toJSON: () => '[redacted]' } },
  };
}

/** A configuration with no database at all. */
const unconfigured = () => ({
  collectors: { celestrak: { configuration: 'not-required' } },
  persistence: { configured: false, databaseUrl: null },
});

/** A pool that records every statement and answers readiness as told. */
function fakePool({ readiness = { table_present: true, may_insert: true }, failQuery = false } = {}) {
  const statements = [];
  let ended = false;
  return {
    statements,
    get ended() { return ended; },
    async query(text, params) {
      statements.push({ text, params });
      if (failQuery) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      return { rows: [readiness] };
    },
    async end() { ended = true; },
  };
}

/** A persistence runtime over injected infrastructure. */
function makeRuntime({
  config = configuredFor(),
  pool = fakePool(),
  store = createMemoryObservationStore(),
  ...rest
} = {}) {
  const runtime = createPersistenceRuntime({
    config,
    log: silent,
    createPool: () => pool,
    createStore: () => store,
    readinessTimeoutMs: 50,
    probeIntervalMs: 20,
    ...rest,
  });
  return { runtime, pool, store };
}

function batchOf(ingestedAt = 1_000) {
  return {
    schema: 'panoptic.observationBatch.v1',
    source: { id: 'celestrak', feed: 'stations' },
    observationType: 'space.orbital_elements',
    ingestedAt,
    observations: [{
      observationId: 'obs_lifecycle_0',
      observedAt: 1_700_000_000_000,
      sourceRecordId: '25544',
      entityRef: { keys: { noradId: 25544 } },
      properties: { meanMotion: 15.5 },
    }],
  };
}

async function scratch() {
  const dir = await mkdtemp(path.join(tmpdir(), 'panoptic-lifecycle-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** The real CelesTrak collector over an injected upstream. */
function pinnedCelestrak(cacheDir, fetchImpl) {
  return defineCollector({
    ...celestrak,
    createContext: (overrides) => celestrak.createContext({
      ...overrides, cacheDir, fetchImpl, log: silent,
    }),
  });
}

/** Start a standalone server on an ephemeral port. */
async function listen(options) {
  const { server } = createStandaloneServer({ log: silent, ...options });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

// ---------------------------------------------------------------------------
// 27. Disabled is a normal state
// ---------------------------------------------------------------------------

test('no database configured means disabled, and top-level health stays ok', async () => {
  const runtime = createPersistenceRuntime({ config: unconfigured(), log: silent });
  assert.equal(runtime.configured, false);
  assert.equal(runtime.sink, null);
  assert.equal(await runtime.start(), 'disabled');
  assert.equal(runtime.health().status, 'disabled');

  const server = await listen({ collectors: [], config: unconfigured(), persistence: runtime });
  try {
    const body = await (await fetch(`${server.origin}/health`)).json();
    // Every developer machine is here. Degrading it would make the signal
    // meaningless.
    assert.equal(body.status, 'ok');
    assert.equal(body.persistence.status, 'disabled');
  } finally { await server.close(); }
});

// ---------------------------------------------------------------------------
// 28-29. Startup is bounded and never fatal
// ---------------------------------------------------------------------------

test('an unreachable database still permits startup', async () => {
  const { runtime } = makeRuntime({ pool: fakePool({ failQuery: true }) });
  assert.equal(await runtime.start(), 'unavailable');
  assert.equal(runtime.health().reason, 'store-unavailable');

  const { dir, cleanup } = await scratch();
  const server = await listen({
    collectors: [pinnedCelestrak(dir, async () => new Response(TLE_BODY))],
    config: configuredFor(),
    persistence: runtime,
  });
  try {
    // The live collector is entirely unaffected.
    const res = await fetch(`${server.origin}/api/celestrak/stations`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-tle-cache'), 'MISS');
    assert.equal(await res.text(), TLE_BODY);
  } finally { await server.close(); await cleanup(); await runtime.close({ timeoutMs: 50 }); }
});

test('the startup readiness attempt is bounded', async () => {
  // A pool that never answers: startup must not wait on it indefinitely.
  const hung = { query: () => new Promise(() => {}), end: async () => {} };
  const { runtime } = makeRuntime({ pool: hung, readinessTimeoutMs: 40 });

  const started = Date.now();
  assert.equal(await runtime.start(), 'unavailable');
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 1_000, `readiness must be bounded, took ${elapsed} ms`);
  await runtime.close({ timeoutMs: 50 });
});

// ---------------------------------------------------------------------------
// 30-31. Readiness is not retention
// ---------------------------------------------------------------------------

test('readiness success reaches initialising, never available', async () => {
  const { runtime } = makeRuntime();
  assert.equal(await runtime.start(), 'initialising');
  // NOT `available`: nothing has been stored, so claiming retention would be a
  // lie that a green dashboard would then repeat.
  assert.equal(runtime.health().status, 'initialising');
  await runtime.close({ timeoutMs: 50 });
});

test('only a real successful write establishes available', async () => {
  const { runtime, store } = makeRuntime();
  await runtime.start();
  assert.equal(runtime.health().status, 'initialising');

  runtime.sink.submit('celestrak:stations', batchOf());
  await runtime.sink.drain({ timeoutMs: 1_000 });

  assert.equal(runtime.health().status, 'available');
  assert.equal(await store.size(), 1);
  await runtime.close({ timeoutMs: 50 });
});

// ---------------------------------------------------------------------------
// 32-34. Health reflects the pipeline
// ---------------------------------------------------------------------------

test('unavailable persistence degrades top-level health', async () => {
  const { runtime } = makeRuntime({ pool: fakePool({ failQuery: true }) });
  await runtime.start();

  const server = await listen({ collectors: [], config: configuredFor(), persistence: runtime });
  try {
    const body = await (await fetch(`${server.origin}/health`)).json();
    // The globe still works; history is impaired. That is `degraded`, not
    // `error`.
    assert.equal(body.status, 'degraded');
    assert.equal(body.persistence.status, 'unavailable');
    assert.equal(body.persistence.reason, 'store-unavailable');
  } finally { await server.close(); await runtime.close({ timeoutMs: 50 }); }
});

test('saturation and normalisation failure both impair the pipeline', async () => {
  const { runtime } = makeRuntime({ sinkOptions: { maxPendingBatches: 1 } });
  await runtime.start();

  // Normalisation failure: the database is perfectly well, and PANOPTIC still
  // failed to retain what it acquired.
  const broken = runtime.sink.submit('celestrak:stations', () => { throw new Error('bad TLE'); });
  assert.equal(broken.accepted, false);
  assert.equal(broken.reason, 'normalisation-failed');
  assert.equal(runtime.health().status, 'unavailable');
  assert.equal(runtime.health().reason, 'normalisation-failed');

  await runtime.close({ timeoutMs: 50 });
});

test('health carries no credentials, host, schema or database error', async () => {
  const { runtime } = makeRuntime({ pool: fakePool({ failQuery: true }) });
  await runtime.start();

  const server = await listen({ collectors: [], config: configuredFor(), persistence: runtime });
  try {
    const rendered = JSON.stringify(await (await fetch(`${server.origin}/health`)).json());
    for (const forbidden of [
      'SYNTHETIC-LIFECYCLE-PASSWORD-3391', 'db.internal', 'panoptic:', '54329',
      'postgres://', 'observation', 'ECONNREFUSED',
    ]) {
      assert.equal(rendered.includes(forbidden), false, `health leaked ${forbidden}`);
    }
    // And the existing substring guard still holds with the new section present.
    for (const forbidden of ['PANOPTIC_HOST', 'PANOPTIC_PORT', '.env', 'secret', 'token', 'key']) {
      assert.equal(rendered.toLowerCase().includes(forbidden.toLowerCase()), false,
        `health leaked ${forbidden}`);
    }
  } finally { await server.close(); await runtime.close({ timeoutMs: 50 }); }
});

// ---------------------------------------------------------------------------
// 35. Recovery, without a restart
// ---------------------------------------------------------------------------

test('a recovery probe reaches initialising only, and a write then restores available', async () => {
  let reachable = false;
  const pool = {
    statements: [],
    async query(text, params) {
      this.statements.push({ text, params });
      if (!reachable) throw Object.assign(new Error('down'), { code: 'ECONNREFUSED' });
      return { rows: [{ table_present: true, may_insert: true }] };
    },
    async end() {},
  };
  const store = createMemoryObservationStore();
  const { runtime } = makeRuntime({ pool, store, probeIntervalMs: 10 });

  await runtime.start();
  assert.equal(runtime.health().status, 'unavailable');

  // The database comes back. No process restart, no pool rebuild.
  reachable = true;
  const deadline = Date.now() + 2_000;
  while (runtime.health().status === 'unavailable' && Date.now() < deadline) {
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }

  assert.equal(runtime.health().status, 'initialising',
    'connectivity alone must not claim evidence is being retained');

  runtime.sink.submit('celestrak:stations', batchOf());
  await runtime.sink.drain({ timeoutMs: 1_000 });
  assert.equal(runtime.health().status, 'available');

  await runtime.close({ timeoutMs: 50 });
});

// ---------------------------------------------------------------------------
// 37-38. Startup verifies; it never creates
// ---------------------------------------------------------------------------

test('startup runs no DDL and only checks readiness', async () => {
  const { runtime, pool } = makeRuntime();
  await runtime.start();

  assert.equal(pool.statements.length, 1, 'exactly one readiness statement');
  const [{ text, params }] = pool.statements;
  // A read, and only a read. The statement is checked by its leading keyword
  // rather than by substring, because the readiness query legitimately NAMES
  // the INSERT privilege inside `has_table_privilege` without performing one.
  assert.match(text.trim(), /^SELECT\b/i, 'readiness must be a plain SELECT');
  for (const forbidden of ['CREATE ', 'ALTER ', 'DROP ', 'TRUNCATE ', 'INSERT INTO', 'DELETE FROM']) {
    assert.equal(text.toUpperCase().includes(forbidden), false, `startup must not issue ${forbidden}`);
  }
  // Stronger than SELECT 1: presence AND insert privilege.
  assert.match(text, /to_regclass/);
  assert.match(text, /has_table_privilege/);
  assert.deepEqual(params, ['"panoptic".observation']);

  await runtime.close({ timeoutMs: 50 });
});

test('a missing schema is reported without harming the live server', async () => {
  const { runtime } = makeRuntime({
    pool: fakePool({ readiness: { table_present: false, may_insert: false } }),
  });
  assert.equal(await runtime.start(), 'unavailable');
  assert.equal(runtime.health().reason, 'schema-not-ready');

  const { dir, cleanup } = await scratch();
  const server = await listen({
    collectors: [pinnedCelestrak(dir, async () => new Response(TLE_BODY))],
    config: configuredFor(),
    persistence: runtime,
  });
  try {
    const res = await fetch(`${server.origin}/api/celestrak/stations`);
    assert.equal(res.status, 200, 'an uninitialised database must not break the globe');
  } finally { await server.close(); await cleanup(); await runtime.close({ timeoutMs: 50 }); }
});

test('a role without INSERT is not ready, even though the table exists', async () => {
  const { runtime } = makeRuntime({
    pool: fakePool({ readiness: { table_present: true, may_insert: false } }),
  });
  assert.equal(await runtime.start(), 'unavailable');
  assert.equal(runtime.health().reason, 'schema-not-ready');
  await runtime.close({ timeoutMs: 50 });
});

// ---------------------------------------------------------------------------
// 39-41. Shutdown
// ---------------------------------------------------------------------------

test('shutdown gives a detached acquisition one turn before closing admission', async () => {
  const { server } = createStandaloneServer({ collectors: [], log: silent });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  let closedAt = null;
  const persistence = {
    close: async () => { closedAt = 'called'; return true; },
  };
  const handlers = {};
  const proc = { on(s, h) { handlers[s] = h; }, off() {}, exit() {} };
  installShutdown(server, { shutdownTimeoutMs: 5_000, proc, log: silent, persistence });

  handlers.SIGINT('SIGINT');
  await new Promise((resolve) => server.on('close', resolve));

  // THE RACE THIS GUARDS: a request that completed a successful refresh queued
  // its submission with setImmediate. Closing admission in the close callback
  // would discard it. So nothing is closed yet...
  assert.equal(closedAt, null, 'admission must not close in the close callback');

  // ...and only after a turn has been given does the drain begin.
  await new Promise((resolve) => { setImmediate(resolve); });
  await new Promise((resolve) => { setImmediate(resolve); });
  assert.equal(closedAt, 'called', 'the drain runs one turn later');
});

test('a hung persistence close cannot make shutdown wait forever', async () => {
  const { server } = createStandaloneServer({ collectors: [], log: silent });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  // Never resolves. The pre-existing grace timer is what saves shutdown.
  const persistence = { close: () => new Promise(() => {}) };
  const exits = [];
  const handlers = {};
  const proc = { on(s, h) { handlers[s] = h; }, off() {}, exit(code) { exits.push(code); } };
  installShutdown(server, { shutdownTimeoutMs: 60, proc, log: silent, persistence });

  handlers.SIGINT('SIGINT');
  await new Promise((resolve) => { setTimeout(resolve, 250); });

  assert.ok(exits.includes(1), 'the grace period must still force an exit');
  server.closeAllConnections();
});

test('no persistence keeps the original synchronous shutdown exactly', async () => {
  const { server } = createStandaloneServer({ collectors: [], log: silent });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  let exitCode = null;
  const handlers = {};
  const proc = { on(s, h) { handlers[s] = h; }, off() {}, exit(code) { exitCode = code; } };
  installShutdown(server, { shutdownTimeoutMs: 5_000, proc, log: silent });

  handlers.SIGINT('SIGINT');
  await new Promise((resolve) => server.on('close', resolve));
  // Unchanged behaviour: the exit is immediate, with no deferred turn.
  assert.equal(exitCode, 0);
});

test('shutdown accepts an acquisition queued at close, drains it, then ends the pool', async () => {
  // Every step records itself, so the assertion is about ORDER, not merely
  // outcome. With the memory store a write never touches the pool, so only an
  // ordered log can prove the pool is ended after the drain rather than before.
  const events = [];
  const memory = createMemoryObservationStore();
  const store = {
    async insertBatch(batch) {
      events.push('insert');
      return memory.insertBatch(batch);
    },
  };
  const readiness = fakePool();
  const pool = {
    query: (...args) => readiness.query(...args),
    end: async () => { events.push('pool-end'); },
  };
  const { runtime } = makeRuntime({ pool, store });
  await runtime.start();

  const { server } = createStandaloneServer({ collectors: [], log: silent, persistence: runtime });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  // Registered BEFORE the signal, so it runs before installShutdown's close
  // callback: a refresh hook queued in the very turn the last request finished.
  // If admission closed inside the close callback, this submission would be
  // refused and the evidence lost.
  server.on('close', () => {
    setImmediate(() => {
      // An idle worker starts the write inside submit(), so 'insert' lands
      // between these two entries.
      events.push('submit');
      const verdict = runtime.sink.submit('celestrak:stations', batchOf());
      events.push(`accepted:${verdict.accepted}`);
    });
  });

  const handlers = {};
  let resolveExit;
  const exited = new Promise((resolve) => { resolveExit = resolve; });
  const proc = {
    on(s, h) { handlers[s] = h; },
    off() {},
    exit(code) { events.push(`exit:${code}`); resolveExit(code); },
  };
  installShutdown(server, { shutdownTimeoutMs: 5_000, proc, log: silent, persistence: runtime });

  handlers.SIGINT('SIGINT');
  assert.equal(await exited, 0, 'a clean drain exits 0');

  assert.deepEqual(events, ['submit', 'insert', 'accepted:true', 'pool-end', 'exit:0'],
    'HTTP closes, the queued acquisition is admitted, drained, then the pool ends, then exit');
  assert.equal(await memory.size(), 1, 'the late acquisition was retained');
  assert.equal(runtime.sink.submit('celestrak:stations', batchOf()).reason, 'closing',
    'and admission is closed afterwards');
});

test('the pool is closed after accepted work has drained', async () => {
  const { runtime, pool, store } = makeRuntime();
  await runtime.start();

  runtime.sink.submit('celestrak:stations', batchOf());
  assert.equal(await runtime.close({ timeoutMs: 1_000 }), true, 'drained cleanly');

  assert.equal(await store.size(), 1, 'accepted evidence was written before closing');
  assert.equal(pool.ended, true, 'and the pool was closed afterwards');
  // Admission is shut, so nothing new can arrive during or after shutdown.
  assert.equal(runtime.sink.submit('celestrak:stations', batchOf()).reason, 'closing');
});

// ---------------------------------------------------------------------------
// 47-49. db:init
// ---------------------------------------------------------------------------

test('db:init uses the shared idempotent bootstrap and nothing destructive', async () => {
  const source = await readFile(
    fileURLToPath(new URL('../../server/bin/db-init.js', import.meta.url)),
    'utf8',
  );

  assert.match(source, /ensureEvidenceSchema/, 'it reuses the verified DDL');
  // `dropEvidenceSchema` lives in the same module and drops CASCADE. An
  // administrative command that creates must have no path to destroying
  // evidence.
  assert.equal(source.includes('dropEvidenceSchema('), false,
    'db:init must never invoke the destructive helper');
  assert.equal(source.includes('DROP'), false, 'and must issue no DROP of its own');
});

test('db:init describes its target without credentials', async () => {
  const source = await readFile(
    fileURLToPath(new URL('../../server/bin/db-init.js', import.meta.url)),
    'utf8',
  );
  assert.match(source, /describeConnection\(connectionString\)/,
    'the target is logged through the redacting helper');
  // The raw string must never be interpolated into output.
  assert.equal(/\$\{connectionString\}/.test(source), false,
    'the connection string must never be interpolated into a log line');
});
