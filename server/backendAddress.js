/**
 * Where the PANOPTIC backend listens, and how to reach it.
 *
 * One source of truth for `PANOPTIC_HOST` / `PANOPTIC_PORT`, shared by the
 * three places that must agree or the development setup breaks silently:
 *
 *   • `server/bin/serve.js`   — binds the standalone server here
 *   • `server/index.js`       — points the Vite dev proxy at it
 *   • `scripts/dev-panoptic.mjs` — resolves once, passes both children the same values
 *
 * Host/port PARSING rules live in `server/config/schema.js` — the one place a
 * PANOPTIC-owned variable is defined. This module owns only ADDRESS semantics:
 * the difference between an address you bind and an address you dial.
 *
 * It stays a leaf (schema.js imports nothing) because `server/index.js` reaches
 * it from `vite.config.js`; anything heavier here would create a cycle.
 *
 * @module server/backendAddress
 */

import { DEFAULT_HOST, DEFAULT_PORT, coerceBoundedInt, coerceHost } from './config/schema.js';

/** Defaults for the standalone backend. Loopback — never LAN — unless asked. */
export const BACKEND_DEFAULTS = Object.freeze({
  host: DEFAULT_HOST,
  port: DEFAULT_PORT,
});

/** Bind-any addresses, which are not usable as a connect target. */
const BIND_ANY = new Set(['0.0.0.0', '::', '[::]']);

/**
 * Resolve the backend's bind address and the origin others use to reach it.
 *
 * `host` is what the server binds. `origin` is what a client dials — and those
 * differ when the server binds a wildcard: `0.0.0.0` and `::` mean "every
 * interface", not an address you can connect to (dialling `0.0.0.0` is
 * unreliable on Windows in particular), so the origin falls back to loopback.
 *
 * @param {Record<string,string|undefined>} [env] - Environment.
 * @returns {{host: string, port: number, origin: string}} Backend address.
 */
export function resolveBackendAddress(env = process.env) {
  const rawHost = env.PANOPTIC_HOST;
  const host = rawHost === undefined || String(rawHost).trim() === ''
    ? BACKEND_DEFAULTS.host
    : coerceHost('PANOPTIC_HOST', rawHost);
  const rawPort = env.PANOPTIC_PORT;
  // Port 0 is allowed: it asks the OS for an ephemeral port, which tests use.
  const port = rawPort === undefined || String(rawPort).trim() === ''
    ? BACKEND_DEFAULTS.port
    : coerceBoundedInt('PANOPTIC_PORT', rawPort, { min: 0, max: 65_535 });
  const target = BIND_ANY.has(host) ? BACKEND_DEFAULTS.host : host;
  // Bracket a literal IPv6 address so the URL stays parseable.
  const authority = target.includes(':') && !target.startsWith('[') ? `[${target}]` : target;
  return { host, port, origin: `http://${authority}:${port}` };
}
