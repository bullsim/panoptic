/**
 * PANOPTIC configuration entry point.
 *
 * One loader, used by the standalone server, the dev launcher, and tests, so
 * the backend's bind address and the Vite proxy's target cannot disagree.
 *
 * Scope is deliberately narrow: this owns the variables in
 * `server/config/schema.js` and nothing else. Everything still read by
 * `vite.config.js` stays Vite's until its collector migrates.
 *
 * Policy:
 *   • a configured value that is malformed  → FATAL, startup stops
 *   • an absent optional value              → default applied silently
 *   • a missing .env file                   → normal, skipped
 *
 * @module server/config/index
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { loadEnvironment } from './envFiles.js';
import {
  COLLECTOR_REQUIREMENTS,
  ConfigProblem,
  PANOPTIC_SCHEMA,
  applySchema,
} from './schema.js';
import { resolveBackendAddress } from '../backendAddress.js';

/** Repository root — where the .env files live. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export { ConfigProblem, PANOPTIC_SCHEMA };

/** Marks a secret box so `isSecret` can recognise one. */
const SECRET_BRAND = Symbol('panoptic.secret');

/**
 * Wrap a sensitive value so it cannot be printed by accident.
 *
 * Credentials leak through the mundane paths — a `console.log(config)`, a
 * template literal in an error message, a JSON body. All three are covered:
 * `String()`, `JSON.stringify()` and `util.inspect()` return `[redacted]`, and
 * reading the value requires saying `.reveal()` on purpose.
 *
 * No PANOPTIC-owned variable is secret today. This exists ready for the FIRMS
 * migration, and is proven by tests with synthetic values rather than by
 * inventing a credential we do not yet own.
 *
 * @param {string} value - The sensitive value.
 * @returns {{reveal: () => string}} An opaque box.
 */
export function secret(value) {
  const box = {
    [SECRET_BRAND]: true,
    reveal: () => value,
    toString: () => '[redacted]',
    toJSON: () => '[redacted]',
    [inspect.custom]: () => '[redacted]',
  };
  return Object.freeze(box);
}

/** Whether a value is a secret box. */
export function isSecret(value) {
  return Boolean(value && typeof value === 'object' && value[SECRET_BRAND] === true);
}

/** Raised when configuration is unusable. Carries every problem found. */
export class PanopticConfigError extends Error {
  /** @param {ConfigProblem[]} problems - Everything wrong, not just the first. */
  constructor(problems) {
    const lines = problems.map((p) => `  - ${p.message}`).join('\n');
    super(`PANOPTIC configuration is invalid:\n${lines}`);
    this.name = 'PanopticConfigError';
    this.problems = problems;
  }
}

/** Default mode, mirroring how Vite picks one for the dev server. */
export function defaultMode(processEnv = process.env) {
  return String(processEnv.NODE_ENV || '').trim() || 'development';
}

/**
 * Configuration state for one collector.
 *
 * `not-required` is a distinct answer from "satisfied": CelesTrak needs no
 * configuration at all, and saying so is more honest than reporting an empty
 * requirement as met.
 *
 * @param {string} id - Collector id.
 * @param {Record<string,unknown>} values - Resolved values.
 * @returns {'not-required'|'configured'|'missing'} State.
 */
export function collectorConfigurationState(id, values = {}) {
  const required = COLLECTOR_REQUIREMENTS[id];
  if (!required || required.length === 0) return 'not-required';
  return required.every((name) => values[name] !== undefined && values[name] !== null)
    ? 'configured'
    : 'missing';
}

/**
 * Load, validate and freeze the PANOPTIC configuration.
 *
 * @param {object} [options] - Loader options.
 * @param {string} [options.dir] - Directory holding .env files (default: repo root).
 * @param {string} [options.mode] - Mode (default: NODE_ENV or `development`).
 * @param {Record<string,string|undefined>} [options.processEnv] - Environment to overlay.
 * @param {(p: string) => string} [options.readFile] - Reader (injectable for tests).
 * @returns {Readonly<object>} Frozen configuration.
 * @throws {PanopticConfigError} When any configured value is malformed.
 */
export function loadPanopticConfig({
  dir = ROOT,
  mode = undefined,
  processEnv = process.env,
  readFile = undefined,
} = {}) {
  const resolvedMode = mode ?? defaultMode(processEnv);
  const { env, files, problems: fileProblems } = loadEnvironment({
    dir,
    mode: resolvedMode,
    processEnv,
    readFile,
  });

  const { values, problems: schemaProblems } = applySchema(env, PANOPTIC_SCHEMA);
  const problems = [...fileProblems, ...schemaProblems];
  if (problems.length) throw new PanopticConfigError(problems);

  // One resolver for the address, so the bind host and the dial origin (which
  // differ for 0.0.0.0) stay consistent with what the Vite proxy targets.
  const address = resolveBackendAddress(env);

  const collectors = {};
  for (const id of Object.keys(COLLECTOR_REQUIREMENTS)) {
    collectors[id] = Object.freeze({ configuration: collectorConfigurationState(id, values) });
  }

  return Object.freeze({
    mode: resolvedMode,
    // Paths only — never values. Useful when a setting came from an unexpected file.
    envFiles: Object.freeze(files),
    server: Object.freeze({
      host: address.host,
      port: address.port,
      origin: address.origin,
      shutdownTimeoutMs: values.PANOPTIC_SHUTDOWN_TIMEOUT_MS,
    }),
    collectors: Object.freeze(collectors),
  });
}
