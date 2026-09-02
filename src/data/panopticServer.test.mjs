// Standalone PANOPTIC server + host-independence proof.
//
// The load-bearing test here is `cross-host parity`: the SAME
// server/collectors/celestrak.js, given the same injected upstream, must
// produce identical results through BOTH of the runtime's entry points — a
// Connect-style `mount()` and native node:http `dispatch()`. Everything else in
// this file guards the routing and lifecycle details that make that possible.
//
// Note: Vite no longer executes CelesTrak at all — it proxies to the standalone
// server (see panopticProxy.test.mjs), so both sides here mount the
// 'standalone' surface. The parity claim is about the two mounting mechanisms
// staying interchangeable, which is what lets a future host reuse collectors.
//
// No test here touches celestrak.org — the upstream is always injected — and
// every cache directory is a throwaway mkdtemp.
//
// Lives under src/data/ because scripts/run-unit-tests.mjs discovers tests by
// walking src/ only; a test under server/ would silently never run.
//
// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import celestrak from '../../server/collectors/celestrak.js';
import { createStandaloneServer, HEALTH_ROUTE, SURFACE } from '../../server/standalone.js';
import { createRuntime, defineCollector, routeRemainder } from '../../server/runtime/registry.js';
import { installShutdown } from '../../server/bin/serve.js';

const TLE_BODY = [
  'ISS (ZARYA)',
  '1 25544U 98067A   24001.50000000  .00016717  00000+0  30777-3 0  9993',
  '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.49309239 33211',
].join('\n');

const silent = { warn() {}, error() {}, log() {} };

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
 * A Connect-style app, mimicking what Vite's middleware stack does: match a
 * mount prefix and rewrite req.url to the remainder before calling the handler.
 * The slicing here is hand-rolled on purpose — reusing the runtime's own
 * routeRemainder would make the parity test compare a function with itself.
 */
function connectApp() {
  const mounts = [];
  return {
    use(route, handler) { mounts.push({ route, handler }); },
    async handle(req, res) {
      for (const { route, handler } of mounts) {
        if (req.url !== route && !req.url.startsWith(`${route}/`) && !req.url.startsWith(`${route}?`)) continue;
        const original = req.url;
        req.url = original.slice(route.length) || '/';
        try {
          await handler(req, res);
        } finally { req.url = original; }
        return true;
      }
      return false;
    },
  };
}

/** The real CelesTrak collector with its context pinned to a test upstream. */
function pinnedCelestrak({ cacheDir, fetchImpl, now = () => 1_000_000 }) {
  return defineCollector({
    ...celestrak,
    createContext: () => celestrak.createContext({ cacheDir, fetchImpl, now, log: silent }),
  });
}

/** Start a standalone server on an ephemeral port. */
async function listen(collectors) {
  const { server, routes } = createStandaloneServer({ collectors, log: silent });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    routes,
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }),
  };
}

async function scratch() {
  const dir = await mkdtemp(path.join(tmpdir(), 'panoptic-server-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

test('routes match on a path-segment boundary', () => {
  assert.equal(routeRemainder('/api/celestrak/stations', '/api/celestrak'), '/stations');
  assert.equal(routeRemainder('/api/celestrak', '/api/celestrak'), '/');
  assert.equal(routeRemainder('/api/celestrak/', '/api/celestrak'), '/');
  assert.equal(routeRemainder('/api/celestrak/a/b', '/api/celestrak'), '/a/b');

  // The prefix-routing bug this exists to prevent.
  assert.equal(routeRemainder('/api/celestrakfoo', '/api/celestrak'), null);
  assert.equal(routeRemainder('/api/celestra', '/api/celestrak'), null);
  assert.equal(routeRemainder('/api/celestrak-v2/x', '/api/celestrak'), null);
  assert.equal(routeRemainder('/health', '/api/celestrak'), null);
  assert.equal(routeRemainder('/', '/api/celestrak'), null);
});

// ---------------------------------------------------------------------------
// dispatch()
// ---------------------------------------------------------------------------

test('dispatch hands the collector a route-relative url and restores it', async () => {
  const seen = [];
  const probe = defineCollector({
    id: 'probe',
    route: '/api/probe',
    surfaces: ['standalone'],
    createContext: () => ({}),
    handler: async (req, res) => { seen.push(req.url); res.end('ok'); },
  });
  const runtime = createRuntime([probe]);

  const req = { url: '/api/probe/deep/path?a=1&b=2' };
  const handled = await runtime.dispatch(req, { end() {} }, 'standalone');

  assert.equal(handled, true);
  // Exactly what Connect would have produced: prefix gone, query intact.
  assert.deepEqual(seen, ['/deep/path?a=1&b=2']);
  assert.equal(req.url, '/api/probe/deep/path?a=1&b=2', 'req.url must be restored');
});

test('dispatch restores req.url even when the handler throws', async () => {
  const boom = defineCollector({
    id: 'boom',
    route: '/api/boom',
    surfaces: ['standalone'],
    createContext: () => ({}),
    handler: async () => { throw new Error('handler exploded'); },
  });
  const runtime = createRuntime([boom]);
  const req = { url: '/api/boom/x?q=1' };

  await assert.rejects(() => runtime.dispatch(req, fakeRes(), 'standalone'), /handler exploded/);
  assert.equal(req.url, '/api/boom/x?q=1', 'a throwing handler must not corrupt req.url');
});

test('dispatch reports no match rather than guessing', async () => {
  const runtime = createRuntime([pinnedCelestrak({ cacheDir: '.', fetchImpl: async () => new Response('') })]);
  assert.equal(await runtime.dispatch({ url: '/api/celestrakfoo' }, fakeRes(), 'standalone'), false);
  assert.equal(await runtime.dispatch({ url: '/nope' }, fakeRes(), 'standalone'), false);
});

test('dispatch filters by surface, and rejects an unknown one', async () => {
  const devOnly = defineCollector({
    id: 'dev-only',
    route: '/api/dev-only',
    surfaces: ['dev'],
    createContext: () => ({}),
    handler: async (req, res) => { res.end('should not run'); },
  });
  const runtime = createRuntime([devOnly]);

  assert.equal(await runtime.dispatch({ url: '/api/dev-only' }, fakeRes(), 'standalone'), false);
  assert.equal(await runtime.dispatch({ url: '/api/dev-only' }, fakeRes(), 'dev'), true);
  await assert.rejects(() => runtime.dispatch({ url: '/x' }, fakeRes(), 'nonsense'), /unknown surface/);
});

test('CelesTrak executes on standalone only — never dev, never preview', () => {
  const runtime = createRuntime([celestrak]);
  const ids = (surface) => runtime.routes(surface).map((r) => r.id);

  assert.deepEqual(ids('standalone'), ['celestrak']);
  assert.deepEqual(ids('dev'), [], 'Vite proxies CelesTrak; it must not execute it');
  assert.deepEqual(ids('preview'), [], 'Vite preview has never served CelesTrak');

  // And the connect-mount path agrees — this is what vite.config.js drives.
  assert.deepEqual(runtime.mount(connectApp(), 'dev'), []);
  assert.deepEqual(runtime.mount(connectApp(), 'preview'), []);
});

// ---------------------------------------------------------------------------
// Cross-host parity — the architectural claim
// ---------------------------------------------------------------------------

test('cross-host parity: identical CelesTrak results via Connect mount and node:http', async () => {
  const cases = [
    { name: 'cold fetch', url: '/api/celestrak/stations' },
    { name: 'query string', url: '/api/celestrak/stations?t=99' },
    { name: 'invalid group', url: '/api/celestrak/not!valid' },
  ];

  for (const { name, url } of cases) {
    const upstream = async () => new Response(TLE_BODY, { status: 200 });

    // Host A — a Connect-style mount, via runtime.mount().
    const a = await scratch();
    const connectRuntime = createRuntime([pinnedCelestrak({ cacheDir: a.dir, fetchImpl: upstream })]);
    const app = connectApp();
    connectRuntime.mount(app, 'standalone');
    const viaConnect = fakeRes();
    await app.handle({ url }, viaConnect);

    // Host B — native node:http over a real socket.
    const b = await scratch();
    const server = await listen([pinnedCelestrak({ cacheDir: b.dir, fetchImpl: upstream })]);
    const response = await fetch(`${server.origin}${url}`);
    const viaNode = {
      status: response.status,
      cache: response.headers.get('x-tle-cache'),
      type: response.headers.get('content-type'),
      body: await response.text(),
    };
    await server.close();

    assert.equal(viaNode.status, viaConnect.status, `${name}: status must match`);
    assert.equal(viaNode.body, viaConnect.body, `${name}: body must match`);
    assert.equal(
      viaNode.cache,
      viaConnect.headers['x-tle-cache'] ?? null,
      `${name}: x-tle-cache must match`,
    );
    assert.equal(viaNode.type, viaConnect.headers['Content-Type'], `${name}: content type must match`);

    await a.cleanup();
    await b.cleanup();
  }
});

test('cross-host parity: a warm cache reports HIT on both hosts', async () => {
  const upstream = async () => new Response(TLE_BODY, { status: 200 });

  const a = await scratch();
  const connectRuntime = createRuntime([pinnedCelestrak({ cacheDir: a.dir, fetchImpl: upstream })]);
  const app = connectApp();
  connectRuntime.mount(app, 'standalone');
  const cold = fakeRes();
  await app.handle({ url: '/api/celestrak/stations' }, cold);
  const warm = fakeRes();
  await app.handle({ url: '/api/celestrak/stations' }, warm);

  const b = await scratch();
  const server = await listen([pinnedCelestrak({ cacheDir: b.dir, fetchImpl: upstream })]);
  const coldNode = await fetch(`${server.origin}/api/celestrak/stations`);
  await coldNode.text();
  const warmNode = await fetch(`${server.origin}/api/celestrak/stations`);
  const warmNodeBody = await warmNode.text();
  await server.close();

  assert.equal(cold.headers['x-tle-cache'], 'MISS');
  assert.equal(coldNode.headers.get('x-tle-cache'), 'MISS');
  assert.equal(warm.headers['x-tle-cache'], 'HIT');
  assert.equal(warmNode.headers.get('x-tle-cache'), 'HIT');
  assert.equal(warmNodeBody, warm.body);

  await a.cleanup();
  await b.cleanup();
});

// ---------------------------------------------------------------------------
// Standalone server surface
// ---------------------------------------------------------------------------

test('health reports a live backend and what it serves', async () => {
  const { dir, cleanup } = await scratch();
  const server = await listen([pinnedCelestrak({ cacheDir: dir, fetchImpl: async () => new Response(TLE_BODY) })]);
  try {
    const res = await fetch(`${server.origin}${HEALTH_ROUTE}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /application\/json/);

    const body = await res.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.service, 'panoptic');
    assert.equal(body.surface, SURFACE);
    assert.equal(body.pid, process.pid);
    assert.ok(Number.isFinite(Date.parse(body.startedAt)), 'startedAt must be an ISO timestamp');
    assert.ok(Number.isInteger(body.uptimeSeconds) && body.uptimeSeconds >= 0);
    // Configuration STATE only — an enum, never a value. CelesTrak is keyless.
    assert.deepEqual(body.collectors, [
      { id: 'celestrak', route: '/api/celestrak', configuration: 'not-required' },
    ]);

    // Health must never carry configuration values or anything derived from a
    // secret (length, prefix, hash, file path).
    const rendered = JSON.stringify(body);
    for (const forbidden of ['PANOPTIC_HOST', 'PANOPTIC_PORT', '.env', 'secret', 'token', 'key']) {
      assert.equal(rendered.toLowerCase().includes(forbidden.toLowerCase()), false, `health leaked ${forbidden}`);
    }
  } finally { await server.close(); await cleanup(); }
});

test('an unrouted path is a plain 404', async () => {
  const { dir, cleanup } = await scratch();
  const server = await listen([pinnedCelestrak({ cacheDir: dir, fetchImpl: async () => new Response(TLE_BODY) })]);
  try {
    for (const url of ['/', '/api/celestrakfoo', '/api/opensky']) {
      const res = await fetch(`${server.origin}${url}`);
      assert.equal(res.status, 404, `${url} must not be routed`);
      assert.equal(res.headers.get('x-tle-cache'), null);
      assert.equal(await res.text(), 'not found');
    }
  } finally { await server.close(); await cleanup(); }
});

test('a collector that throws past its own catch becomes a 500, not a dead socket', async () => {
  const boom = defineCollector({
    id: 'boom',
    route: '/api/boom',
    surfaces: ['standalone'],
    createContext: () => ({}),
    handler: async () => { throw new Error('kaboom'); },
  });
  const server = await listen([boom]);
  try {
    const res = await fetch(`${server.origin}/api/boom`);
    assert.equal(res.status, 500);
    assert.equal(await res.text(), 'internal error');
  } finally { await server.close(); }
});

test('the standalone route keeps the Vite route\'s method behaviour', async () => {
  const { dir, cleanup } = await scratch();
  const server = await listen([pinnedCelestrak({ cacheDir: dir, fetchImpl: async () => new Response(TLE_BODY) })]);
  try {
    // No GET-only enforcement in this milestone: POST behaves exactly as the
    // Vite middleware does today. Hardening is a later, deliberate change
    // applied to every host at once.
    const res = await fetch(`${server.origin}/api/celestrak/stations`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-tle-cache'), 'MISS');
  } finally { await server.close(); await cleanup(); }
});

// ---------------------------------------------------------------------------
// Configuration and shutdown
// ---------------------------------------------------------------------------

// Configuration parsing moved to server/config — see panopticConfig.test.mjs
// for precedence, defaults, and fatal-vs-default validation.

test('a signal closes the server cleanly and frees the port', async () => {
  const { server } = createStandaloneServer({ collectors: [], log: silent });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const handlers = {};
  let exitCode = null;
  const proc = {
    on(signal, handler) { handlers[signal] = handler; },
    off() {},
    exit(code) { exitCode = code; },
  };
  installShutdown(server, { shutdownTimeoutMs: 5_000, proc, log: silent });

  assert.ok(handlers.SIGINT && handlers.SIGTERM, 'both signals must be wired');
  handlers.SIGINT('SIGINT');
  await new Promise((resolve) => server.on('close', resolve));

  assert.equal(exitCode, 0, 'a clean shutdown exits 0');
  assert.equal(server.listening, false);

  // The port is genuinely released.
  const { server: reuse } = createStandaloneServer({ collectors: [], log: silent });
  await new Promise((resolve, reject) => {
    reuse.once('error', reject);
    reuse.listen(port, '127.0.0.1', resolve);
  });
  await new Promise((resolve) => reuse.close(resolve));
});

test('a second signal during shutdown exits immediately', async () => {
  const { server } = createStandaloneServer({ collectors: [], log: silent });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const handlers = {};
  const exits = [];
  const proc = { on(s, h) { handlers[s] = h; }, off() {}, exit(code) { exits.push(code); } };
  installShutdown(server, { shutdownTimeoutMs: 60_000, proc, log: silent });

  handlers.SIGINT('SIGINT');
  handlers.SIGINT('SIGINT');
  assert.ok(exits.includes(1), 'the second signal must force an immediate exit');

  await new Promise((resolve) => server.close(resolve));
});
