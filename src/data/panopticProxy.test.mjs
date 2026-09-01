// Frontend → standalone PANOPTIC backend routing.
//
// The browser keeps calling relative /api/celestrak/... URLs; Vite proxies them
// to the standalone server instead of executing its own copy. The two claims
// that matter most here:
//
//   1. The old Vite-hosted CelesTrak implementation is NOT MOUNTED. Vite
//      registers plugin `configureServer` middlewares BEFORE server.proxy, so a
//      collector still on the 'dev' surface would silently answer every request
//      and the proxy would never fire — a failure that looks like success.
//   2. When the backend is down the browser gets an obvious 502, never a
//      fallback to a second implementation, because no second implementation
//      exists at runtime.
//
// The end-to-end tests drive a REAL Vite dev server in front of a REAL
// standalone server, with the CelesTrak upstream injected — nothing here
// touches celestrak.org.
//
// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import celestrak from '../../server/collectors/celestrak.js';
import { COLLECTORS, panopticProxy, proxyContextKey } from '../../server/index.js';
import { createStandaloneServer } from '../../server/standalone.js';
import { createRuntime, defineCollector } from '../../server/runtime/registry.js';
import { resolveBackendAddress } from '../../server/backendAddress.js';

const TLE_BODY = [
  'ISS (ZARYA)',
  '1 25544U 98067A   24001.50000000  .00016717  00000+0  30777-3 0  9993',
  '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.49309239 33211',
].join('\n');

const silent = { warn() {}, error() {}, log() {} };

/** Vite's own context-matching rule, from its proxy middleware. */
function contextMatches(context, url) {
  return (context[0] === '^' && new RegExp(context).test(url)) || url.startsWith(context);
}

/** The real CelesTrak collector with its context pinned to a test upstream. */
function pinnedCelestrak({ cacheDir, fetchImpl, now = () => 1_000_000 }) {
  return defineCollector({
    ...celestrak,
    createContext: () => celestrak.createContext({ cacheDir, fetchImpl, now, log: silent }),
  });
}

/**
 * Stand up: a temp Vite root, a standalone backend on an ephemeral port, and a
 * real Vite dev server proxying to it.
 */
async function stack({ fetchImpl, startBackend = true } = {}) {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'panoptic-proxy-cache-'));
  // realpath matters on Windows: os.tmpdir() hands back the 8.3 short form
  // (C:\Users\SIMONB~1\...), while Vite resolves the request through the long
  // path — the mismatch trips its fs allow-list with a 403.
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'panoptic-proxy-root-')));
  await writeFile(path.join(root, 'index.html'), '<!doctype html><title>panoptic</title><h1>SPA OK</h1>', 'utf8');

  let backend = null;
  let backendPort = 0;
  if (startBackend) {
    const upstream = fetchImpl || (async () => new Response(TLE_BODY, { status: 200 }));
    const { server } = createStandaloneServer({
      collectors: [pinnedCelestrak({ cacheDir, fetchImpl: upstream })],
      log: silent,
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    backendPort = server.address().port;
    backend = server;
  } else {
    // A port nothing is listening on, to model "backend not running".
    const probe = createStandaloneServer({ collectors: [], log: silent }).server;
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    backendPort = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));
  }

  const env = { PANOPTIC_HOST: '127.0.0.1', PANOPTIC_PORT: String(backendPort) };
  const vite = await createViteServer({
    configFile: false,
    root,
    logLevel: 'silent',
    server: { host: '127.0.0.1', port: 0, proxy: panopticProxy(env) },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  await vite.listen();
  const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;

  return {
    origin,
    backendPort,
    async close() {
      await vite.close();
      if (backend) await new Promise((resolve) => { backend.closeAllConnections(); backend.close(resolve); });
      await rm(cacheDir, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// Proxy configuration is derived from the registry
// ---------------------------------------------------------------------------

test('proxy entries are derived from the collector registry', () => {
  const entries = panopticProxy({ PANOPTIC_HOST: '127.0.0.1', PANOPTIC_PORT: '8787' });
  const expected = createRuntime(COLLECTORS).routes('standalone').map((r) => proxyContextKey(r.route));

  assert.deepEqual(Object.keys(entries).sort(), expected.sort());
  assert.deepEqual(Object.keys(entries), [proxyContextKey('/api/celestrak')]);
  for (const entry of Object.values(entries)) {
    assert.equal(entry.target, 'http://127.0.0.1:8787');
    assert.equal(entry.changeOrigin, false);
  }
});

test('no unrelated Vite API route is intercepted', () => {
  const entries = panopticProxy({});
  // Every route still executed inside vite.config.js must fall through.
  const untouched = [
    '/api/opensky', '/api/tomtom/status', '/api/firms', '/api/cctv/sources',
    '/api/overpass', '/api/ais-live', '/api/realtime/token', '/api/gbfs/x',
    '/api/adsbdb/type/A320', '/api/launches', '/api/radio/stations',
    '/api/terrain/heights', '/api/military-installations', '/api/regional-brief',
    '/api/weather-effects', '/api/route', '/api/google/nearby-places',
  ];
  for (const url of untouched) {
    for (const context of Object.keys(entries)) {
      assert.equal(contextMatches(context, url), false, `${url} must not be proxied`);
    }
  }
});

test('the proxy context is anchored on a path-segment boundary', () => {
  const context = proxyContextKey('/api/celestrak');
  assert.equal(context[0], '^', 'a plain string key would startsWith-match /api/celestrakfoo');

  assert.equal(contextMatches(context, '/api/celestrak'), true);
  assert.equal(contextMatches(context, '/api/celestrak/stations'), true);
  assert.equal(contextMatches(context, '/api/celestrak/stations?t=1'), true);
  assert.equal(contextMatches(context, '/api/celestrakfoo'), false);
  assert.equal(contextMatches(context, '/api/celestrak-v2/x'), false);
  assert.equal(contextMatches(context, '/api/celestra'), false);
});

test('the proxy target follows PANOPTIC_HOST/PANOPTIC_PORT, resolving bind-any to loopback', () => {
  const target = (env) => Object.values(panopticProxy(env))[0].target;

  assert.equal(target({}), 'http://127.0.0.1:8787');
  assert.equal(target({ PANOPTIC_PORT: '9000' }), 'http://127.0.0.1:9000');
  assert.equal(target({ PANOPTIC_HOST: '127.0.0.2' }), 'http://127.0.0.2:8787');
  // 0.0.0.0 and :: mean "bind everywhere", not an address you can dial.
  assert.equal(target({ PANOPTIC_HOST: '0.0.0.0' }), 'http://127.0.0.1:8787');
  assert.equal(target({ PANOPTIC_HOST: '::' }), 'http://127.0.0.1:8787');
  // And the shared resolver keeps the bind host separate from the dial origin.
  assert.deepEqual(
    resolveBackendAddress({ PANOPTIC_HOST: '0.0.0.0', PANOPTIC_PORT: '1234' }),
    { host: '0.0.0.0', port: 1234, origin: 'http://127.0.0.1:1234' },
  );
});

// ---------------------------------------------------------------------------
// The old implementation is gone, not shadowed
// ---------------------------------------------------------------------------

test('the Vite-hosted CelesTrak implementation is no longer mounted', () => {
  const calls = [];
  const app = { use: (...args) => calls.push(args) };
  const mounted = createRuntime(COLLECTORS).mount(app, 'dev');

  // Vite registers configureServer middlewares BEFORE server.proxy, so anything
  // mounted here would win and the proxy would be unreachable dead config.
  assert.deepEqual(mounted, [], 'no collector may execute on the Vite dev surface');
  assert.equal(calls.length, 0, 'nothing was registered on the Vite middleware stack');
});

// ---------------------------------------------------------------------------
// End to end through a real Vite dev server
// ---------------------------------------------------------------------------

test('a browser-facing /api/celestrak request reaches the standalone backend', async () => {
  const s = await stack();
  try {
    const cold = await fetch(`${s.origin}/api/celestrak/stations`);
    const body = await cold.text();

    assert.equal(cold.status, 200);
    assert.equal(cold.headers.get('x-tle-cache'), 'MISS', 'x-tle-cache must survive proxying');
    assert.equal(body, TLE_BODY);
    assert.match(cold.headers.get('content-type'), /text\/plain/);

    const warm = await fetch(`${s.origin}/api/celestrak/stations`);
    assert.equal(warm.headers.get('x-tle-cache'), 'HIT');
    assert.equal(await warm.text(), TLE_BODY);
  } finally { await s.close(); }
});

test('query strings survive the proxy hop', async () => {
  const seen = [];
  const s = await stack({
    fetchImpl: async (url) => {
      seen.push(new URL(url).searchParams.get('GROUP'));
      return new Response(TLE_BODY, { status: 200 });
    },
  });
  try {
    const res = await fetch(`${s.origin}/api/celestrak/stations?t=123&x=y`);
    assert.equal(res.status, 200);
    await res.text();
    assert.deepEqual(seen, ['stations'], 'the group survived, and the query did not corrupt it');
  } finally { await s.close(); }
});

test('an invalid group preserves its 400 through the proxy', async () => {
  const s = await stack();
  try {
    const res = await fetch(`${s.origin}/api/celestrak/not!valid`);
    assert.equal(res.status, 400, 'status codes must survive proxying');
    assert.equal(await res.text(), 'invalid group');
    assert.equal(res.headers.get('x-tle-cache'), null);
  } finally { await s.close(); }
});

test('/api/celestrakfoo is not proxied and falls through to Vite', async () => {
  const s = await stack();
  try {
    const res = await fetch(`${s.origin}/api/celestrakfoo`);
    // Whatever Vite does with it, it must not be a backend response.
    assert.equal(res.headers.get('x-tle-cache'), null);
    assert.equal(res.headers.get('x-panoptic-proxy'), null);
    assert.notEqual(await res.text(), TLE_BODY);
  } finally { await s.close(); }
});

test('the Vite SPA is still served normally', async () => {
  const s = await stack();
  try {
    const res = await fetch(`${s.origin}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /SPA OK/);
  } finally { await s.close(); }
});

// ---------------------------------------------------------------------------
// Backend down — obvious failure, no fallback
// ---------------------------------------------------------------------------

test('a missing backend produces an obvious 502 with no fallback', async () => {
  const s = await stack({ startBackend: false });
  try {
    const res = await fetch(`${s.origin}/api/celestrak/stations`);
    const body = await res.text();

    assert.equal(res.status, 502);
    assert.equal(res.headers.get('x-panoptic-proxy'), 'backend-unreachable');
    assert.match(body, /PANOPTIC backend unreachable/);
    assert.match(body, /npm run server/);

    // The decisive part: no Vite-hosted implementation answered instead.
    assert.notEqual(body, TLE_BODY);
    assert.equal(res.headers.get('x-tle-cache'), null, 'no collector may have served this');
  } finally { await s.close(); }
});
