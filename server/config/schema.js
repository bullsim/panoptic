/**
 * The PANOPTIC configuration contract.
 *
 * This file lists ONLY the variables PANOPTIC itself owns. It is deliberately
 * not an inventory of every environment variable the project uses — most are
 * still read by `vite.config.js`, which remains their owner until the collector
 * that needs them is migrated.
 *
 * The rule: **a variable enters this schema when ownership of it moves into
 * PANOPTIC**, in the same commit that moves it. Modelling legacy Vite-owned
 * configuration here for completeness would create two owners for one value,
 * which is precisely the failure mode the migration is meant to avoid.
 *
 * Today that means the three backend process settings. `FIRMS_MAP_KEY` and the
 * OpenSky credentials arrive with their collectors, not before.
 *
 * Imports nothing: `server/backendAddress.js` depends on the coercers here, and
 * that module is reachable from `vite.config.js`.
 *
 * @module server/config/schema
 */

/** Bind address default — loopback, never the LAN, unless asked. */
export const DEFAULT_HOST = '127.0.0.1';
/** Backend port default. Chosen not to collide with Vite's 5173. */
export const DEFAULT_PORT = 8787;
/** Graceful-shutdown grace period default (ms). */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * A configuration problem, carrying the variable it concerns.
 *
 * Thrown by coercers and collected by the loader so a startup failure can
 * report every problem at once instead of only the first.
 */
export class ConfigProblem extends Error {
  /**
   * @param {string} name - Variable name.
   * @param {string} message - What is wrong, without the value if secret.
   */
  constructor(name, message) {
    super(`${name}: ${message}`);
    this.name = 'ConfigProblem';
    this.variable = name;
    this.detail = message;
  }
}

/** Whether a raw environment value counts as "not set". */
function isUnset(raw) {
  return raw === undefined || raw === null || String(raw).trim() === '';
}

/**
 * Coerce a bounded integer, failing loudly on anything that is not one.
 *
 * A typo in a port must stop startup, not silently fall back to a default and
 * bind somewhere the proxy is not looking.
 *
 * @param {string} name - Variable name, for the error message.
 * @param {unknown} raw - Raw value.
 * @param {{min: number, max: number}} bounds - Inclusive range.
 * @returns {number} Parsed integer.
 */
export function coerceBoundedInt(name, raw, bounds) {
  const value = Number(String(raw).trim());
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    throw new ConfigProblem(
      name,
      `expected an integer in [${bounds.min}, ${bounds.max}], received ${JSON.stringify(String(raw))}`,
    );
  }
  return value;
}

/** Coerce a non-empty host string. */
export function coerceHost(name, raw) {
  const value = String(raw).trim();
  if (!value) throw new ConfigProblem(name, 'must not be empty');
  if (/\s/.test(value)) {
    throw new ConfigProblem(name, `must not contain whitespace, received ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * The PANOPTIC-owned variables.
 *
 * `scope: 'server'` on all three — none of these reach the browser. The field
 * exists so the client/server boundary is declared rather than implied, and so
 * a future client-scoped entry is a deliberate act.
 *
 * @type {readonly {name: string, owner: string, scope: string, secret: boolean, default: unknown, coerce: Function}[]}
 */
export const PANOPTIC_SCHEMA = Object.freeze([
  Object.freeze({
    name: 'PANOPTIC_HOST',
    owner: 'server',
    scope: 'server',
    secret: false,
    default: DEFAULT_HOST,
    describe: 'Address the standalone PANOPTIC backend binds.',
    coerce: (name, raw) => coerceHost(name, raw),
  }),
  Object.freeze({
    name: 'PANOPTIC_PORT',
    owner: 'server',
    scope: 'server',
    secret: false,
    default: DEFAULT_PORT,
    describe: 'Port the standalone PANOPTIC backend listens on.',
    // Port 0 is allowed: it asks the OS for an ephemeral port, which tests use.
    coerce: (name, raw) => coerceBoundedInt(name, raw, { min: 0, max: 65_535 }),
  }),
  Object.freeze({
    name: 'PANOPTIC_SHUTDOWN_TIMEOUT_MS',
    owner: 'server',
    scope: 'server',
    secret: false,
    default: DEFAULT_SHUTDOWN_TIMEOUT_MS,
    describe: 'Grace period before a shutdown force-closes remaining connections.',
    coerce: (name, raw) => coerceBoundedInt(name, raw, { min: 0, max: 300_000 }),
  }),
]);

/**
 * Configuration each migrated collector requires.
 *
 * An empty list means the collector needs no configuration at all, which
 * reports as `not-required` rather than as a satisfied requirement. CelesTrak
 * is keyless by nature; inventing settings for it would be fiction.
 *
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const COLLECTOR_REQUIREMENTS = Object.freeze({
  celestrak: Object.freeze([]),
});

/**
 * Apply the schema to a flat environment.
 *
 * Collects every problem rather than throwing on the first, so a misconfigured
 * setup is reported in one pass.
 *
 * @param {Record<string, string|undefined>} env - Merged environment.
 * @param {readonly object[]} [schema] - Descriptors to apply.
 * @returns {{values: Record<string, unknown>, problems: ConfigProblem[]}} Result.
 */
export function applySchema(env, schema = PANOPTIC_SCHEMA) {
  const values = {};
  const problems = [];
  for (const entry of schema) {
    const raw = env?.[entry.name];
    if (isUnset(raw)) {
      values[entry.name] = entry.default;
      continue;
    }
    try {
      values[entry.name] = entry.coerce(entry.name, raw);
    } catch (err) {
      if (err instanceof ConfigProblem) problems.push(err);
      else problems.push(new ConfigProblem(entry.name, err?.message || String(err)));
    }
  }
  return { values, problems };
}
