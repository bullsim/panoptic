// CelesTrak persistence wiring — the acquisition boundary.
//
// THE CLAIM UNDER TEST: evidence is persisted exactly once per genuinely
// successful upstream refresh, and at no other time. Not per HTTP request, not
// on a cache hit, not when a stale copy is served, and exactly once when several
// concurrent callers coalesce onto a single refresh.
//
// The second claim is that persistence cannot reach the live response: a hook
// that throws, a hook that rejects, and a hook that has not run yet must all
// leave the CelesTrak HTTP contract byte-for-byte unchanged.
//
// No test here touches celestrak.org or a database — upstream is injected and
// the store is in-memory.
//
// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import celestrak, { toObservations } from '../../server/collectors/celestrak.js';
import { createRuntime } from '../../server/runtime/registry.js';
import { createObservationSink, createPipelineState } from '../../server/persistence/sink.js';
import { createMemoryObservationStore } from '../../server/storage/memory.js';

const silent = { warn() {}, error() {}, log() {} };

const TLE_BODY = [
  'ISS (ZARYA)',
  '1 25544U 98067A   24001.50000000  .00016717  00000+0  30777-3 0  9993',
  '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.49309239 33211',
  'CSS (TIANHE)',
  '1 48274U 21035A   24001.50000000  .00021929  00000+0  24923-3 0  9990',
  '2 48274  41.4713 112.5372 0006670 322.4462  37.5885 15.61399888 12345',
].join('\n');

/** The acquisition clock. Deliberately not the clock anything else uses. */
const ACQUIRED_AT = 1_700_000_000_000;

async function scratch() {
  const dir = await mkdtemp(path.join(tmpdir(), 'panoptic-persist-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function fakeRes() {
  return {
    headersSent: false,
    status: 0,
    headers: null,
    body: undefined,
    writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; },
    end(body) { this.body = body; },
  };
}

/**
 * Let the detached refresh hook run.
 *
 * The hook is deliberately queued with `setImmediate`, so a test that checked
 * immediately after the response would see nothing. Two turns covers the hook
 * plus any microtask it queues.
 */
async function settle() {
  await new Promise((resolve) => { setImmediate(resolve); });
  await new Promise((resolve) => { setImmediate(resolve); });
}

/** A sink that records what it was offered, without a store behind it. */
function trackingSink({ onSubmit } = {}) {
  const submissions = [];
  return {
    submissions,
    submit(label, batchOrProduce) {
      if (onSubmit) return onSubmit(label, batchOrProduce);
      let batch;
      try {
        batch = typeof batchOrProduce === 'function' ? batchOrProduce() : batchOrProduce;
      } catch (error) {
        submissions.push({ label, error });
        return { accepted: false, reason: 'normalisation-failed', queueDepth: 0, observations: 0 };
      }
      submissions.push({ label, batch });
      return { accepted: true, reason: null, queueDepth: 0, observations: batch.observations.length };
    },
  };
}

/** A CelesTrak runtime over an injected upstream, optionally with a sink. */
function makeRuntime({ cacheDir, fetchImpl, sink = null, now = () => ACQUIRED_AT }) {
  const collector = {
    ...celestrak,
    createContext: (overrides) => celestrak.createContext({
      ...overrides, cacheDir, fetchImpl, now, log: silent,
    }),
  };
  return createRuntime([collector], { sink });
}

/** One request through the runtime, returning the response. */
async function request(runtime, url) {
  const res = fakeRes();
  await runtime.dispatch({ url }, res, 'standalone');
  return res;
}

const okUpstream = async () => new Response(TLE_BODY, { status: 200 });
const failingUpstream = async () => { throw new Error('upstream down'); };

// ---------------------------------------------------------------------------
// 14. One successful refresh, one submission
// ---------------------------------------------------------------------------

test('a successful refresh persists exactly one batch for that group', async () => {
  const { dir, cleanup } = await scratch();
  const sink = trackingSink();
  try {
    const res = await request(makeRuntime({ cacheDir: dir, fetchImpl: okUpstream, sink }),
      '/api/celestrak/stations');
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-tle-cache'], 'MISS');

    await settle();
    assert.equal(sink.submissions.length, 1);

    const { label, batch } = sink.submissions[0];
    assert.equal(label, 'celestrak:stations');
    assert.equal(batch.schema, 'panoptic.observationBatch.v1');
    assert.equal(batch.observationType, 'space.orbital_elements');
    // Each group is its own feed, so `stations` and `active` never share a
    // record key.
    assert.deepEqual(batch.source, { id: 'celestrak', feed: 'stations' });
    assert.equal(batch.observations.length, 2);
  } finally { await cleanup(); }
});

test('two groups persist as two independent feeds', async () => {
  const { dir, cleanup } = await scratch();
  const sink = trackingSink();
  try {
    const runtime = makeRuntime({ cacheDir: dir, fetchImpl: okUpstream, sink });
    await request(runtime, '/api/celestrak/stations');
    await request(runtime, '/api/celestrak/active');
    await settle();

    assert.deepEqual(sink.submissions.map((s) => s.label),
      ['celestrak:stations', 'celestrak:active']);
    assert.deepEqual(sink.submissions.map((s) => s.batch.source.feed), ['stations', 'active']);
  } finally { await cleanup(); }
});

// ---------------------------------------------------------------------------
// 15. Coalesced requests submit once
// ---------------------------------------------------------------------------

test('concurrent cold requests coalesce onto one refresh and one submission', async () => {
  const { dir, cleanup } = await scratch();
  const sink = trackingSink();
  let upstreamCalls = 0;
  const held = (() => {
    let release;
    const promise = new Promise((resolve) => { release = resolve; });
    return { promise, release: () => release() };
  })();
  try {
    const runtime = makeRuntime({
      cacheDir: dir,
      sink,
      fetchImpl: async () => {
        upstreamCalls += 1;
        await held.promise;
        return new Response(TLE_BODY, { status: 200 });
      },
    });

    // All three must reach the coalescing point before upstream answers, so the
    // gate is held until every one of them is past the cache read.
    const inFlight = [
      request(runtime, '/api/celestrak/active'),
      request(runtime, '/api/celestrak/active'),
      request(runtime, '/api/celestrak/active'),
    ];
    await new Promise((resolve) => { setTimeout(resolve, 25); });
    held.release();
    const responses = await Promise.all(inFlight);
    await settle();

    for (const res of responses) assert.equal(res.status, 200);
    assert.equal(upstreamCalls, 1, 'single-flight: one upstream fetch');
    // This is the structural property, not a de-duplication step: the success
    // path of a coalesced refresh runs exactly once.
    assert.equal(sink.submissions.length, 1, 'three callers, one submission');
  } finally { await cleanup(); }
});

// ---------------------------------------------------------------------------
// 16-20. Everything that must NOT persist
// ---------------------------------------------------------------------------

test('a cache HIT persists nothing', async () => {
  const { dir, cleanup } = await scratch();
  const sink = trackingSink();
  try {
    const runtime = makeRuntime({ cacheDir: dir, fetchImpl: okUpstream, sink });
    const cold = await request(runtime, '/api/celestrak/stations');
    await settle();
    const warm = await request(runtime, '/api/celestrak/stations');
    await settle();

    assert.equal(cold.headers['x-tle-cache'], 'MISS');
    assert.equal(warm.headers['x-tle-cache'], 'HIT');
    assert.equal(sink.submissions.length, 1, 'no new evidence was acquired');
  } finally { await cleanup(); }
});

test('a STALE-ERROR serve persists nothing', async () => {
  const { dir, cleanup } = await scratch();
  const sink = trackingSink();
  try {
    let clock = ACQUIRED_AT;
    let upstream = okUpstream;
    const runtime = makeRuntime({
      cacheDir: dir,
      sink,
      now: () => clock,
      fetchImpl: (...args) => upstream(...args),
    });

    await request(runtime, '/api/celestrak/stations');
    await settle();
    assert.equal(sink.submissions.length, 1);

    // Past the TTL, with upstream now down: the stale copy is served, and
    // nothing new was acquired.
    clock += 7 * 3600_000;
    upstream = failingUpstream;
    const stale = await request(runtime, '/api/celestrak/stations');
    await settle();

    assert.equal(stale.status, 200);
    assert.equal(stale.headers['x-tle-cache'], 'STALE-ERROR');
    assert.equal(sink.submissions.length, 1, 'a stale serve is not an acquisition');
  } finally { await cleanup(); }
});

test('a failed refresh with no cache persists nothing', async () => {
  const { dir, cleanup } = await scratch();
  const sink = trackingSink();
  try {
    const res = await request(
      makeRuntime({ cacheDir: dir, fetchImpl: failingUpstream, sink }),
      '/api/celestrak/stations',
    );
    await settle();

    assert.equal(res.status, 502);
    assert.equal(res.headers['x-tle-cache'], 'NONE');
    assert.equal(sink.submissions.length, 0);
  } finally { await cleanup(); }
});

test('an invalid group persists nothing', async () => {
  const { dir, cleanup } = await scratch();
  const sink = trackingSink();
  try {
    const res = await request(
      makeRuntime({ cacheDir: dir, fetchImpl: okUpstream, sink }),
      '/api/celestrak/not!valid',
    );
    await settle();

    assert.equal(res.status, 400);
    assert.equal(sink.submissions.length, 0);
  } finally { await cleanup(); }
});

test('promoting an entry from the disk cache persists nothing', async () => {
  const { dir, cleanup } = await scratch();
  try {
    // A previous process left a fresh entry on disk.
    await writeFile(
      path.join(dir, 'celestrak-stations.json'),
      JSON.stringify({ at: ACQUIRED_AT, body: TLE_BODY }),
      'utf8',
    );

    const sink = trackingSink();
    const res = await request(
      makeRuntime({ cacheDir: dir, fetchImpl: okUpstream, sink }),
      '/api/celestrak/stations',
    );
    await settle();

    assert.equal(res.status, 200);
    assert.equal(res.headers['x-tle-cache'], 'HIT');
    // Reading a cached body is not acquiring evidence. This is the accepted C1
    // limitation: a restart does not backfill what was never persisted.
    assert.equal(sink.submissions.length, 0);
  } finally { await cleanup(); }
});

// ---------------------------------------------------------------------------
// 21-23. Persistence cannot reach the live response
// ---------------------------------------------------------------------------

test('a hook that throws synchronously cannot poison the refresh', async () => {
  const { dir, cleanup } = await scratch();
  try {
    const sink = trackingSink({
      onSubmit: () => { throw new Error('sink exploded'); },
    });
    const runtime = makeRuntime({ cacheDir: dir, fetchImpl: okUpstream, sink });

    const res = await request(runtime, '/api/celestrak/stations');
    await settle();

    // The refresh succeeded, the cache was written, and the response is exactly
    // what it would have been with no persistence at all.
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-tle-cache'], 'MISS');
    assert.equal(res.body, TLE_BODY);

    // And the cache is intact: the next request is a HIT.
    const warm = await request(runtime, '/api/celestrak/stations');
    assert.equal(warm.headers['x-tle-cache'], 'HIT');
    const onDisk = JSON.parse(await readFile(path.join(dir, 'celestrak-stations.json'), 'utf8'));
    assert.equal(onDisk.body, TLE_BODY);
  } finally { await cleanup(); }
});

test('a hook that returns a rejected promise cannot poison the refresh', async () => {
  const { dir, cleanup } = await scratch();
  const rejections = [];
  const onRejection = (err) => rejections.push(err);
  process.on('unhandledRejection', onRejection);
  try {
    const sink = trackingSink({
      onSubmit: () => Promise.reject(new Error('async sink failure')),
    });
    const runtime = makeRuntime({ cacheDir: dir, fetchImpl: okUpstream, sink });

    const res = await request(runtime, '/api/celestrak/stations');
    await settle();
    await settle();

    assert.equal(res.status, 200);
    assert.equal(res.headers['x-tle-cache'], 'MISS');
    assert.deepEqual(rejections, [], 'a rejected hook must never escape as unhandled');
  } finally {
    process.off('unhandledRejection', onRejection);
    await cleanup();
  }
});

test('the HTTP response completes before persistence is even attempted', async () => {
  const { dir, cleanup } = await scratch();
  const sink = trackingSink();
  try {
    const runtime = makeRuntime({ cacheDir: dir, fetchImpl: okUpstream, sink });
    const res = await request(runtime, '/api/celestrak/stations');

    // The response is fully written and NOTHING has been submitted yet — the
    // hook is still queued. This is the ordering guarantee, not a timing hope.
    assert.equal(res.status, 200);
    assert.equal(res.body, TLE_BODY);
    assert.equal(sink.submissions.length, 0, 'HTTP did not wait for persistence');

    await settle();
    assert.equal(sink.submissions.length, 1, 'and persistence happens afterwards');
  } finally { await cleanup(); }
});

// ---------------------------------------------------------------------------
// 24-25. KNOWLEDGE TIME
// ---------------------------------------------------------------------------

test('KNOWLEDGE TIME is the acquisition timestamp, not the write time', async () => {
  const { dir, cleanup } = await scratch();
  try {
    const store = createMemoryObservationStore();
    const state = createPipelineState({ now: () => 5_555, log: silent });
    state.set('initialising');
    // The sink's clock is deliberately far from the acquisition clock. If
    // KNOWLEDGE TIME were ever taken from a write, this is where it would show.
    const sink = createObservationSink({ store, state, log: silent });

    const runtime = makeRuntime({ cacheDir: dir, fetchImpl: okUpstream, sink, now: () => ACQUIRED_AT });
    await request(runtime, '/api/celestrak/stations');
    await settle();
    await sink.drain({ timeoutMs: 1_000 });

    assert.equal(await store.size(), 2);
    const expected = toObservations({ at: ACQUIRED_AT, body: TLE_BODY }, { feed: 'stations' });
    for (const observation of expected.observations) {
      const row = await store.get(observation.observationId);
      assert.ok(row, `${observation.observationId} must be stored`);
      assert.equal(row.ingestedAt, ACQUIRED_AT,
        'KNOWLEDGE TIME is when the upstream body was received');
    }
  } finally { await cleanup(); }
});

test('re-delivering the same evidence cannot move its KNOWLEDGE TIME', async () => {
  const store = createMemoryObservationStore();
  const state = createPipelineState({ log: silent });
  state.set('initialising');
  const sink = createObservationSink({ store, state, log: silent });

  // The same upstream body, acquired twice at different times.
  const first = toObservations({ at: ACQUIRED_AT, body: TLE_BODY }, { feed: 'stations' });
  const later = toObservations({ at: ACQUIRED_AT + 86_400_000, body: TLE_BODY }, { feed: 'stations' });

  sink.submit('celestrak:stations', first);
  await sink.drain({ timeoutMs: 1_000 });
  sink.submit('celestrak:stations', later);
  await sink.drain({ timeoutMs: 1_000 });

  assert.equal(await store.size(), 2, 'identical evidence inserts once');
  for (const observation of first.observations) {
    const row = await store.get(observation.observationId);
    assert.equal(row.ingestedAt, ACQUIRED_AT, 'first-known KNOWLEDGE TIME survives');
  }
});

// ---------------------------------------------------------------------------
// 26. The Vite compatibility runtime never persists
// ---------------------------------------------------------------------------

test('a runtime built without a sink refreshes normally and writes nothing', async () => {
  const { dir, cleanup } = await scratch();
  try {
    // This is exactly how server/index.js builds its runtimes.
    const runtime = makeRuntime({ cacheDir: dir, fetchImpl: okUpstream });
    const res = await request(runtime, '/api/celestrak/stations');
    await settle();

    assert.equal(res.status, 200);
    assert.equal(res.headers['x-tle-cache'], 'MISS');
    assert.equal(res.body, TLE_BODY);
  } finally { await cleanup(); }
});

test('the Vite compatibility host never constructs a persistence sink', async () => {
  // Structural, because the failure it guards against is a SECOND writer: a
  // Vite dev server and the standalone server sharing .gev-cache would
  // otherwise both persist the same refresh.
  const source = await readFile(
    fileURLToPath(new URL('../../server/index.js', import.meta.url)),
    'utf8',
  );
  assert.equal(source.includes('sink'), false,
    'server/index.js must not pass a sink to createRuntime');
  assert.match(source, /createRuntime\(COLLECTORS\)/,
    'its runtimes are built with collectors only');
});
