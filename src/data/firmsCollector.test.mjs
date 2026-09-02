// NASA FIRMS collector — migrated out of vite.config.js into server/.
//
// These tests pin the contract that migration had to preserve byte-for-byte:
// both routes, every status code, the keyless bodies, Cache-Control, the 30 min
// TTL, sequential source fetching, partial-success semantics, serve-stale, the
// serve-time trailing-24 h re-filter, and the .gev-cache/firms.json disk path.
//
// They also pin what changed on purpose: the key is now a secret() box supplied
// through ctx.config, revealed only where the NASA URL is built, and must never
// reach a log, an error, a response, or /health.
//
// NO TEST CALLS NASA — every upstream is injected.
//
// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import firms from '../../server/collectors/firms.js';
import { secret } from '../../server/config/index.js';
import { filterTrailing24h, parseFirmsCsv } from './firmsCsv.js';

/** A synthetic key, distinctive enough to find anywhere it might leak. */
const SYNTHETIC_KEY = 'SYNTHETIC-FIRMS-KEY-zzz999-do-not-leak';

const TTL_MS = 30 * 60_000;
const SOURCES = ['VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'VIIRS_SNPP_NRT'];

/** FIRMS CSV with one detection, stamped `minutesAgo` before `now`. */
function csvAt(nowMs, minutesAgo = 5, lat = 10.5, lon = 20.25) {
  const when = new Date(nowMs - minutesAgo * 60_000);
  const acqDate = when.toISOString().slice(0, 10);
  const acqTime = `${String(when.getUTCHours()).padStart(2, '0')}${String(when.getUTCMinutes()).padStart(2, '0')}`;
  return [
    'country_id,latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight',
    `USA,${lat},${lon},330.1,0.4,0.36,${acqDate},${acqTime},N,VIIRS,n,2.0NRT,290.2,5.5,D`,
  ].join('\n');
}

/** Capture every argument passed to the logger, for leak assertions. */
function recordingLog() {
  const lines = [];
  const push = (...args) => lines.push(args.map((a) => (a instanceof Error ? `${a.message}|${a.stack}` : String(a))).join(' '));
  return { lines, warn: push, error: push, log: push };
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
 * Build a collector context over a throwaway cache dir.
 * `key: null` models an absent FIRMS_MAP_KEY.
 */
async function harness({
  key = SYNTHETIC_KEY,
  fetchImpl,
  now = () => Date.parse('2026-09-02T12:00:00Z'),
  cacheDir = null,
} = {}) {
  const dir = cacheDir || await mkdtemp(path.join(tmpdir(), 'panoptic-firms-'));
  const log = recordingLog();
  const ctx = firms.createContext({
    cacheDir: dir,
    now,
    log,
    config: {
      configuration: key ? 'configured' : 'missing',
      mapKey: key ? secret(key) : null,
    },
    fetchImpl: fetchImpl || (async () => new Response(csvAt(now()), { status: 200 })),
  });
  return { ctx, dir, log, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const get = (ctx, url = '/') => {
  const res = fakeRes();
  return firms.handler({ url }, res, ctx).then(() => res);
};

const body = (res) => JSON.parse(res.body);

// ---------------------------------------------------------------------------
// Contract: routes, surfaces
// ---------------------------------------------------------------------------

test('collector contract matches the plugin it replaced', () => {
  assert.equal(firms.id, 'firms');
  assert.equal(firms.route, '/api/firms');
  // Exactly one host executes this route; Vite proxies to it.
  assert.ok(firms.surfaces.includes('standalone'));
  assert.ok(!firms.surfaces.includes('dev'), 'Vite must proxy FIRMS, never execute it');
  assert.ok(!firms.surfaces.includes('preview'), 'FIRMS has never been served on preview');
});

// ---------------------------------------------------------------------------
// Keyed happy path
// ---------------------------------------------------------------------------

test('a keyed request fetches all three sources and returns the documented payload', async () => {
  const requested = [];
  const now = Date.parse('2026-09-02T12:00:00Z');
  const { ctx, cleanup } = await harness({
    now: () => now,
    fetchImpl: async (url, options) => {
      requested.push({ url, options });
      return new Response(csvAt(now), { status: 200 });
    },
  });
  try {
    const res = await get(ctx);
    assert.equal(res.status, 200);
    assert.equal(res.headers['Content-Type'], 'application/json');
    assert.equal(res.headers['Cache-Control'], 'no-store', 'Cache-Control must survive the migration');

    const payload = body(res);
    assert.deepEqual(Object.keys(payload), ['fetchedAt', 'stale', 'ttlMs', 'sources', 'count', 'fires']);
    assert.equal(payload.fetchedAt, now);
    assert.equal(payload.stale, false);
    assert.equal(payload.ttlMs, TTL_MS);
    assert.equal(payload.count, 3, 'one detection per source');
    assert.equal(payload.fires.length, 3);
    assert.deepEqual(payload.sources.map((s) => s.source), SOURCES);
    assert.ok(payload.sources.every((s) => s.ok === true && s.count === 1));
  } finally { await cleanup(); }
});

test('the three VIIRS sources are fetched sequentially, in order, with world/2 and a timeout', async () => {
  const order = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const now = Date.parse('2026-09-02T12:00:00Z');
  const { ctx, cleanup } = await harness({
    now: () => now,
    fetchImpl: async (url, options) => {
      concurrent += 1;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      order.push(url);
      assert.ok(options.signal instanceof AbortSignal, 'every upstream call must carry a timeout');
      await new Promise((resolve) => setImmediate(resolve));
      concurrent -= 1;
      return new Response(csvAt(now), { status: 200 });
    },
  });
  try {
    await get(ctx);
    assert.equal(maxConcurrent, 1, 'quota courtesy: never fetch sources in parallel');
    assert.equal(order.length, 3);
    for (const [i, source] of SOURCES.entries()) {
      assert.ok(order[i].includes(`/${source}/world/2`), `source ${i} must be ${source} with world/2`);
      assert.ok(order[i].startsWith('https://firms.modaps.eosdis.nasa.gov/api/area/csv/'));
    }
  } finally { await cleanup(); }
});

test('partial source success still succeeds, marking the failed sources', async () => {
  const now = Date.parse('2026-09-02T12:00:00Z');
  let call = 0;
  const { ctx, cleanup } = await harness({
    now: () => now,
    fetchImpl: async () => {
      call += 1;
      if (call === 1) return new Response(csvAt(now), { status: 200 });
      if (call === 2) return new Response('upstream down', { status: 503 });
      return new Response('<html>not csv</html>', { status: 200 });
    },
  });
  try {
    const res = await get(ctx);
    assert.equal(res.status, 200, 'one good source is still a success');
    const payload = body(res);
    assert.deepEqual(payload.sources.map((s) => s.ok), [true, false, false]);
    assert.deepEqual(payload.sources.map((s) => s.count), [1, 0, 0]);
    assert.equal(payload.count, 1);
  } finally { await cleanup(); }
});

test('a non-CSV body is a source failure, not silently cached', async () => {
  const { ctx, cleanup } = await harness({
    fetchImpl: async () => new Response('<html>rate limited</html>', { status: 200 }),
  });
  try {
    const res = await get(ctx);
    assert.equal(res.status, 502, 'all sources non-CSV and no cache → the legacy 502');
    assert.deepEqual(body(res), { error: 'firms fetch failed and no cache available' });
  } finally { await cleanup(); }
});

// ---------------------------------------------------------------------------
// Keyless contract — byte-for-byte
// ---------------------------------------------------------------------------

test('keyless /api/firms is exactly 503 {"error":"no_key"} and never touches upstream', async () => {
  const { ctx, cleanup } = await harness({
    key: null,
    fetchImpl: async () => assert.fail('upstream must never be reached without a key'),
  });
  try {
    const res = await get(ctx);
    assert.equal(res.status, 503);
    assert.equal(res.body, '{"error":"no_key"}', 'the body the browser layer matches on, byte for byte');
    assert.equal(res.headers['Cache-Control'], 'no-store');
  } finally { await cleanup(); }
});

test('keyless /api/firms/status is exactly 200 with the documented field set', async () => {
  const { ctx, cleanup } = await harness({
    key: null,
    fetchImpl: async () => assert.fail('upstream must never be reached without a key'),
  });
  try {
    const res = await get(ctx, '/status');
    // 200 on purpose: this is a capability probe, and QA reads hasKey from it.
    assert.equal(res.status, 200);
    assert.deepEqual(body(res), {
      hasKey: false,
      lastFetch: null,
      count: null,
      stale: false,
      ttlMs: 1_800_000,
      transactions: null,
    });
  } finally { await cleanup(); }
});

// ---------------------------------------------------------------------------
// /status when keyed
// ---------------------------------------------------------------------------

test('keyed /api/firms/status reports cache state and transaction telemetry', async () => {
  const now = Date.parse('2026-09-02T12:00:00Z');
  let statusCalls = 0;
  const { ctx, cleanup } = await harness({
    now: () => now,
    fetchImpl: async (url) => {
      if (url.includes('mapkey_status')) {
        statusCalls += 1;
        return new Response(JSON.stringify({ current_transactions: 42, transaction_limit: 5000 }), { status: 200 });
      }
      return new Response(csvAt(now), { status: 200 });
    },
  });
  try {
    const cold = body(await get(ctx, '/status'));
    assert.equal(cold.hasKey, true);
    assert.equal(cold.lastFetch, null, 'nothing fetched yet');
    assert.equal(cold.count, null);
    assert.equal(cold.stale, false);
    assert.equal(cold.ttlMs, TTL_MS);
    assert.deepEqual(cold.transactions, { used: 42, limit: 5000 });

    await get(ctx); // populate the cache
    const warm = body(await get(ctx, '/status'));
    assert.equal(warm.lastFetch, now);
    assert.equal(warm.count, 3);
    assert.equal(warm.stale, false);

    assert.equal(statusCalls, 1, 'the transaction memo must hold for 5 minutes');
  } finally { await cleanup(); }
});

test('a failed mapkey_status degrades to null without failing the request', async () => {
  const { ctx, cleanup } = await harness({
    fetchImpl: async (url) => (url.includes('mapkey_status')
      ? new Response('nope', { status: 500 })
      : new Response(csvAt(Date.now()), { status: 200 })),
  });
  try {
    const res = await get(ctx, '/status');
    assert.equal(res.status, 200);
    assert.equal(body(res).transactions, null);
  } finally { await cleanup(); }
});

test('transaction telemetry is never written to disk', async () => {
  const { ctx, dir, cleanup } = await harness({
    fetchImpl: async (url) => (url.includes('mapkey_status')
      ? new Response(JSON.stringify({ current_transactions: 7, transaction_limit: 5000 }), { status: 200 })
      : new Response(csvAt(Date.now()), { status: 200 })),
  });
  try {
    await get(ctx, '/status');
    await get(ctx);
    const files = await readdir(dir);
    assert.deepEqual(files, ['firms.json'], 'quota telemetry is live state — memory only');
    const onDisk = JSON.parse(await readFile(path.join(dir, 'firms.json'), 'utf8'));
    assert.deepEqual(Object.keys(onDisk).sort(), ['at', 'fires', 'sources']);
    assert.equal(JSON.stringify(onDisk).includes('transaction'), false);
  } finally { await cleanup(); }
});

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

test('MISS then HIT — a second request inside the TTL never reaches upstream', async () => {
  let calls = 0;
  let clock = Date.parse('2026-09-02T12:00:00Z');
  const { ctx, dir, cleanup } = await harness({
    now: () => clock,
    fetchImpl: async () => { calls += 1; return new Response(csvAt(clock), { status: 200 }); },
  });
  try {
    await get(ctx);
    assert.equal(calls, 3, 'one pass over three sources');

    clock += TTL_MS - 1;
    const warm = body(await get(ctx));
    assert.equal(warm.stale, false);
    assert.equal(calls, 3, 'inside the TTL nothing reaches upstream');

    clock += 1; // exactly at the boundary — no longer fresh
    await get(ctx);
    assert.equal(calls, 6);

    assert.deepEqual(await readdir(dir), ['firms.json'], 'the disk path is unchanged');
  } finally { await cleanup(); }
});

test('a stale cache is served when upstream fails', async () => {
  let failing = false;
  let clock = Date.parse('2026-09-02T12:00:00Z');
  const { ctx, cleanup } = await harness({
    now: () => clock,
    fetchImpl: async () => (failing
      ? new Response('down', { status: 503 })
      : new Response(csvAt(clock), { status: 200 })),
  });
  try {
    assert.equal(body(await get(ctx)).stale, false);
    failing = true;
    clock += TTL_MS + 1;

    const stale = await get(ctx);
    assert.equal(stale.status, 200, 'stale beats empty');
    assert.equal(body(stale).stale, true);
    assert.ok(body(stale).fires.length > 0);
  } finally { await cleanup(); }
});

test('upstream failure with no cache is the legacy 502', async () => {
  const { ctx, cleanup } = await harness({
    fetchImpl: async () => new Response('down', { status: 503 }),
  });
  try {
    const res = await get(ctx);
    assert.equal(res.status, 502);
    assert.deepEqual(body(res), { error: 'firms fetch failed and no cache available' });
    assert.equal(res.headers['Cache-Control'], 'no-store');
  } finally { await cleanup(); }
});

test('a warm disk cache survives a restart', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'panoptic-firms-'));
  const now = Date.parse('2026-09-02T12:00:00Z');
  try {
    const records = parseFirmsCsv(csvAt(now));
    await writeFile(
      path.join(dir, 'firms.json'),
      JSON.stringify({ at: now, sources: [{ source: SOURCES[0], count: 1, ok: true }], fires: records }),
      'utf8',
    );
    const { ctx, cleanup } = await harness({
      cacheDir: dir,
      now: () => now + 60_000,
      fetchImpl: async () => assert.fail('a fresh disk entry must not hit upstream'),
    });
    const res = await get(ctx);
    assert.equal(res.status, 200);
    assert.equal(body(res).fetchedAt, now);
    await cleanup();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// Parsing / filtering identical to the legacy path
// ---------------------------------------------------------------------------

test('serve-time re-filtering drops detections older than 24 h from a stale entry', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'panoptic-firms-'));
  const now = Date.parse('2026-09-02T12:00:00Z');
  try {
    // One recent detection and one 30 h old, both in the cached entry.
    const fires = [
      ...parseFirmsCsv(csvAt(now, 10)),
      ...parseFirmsCsv(csvAt(now, 30 * 60)),
    ];
    assert.equal(fires.length, 2, 'both parsed into the entry');
    await writeFile(
      path.join(dir, 'firms.json'),
      JSON.stringify({ at: now, sources: [{ source: SOURCES[0], count: 2, ok: true }], fires }),
      'utf8',
    );
    const { ctx, cleanup } = await harness({
      cacheDir: dir,
      now: () => now + 60_000,
      fetchImpl: async () => assert.fail('fresh entry'),
    });
    const payload = body(await get(ctx));
    assert.equal(payload.count, 1, 'the 30 h-old detection must not be served');
    assert.deepEqual(payload.fires, filterTrailing24h(fires, now + 60_000));
    await cleanup();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---------------------------------------------------------------------------
// The key never leaks
// ---------------------------------------------------------------------------

test('the FIRMS key never appears in logs, errors, or response bodies', async () => {
  const seenUrls = [];
  const { ctx, log, cleanup } = await harness({
    fetchImpl: async (url) => {
      seenUrls.push(url);
      // Every source fails, exercising the warn paths AND the 502 body.
      return new Response('down', { status: 500 });
    },
  });
  try {
    const feed = await get(ctx);
    const status = await get(ctx, '/status');

    // Sanity: the key really did reach the upstream URL, so absence elsewhere means something.
    assert.ok(seenUrls.some((u) => u.includes(encodeURIComponent(SYNTHETIC_KEY))), 'precondition');

    for (const rendering of [feed.body, status.body, JSON.stringify(feed.headers), JSON.stringify(status.headers)]) {
      assert.equal(String(rendering).includes(SYNTHETIC_KEY), false, 'no response may carry the key');
    }
    assert.ok(log.lines.length > 0, 'the failure paths did log');
    for (const line of log.lines) {
      assert.equal(line.includes(SYNTHETIC_KEY), false, `log line leaked the key: ${line}`);
      assert.equal(line.includes('firms.modaps.eosdis.nasa.gov'), false, 'no log may carry the secret-bearing URL');
    }
  } finally { await cleanup(); }
});

test('the config slice redacts the key under every rendering', async () => {
  const { ctx, cleanup } = await harness();
  try {
    for (const rendering of [
      String(ctx.config.mapKey),
      `${ctx.config.mapKey}`,
      JSON.stringify(ctx.config),
      JSON.stringify({ ctx: { config: ctx.config } }),
      inspect(ctx.config, { depth: 6 }),
    ]) {
      assert.equal(rendering.includes(SYNTHETIC_KEY), false, 'the boxed key must never render');
    }
    // Only a deliberate reveal() returns it — the two URL builders do that.
    assert.equal(ctx.config.mapKey.reveal(), SYNTHETIC_KEY);
  } finally { await cleanup(); }
});

test('the collector reads no configuration of its own', async () => {
  // Guards the ownership rule: config arrives through ctx, never process.env.
  const source = await readFile(new URL('../../server/collectors/firms.js', import.meta.url), 'utf8');
  // Deliberately strict: not even prose may mention it, so the rule cannot be
  // eroded by a comment that later becomes code.
  assert.equal(/process\.env/.test(source), false, 'the collector must not read process.env');
  // Exactly two reveal sites, both URL builders.
  const reveals = source.match(/\.reveal\(\)/g) || [];
  assert.equal(reveals.length, 2, 'the key may be unwrapped only in firmsCsvUrl and firmsStatusUrl');
});

test('an unexpected internal failure is the legacy 500, with no key in it', async () => {
  const { ctx, log, cleanup } = await harness();
  try {
    // Break the cache so the handler's own try/catch is what answers.
    const broken = { ...ctx, cache: { read: async () => { throw new Error(`boom ${SYNTHETIC_KEY}`); } } };
    const res = await get(broken);
    assert.equal(res.status, 500);
    assert.deepEqual(body(res), { error: 'firms proxy error' });
    assert.equal(res.body.includes(SYNTHETIC_KEY), false, 'the generic body must not echo the cause');
  } finally { await cleanup(); }
});
