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
 * This module imports nothing, deliberately: `server/index.js` needs it and so
 * does `server/bin/serve.js`, and anything heavier here would make those two
 * import each other in a cycle.
 *
 * @module server/backendAddress
 */

/** Defaults for the standalone backend. Loopback — never LAN — unless asked. */
export const BACKEND_DEFAULTS = Object.freeze({
  host: '127.0.0.1',
  port: 8787,
});

/** Bind-any addresses, which are not usable as a connect target. */
const BIND_ANY = new Set(['0.0.0.0', '::', '[::]']);

/**
 * Read an integer from an environment, failing loudly on nonsense.
 *
 * A typo in a port should stop startup, not silently bind somewhere unexpected.
 *
 * @param {Record<string,string|undefined>} env - Environment.
 * @param {string} key - Variable name.
 * @param {number} fallback - Value when unset or empty.
 * @param {{min: number, max: number}} bounds - Accepted range, inclusive.
 * @returns {number} Parsed value.
 */
export function readIntEnv(env, key, fallback, bounds) {
  const raw = env[key];
  if (raw === undefined || String(raw).trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    throw new Error(`${key} must be an integer in [${bounds.min}, ${bounds.max}] — received ${JSON.stringify(raw)}`);
  }
  return value;
}

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
  const host = String(env.PANOPTIC_HOST || '').trim() || BACKEND_DEFAULTS.host;
  // Port 0 is allowed: it asks the OS for an ephemeral port, which tests use.
  const port = readIntEnv(env, 'PANOPTIC_PORT', BACKEND_DEFAULTS.port, { min: 0, max: 65_535 });
  const target = BIND_ANY.has(host) ? BACKEND_DEFAULTS.host : host;
  // Bracket a literal IPv6 address so the URL stays parseable.
  const authority = target.includes(':') && !target.startsWith('[') ? `[${target}]` : target;
  return { host, port, origin: `http://${authority}:${port}` };
}
