/**
 * Standalone PANOPTIC HTTP server.
 *
 * Serves the same collectors the Vite dev server serves, from a bare
 * `node:http` server with no framework and no dependencies. Its whole purpose
 * is to prove that `server/runtime` and `server/collectors` are genuinely
 * host-independent: nothing below this file knows which server is running it.
 *
 * This module is a pure factory — it builds a server and binds nothing. Process
 * concerns (env, listening, signals, exit codes) live in `server/bin/serve.js`,
 * which keeps this testable without spawning anything.
 *
 * @module server/standalone
 */

import http from 'node:http';
import { COLLECTORS } from './index.js';
import { createRuntime } from './runtime/registry.js';
import { sendJson, sendText } from './runtime/http.js';

/** The surface this host serves. Collectors opt in by naming it. */
export const SURFACE = 'standalone';

/** Health endpoint path. */
export const HEALTH_ROUTE = '/health';

/**
 * Build the standalone server.
 *
 * @param {object} [options] - Server options.
 * @param {readonly import('./runtime/registry.js').Collector[]} [options.collectors] - Collectors to serve.
 * @param {object|null} [options.config] - Loaded PANOPTIC configuration, for health reporting.
 * @param {() => number} [options.now] - Clock, injectable for tests.
 * @param {Pick<Console,'error'>} [options.log] - Log sink for unhandled request errors.
 * @returns {{server: import('node:http').Server, runtime: ReturnType<typeof createRuntime>, routes: {id: string, route: string}[]}}
 */
export function createStandaloneServer({
  collectors = COLLECTORS,
  config = null,
  now = () => Date.now(),
  log = console,
} = {}) {
  const runtime = createRuntime(collectors, { config });
  // Configuration STATE only — an enum per collector, never a value. CelesTrak
  // needs no configuration at all, which reports as 'not-required'.
  const routes = runtime.routes(SURFACE).map((route) => ({
    ...route,
    configuration: config?.collectors?.[route.id]?.configuration ?? 'not-required',
  }));
  const degraded = routes.some((r) => r.configuration === 'missing' || r.configuration === 'invalid');
  const startedAt = now();

  const server = http.createServer(async (req, res) => {
    try {
      const pathname = String(req.url || '').split('?')[0];

      if (pathname === HEALTH_ROUTE) {
        // Enough to establish the backend is alive and what it is serving.
        // Deliberately not an observability surface.
        sendJson(res, 200, {
          status: degraded ? 'degraded' : 'ok',
          service: 'panoptic',
          surface: SURFACE,
          pid: process.pid,
          startedAt: new Date(startedAt).toISOString(),
          uptimeSeconds: Math.round((now() - startedAt) / 1000),
          collectors: routes,
        });
        return;
      }

      // No HTTP-method check, matching the Vite route exactly. Method hardening
      // is a later deliberate change applied to every host at once.
      if (await runtime.dispatch(req, res, SURFACE)) return;

      sendText(res, 404, 'not found');
    } catch (err) {
      // A collector that throws past its own catch must not take the server
      // down or leave the socket hanging.
      log.error('[panoptic] unhandled request error:', err?.stack || err?.message || err);
      sendText(res, 500, 'internal error');
    }
  });

  return { server, runtime, routes };
}
