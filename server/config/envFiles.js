/**
 * `.env` file loading for PANOPTIC, matching Vite's precedence exactly.
 *
 * Vite and the standalone server must agree on configuration or the dev proxy
 * points somewhere the backend is not listening. Rather than import Vite's
 * `loadEnv` — which would drag a devDependency into the production server — this
 * reproduces its file list and precedence on Node's built-in `util.parseEnv`.
 *
 * `util.parseEnv` is used deliberately in preference to `process.loadEnvFile`:
 * it returns a plain object and mutates nothing, so precedence is decided here
 * rather than inherited from a global side effect.
 *
 * ONE KNOWN DIFFERENCE FROM VITE. Vite bundles dotenv-expand, so its `loadEnv`
 * resolves `${VAR}` references inside .env values; `util.parseEnv` does not.
 * Silently differing would be the worst outcome, so a `${` in any file-sourced
 * value is a hard error naming the variable. If expansion is ever genuinely
 * needed, implement it here — do not let the two loaders drift apart.
 *
 * @module server/config/envFiles
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { ConfigProblem } from './schema.js';

/**
 * The env files Vite reads, lowest precedence first.
 *
 * Mirrors Vite's `getEnvFilesForMode`. Later files override earlier ones.
 *
 * @param {string} mode - Vite mode, e.g. `development`.
 * @returns {string[]} Bare file names in precedence order.
 */
export function envFileNames(mode) {
  return ['.env', '.env.local', `.env.${mode}`, `.env.${mode}.local`];
}

/** Vite rejects `local` as a mode because it collides with the .local suffix. */
export function assertUsableMode(mode) {
  if (mode === 'local') {
    throw new ConfigProblem(
      'mode',
      '"local" cannot be used as a mode name because it conflicts with the .local .env suffix',
    );
  }
  return mode;
}

/**
 * Read and merge the env files for a mode.
 *
 * Missing files are normal and skipped silently — in production there is often
 * no .env file at all and the process environment is the whole configuration.
 *
 * @param {object} options - Loader options.
 * @param {string} options.dir - Directory holding the .env files.
 * @param {string} options.mode - Mode selecting the mode-specific files.
 * @param {(p: string) => string} [options.readFile] - Reader (injectable for tests).
 * @returns {{values: Record<string,string>, files: string[], problems: ConfigProblem[]}}
 */
export function readEnvFiles({ dir, mode, readFile = (p) => readFileSync(p, 'utf8') }) {
  assertUsableMode(mode);
  const values = {};
  const files = [];
  const problems = [];

  for (const name of envFileNames(mode)) {
    const filePath = path.join(dir, name);
    let contents;
    try {
      contents = readFile(filePath);
    } catch (err) {
      // ENOENT is the common, expected case. Anything else — a directory in the
      // way, a permissions problem — is worth surfacing rather than ignoring.
      if (err?.code !== 'ENOENT') {
        problems.push(new ConfigProblem(name, `could not be read (${err?.code || err?.message || err})`));
      }
      continue;
    }
    files.push(filePath);
    Object.assign(values, parseEnv(contents));
  }

  for (const [key, value] of Object.entries(values)) {
    if (typeof value === 'string' && value.includes('${')) {
      problems.push(new ConfigProblem(
        key,
        'uses ${...} expansion, which PANOPTIC does not support (Vite would expand it, so the two would disagree) — inline the value',
      ));
    }
  }

  return { values, files, problems };
}

/**
 * Merge env files with the process environment, Vite's precedence.
 *
 * 1. process.env                (highest — container, shell, CI)
 * 2. .env.<mode>.local
 * 3. .env.<mode>
 * 4. .env.local
 * 5. .env                       (lowest)
 *
 * The real environment winning matches Vite's `loadEnv` with an empty prefix,
 * where every key matches and process.env is applied last.
 *
 * Nothing here mutates `process.env`; the merged result is returned frozen.
 *
 * @param {object} options - Loader options.
 * @param {string} options.dir - Directory holding the .env files.
 * @param {string} options.mode - Mode.
 * @param {Record<string,string|undefined>} [options.processEnv] - Environment to overlay.
 * @param {(p: string) => string} [options.readFile] - Reader (injectable for tests).
 * @returns {{env: Readonly<Record<string,string>>, files: string[], problems: ConfigProblem[]}}
 */
export function loadEnvironment({ dir, mode, processEnv = process.env, readFile }) {
  const { values, files, problems } = readEnvFiles({ dir, mode, readFile });
  const merged = { ...values };
  for (const [key, value] of Object.entries(processEnv)) {
    if (value !== undefined) merged[key] = value;
  }
  return { env: Object.freeze(merged), files, problems };
}
