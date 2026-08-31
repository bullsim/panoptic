// CelesTrak collector — the first backend responsibility moved out of
// vite.config.js into server/. These tests pin the behaviour that migration had
// to preserve exactly: the route contract, the x-tle-cache values, the 6 h TTL,
// serve-stale on upstream failure, single-flight refresh, and the
// .gev-cache/celestrak-<group>.json disk layout.
//
// Lives under src/data/ to match the existing proxy-test convention
// (cctvProxy.test.mjs, overpassProxy.test.mjs, radioProxy.test.mjs, …), which is
// also what `npm test` discovers — the runner walks src/ only.
//
// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import collector from '../../server/collectors/celestrak.js';

const TLE_BODY = [
  'ISS (ZARYA)',
  '1 25544U 98067A   24001.50000000  .00016717  00000+0  30777-3 0  9993',
  '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.49309239 33211',
].join('\n');

const SIX_HOURS_MS = 6 * 3600_000;

function fakeRes() {
  return {
    headersSent: false,
    status: 0,
    headers: null,
    body: undefined,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
    },
    end(body) { this.body = body; },
  };
}

/** Build a context over a throwaway cache directory. */
async function harness({ fetchImpl, now = () => 1_000_000 } = {}) {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'panoptic-celestrak-'));
  const ctx = collector.createContext({
    cacheDir,
    now,
    log: { warn() {} },
    fetchImpl: fetchImpl || (async () => new Response(TLE_BODY, { status: 200 })),
  });
  return { ctx, cacheDir, cleanup: () => rm(cacheDir, { recursive: true, force: true }) };
}

const get = (ctx, url = '/stations') => {
  const res = fakeRes();
  return collector.handler({ url }, res, ctx).then(() => res);
};

test('collector contract matches the plugin it replaced', () => {
  assert.equal(collector.id, 'celestrak');
  assert.equal(collector.route, '/api/celestrak');
  // The removed plugin registered configureServer only. Widening this is a
  // deliberate future change, never a side effect of the extraction.
  assert.deepEqual([...collector.surfaces], ['dev']);
});

test('a malformed group is rejected without consulting the cache', async () => {
  const { ctx, cleanup } = await harness({
    fetchImpl: async () => assert.fail('upstream must not be reached'),
  });
  try {
    const res = await get(ctx, '/../etc/passwd');
    assert.equal(res.status, 400);
    assert.equal(res.body, 'invalid group');
    // As before: the reject path carries no x-tle-cache header.
    assert.equal(res.headers['x-tle-cache'], undefined);
    assert.equal(res.headers['Content-Type'], 'text/plain');
  } finally { await cleanup(); }
});

test('a cold group fetches upstream and reports MISS', async () => {
  let requested = null;
  const { ctx, cacheDir, cleanup } = await harness({
    fetchImpl: async (url, options) => {
      requested = { url, options };
      return new Response(TLE_BODY, { status: 200 });
    },
  });
  try {
    const res = await get(ctx);
    assert.equal(res.status, 200);
    assert.equal(res.body, TLE_BODY);
    assert.equal(res.headers['x-tle-cache'], 'MISS');

    const upstream = new URL(requested.url);
    assert.equal(upstream.origin + upstream.pathname, 'https://celestrak.org/NORAD/elements/gp.php');
    assert.equal(upstream.searchParams.get('GROUP'), 'stations');
    assert.equal(upstream.searchParams.get('FORMAT'), 'tle');
    // CelesTrak 403s bulk groups without a descriptive contact User-Agent.
    assert.match(requested.options.headers['User-Agent'], /^gods-eye-view-celestrak-proxy\/1\.0 \(\+http/);
    assert.ok(requested.options.signal instanceof AbortSignal);

    // Disk layout is unchanged from the vite.config.js implementation.
    const onDisk = JSON.parse(await readFile(path.join(cacheDir, 'celestrak-stations.json'), 'utf8'));
    assert.equal(onDisk.body, TLE_BODY);
    assert.equal(onDisk.at, 1_000_000);
  } finally { await cleanup(); }
});

test('a warm group is served from cache as HIT until the 6 h TTL expires', async () => {
  let calls = 0;
  let clock = 1_000_000;
  const { ctx, cleanup } = await harness({
    now: () => clock,
    fetchImpl: async () => { calls += 1; return new Response(TLE_BODY, { status: 200 }); },
  });
  try {
    assert.equal((await get(ctx)).headers['x-tle-cache'], 'MISS');

    clock += SIX_HOURS_MS - 1;
    const warm = await get(ctx);
    assert.equal(warm.headers['x-tle-cache'], 'HIT');
    assert.equal(warm.body, TLE_BODY);
    assert.equal(calls, 1, 'inside the TTL nothing should reach upstream');

    clock += 1; // exactly at the TTL boundary — no longer fresh
    assert.equal((await get(ctx)).headers['x-tle-cache'], 'MISS');
    assert.equal(calls, 2);
  } finally { await cleanup(); }
});

test('a stale entry is served when upstream fails', async () => {
  let failing = false;
  const { ctx, cleanup } = await harness({
    now: () => (failing ? 1_000_000 + SIX_HOURS_MS + 1 : 1_000_000),
    fetchImpl: async () => {
      if (failing) return new Response('upstream exploded', { status: 503 });
      return new Response(TLE_BODY, { status: 200 });
    },
  });
  try {
    assert.equal((await get(ctx)).headers['x-tle-cache'], 'MISS');
    failing = true;
    const stale = await get(ctx);
    assert.equal(stale.status, 200, 'a stale TLE beats an empty satellites layer');
    assert.equal(stale.body, TLE_BODY);
    assert.equal(stale.headers['x-tle-cache'], 'STALE-ERROR');
  } finally { await cleanup(); }
});

test('an upstream failure with no cache at all is a 502 NONE', async () => {
  const { ctx, cleanup } = await harness({
    fetchImpl: async () => new Response('nope', { status: 500 }),
  });
  try {
    const res = await get(ctx);
    assert.equal(res.status, 502);
    assert.equal(res.body, 'celestrak fetch failed and no cache available');
    assert.equal(res.headers['x-tle-cache'], 'NONE');
  } finally { await cleanup(); }
});

test('an upstream error page with no TLE lines is treated as a failure', async () => {
  const { ctx, cleanup } = await harness({
    fetchImpl: async () => new Response('<html>rate limited</html>', { status: 200 }),
  });
  try {
    const res = await get(ctx);
    assert.equal(res.status, 502, 'a 200 carrying zero TLEs must not be cached as success');
    assert.equal(res.headers['x-tle-cache'], 'NONE');
  } finally { await cleanup(); }
});

test('a warm disk cache survives a process restart', async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'panoptic-celestrak-'));
  try {
    await writeFile(
      path.join(cacheDir, 'celestrak-stations.json'),
      JSON.stringify({ at: 1_000_000, body: TLE_BODY }),
      'utf8',
    );
    // A brand-new context — empty memory tier, as after a dev-server restart.
    const ctx = collector.createContext({
      cacheDir,
      now: () => 1_000_100,
      log: { warn() {} },
      fetchImpl: async () => assert.fail('a fresh disk entry must not hit upstream'),
    });
    const res = await get(ctx);
    assert.equal(res.status, 200);
    assert.equal(res.headers['x-tle-cache'], 'HIT');
    assert.equal(res.body, TLE_BODY);
  } finally { await rm(cacheDir, { recursive: true, force: true }); }
});

test('a corrupt disk entry is ignored rather than served', async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'panoptic-celestrak-'));
  try {
    await writeFile(path.join(cacheDir, 'celestrak-stations.json'), '{ not json', 'utf8');
    const ctx = collector.createContext({
      cacheDir,
      now: () => 1_000_000,
      log: { warn() {} },
      fetchImpl: async () => new Response(TLE_BODY, { status: 200 }),
    });
    const res = await get(ctx);
    assert.equal(res.headers['x-tle-cache'], 'MISS');
    assert.equal(res.body, TLE_BODY);
  } finally { await rm(cacheDir, { recursive: true, force: true }); }
});

test('concurrent requests for one group coalesce into a single upstream fetch', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const { ctx, cleanup } = await harness({
    fetchImpl: async () => {
      calls += 1;
      await gate;
      return new Response(TLE_BODY, { status: 200 });
    },
  });
  try {
    const inflight = [get(ctx), get(ctx), get(ctx)];
    release();
    const results = await Promise.all(inflight);
    assert.equal(calls, 1, 'single-flight must collapse concurrent callers');
    for (const res of results) {
      assert.equal(res.status, 200);
      assert.equal(res.headers['x-tle-cache'], 'MISS');
    }
  } finally { await cleanup(); }
});

test('distinct groups are cached independently', async () => {
  const seen = [];
  const { ctx, cleanup } = await harness({
    fetchImpl: async (url) => {
      const group = new URL(url).searchParams.get('GROUP');
      seen.push(group);
      return new Response(`${TLE_BODY}\n# ${group}`, { status: 200 });
    },
  });
  try {
    await get(ctx, '/stations');
    await get(ctx, '/active');
    const repeat = await get(ctx, '/stations');
    assert.deepEqual(seen, ['stations', 'active']);
    assert.equal(repeat.headers['x-tle-cache'], 'HIT');
    assert.match(repeat.body, /# stations$/);
  } finally { await cleanup(); }
});

test('a query string is stripped from the group', async () => {
  const seen = [];
  const { ctx, cleanup } = await harness({
    fetchImpl: async (url) => {
      seen.push(new URL(url).searchParams.get('GROUP'));
      return new Response(TLE_BODY, { status: 200 });
    },
  });
  try {
    const res = await get(ctx, '/stations?t=123');
    assert.equal(res.status, 200);
    assert.deepEqual(seen, ['stations']);
  } finally { await cleanup(); }
});
