// PANOPTIC configuration loader.
//
// Two properties matter most here:
//
//   1. PRECEDENCE MATCHES VITE. The Vite dev proxy and the standalone backend
//      resolve their address from the same .env chain. If the two loaders
//      disagree, the proxy points where nothing is listening and every /api
//      call 502s with correct-looking configuration on both sides.
//   2. A MALFORMED VALUE IS FATAL. Absence is fine and defaults apply, but a
//      typo must stop startup rather than silently bind somewhere unexpected.
//
// Nothing here touches the repository's own .env: every case runs against a
// throwaway directory with an explicit process environment.
//
// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { inspect } from 'node:util';
import {
  PanopticConfigError,
  collectorConfigurationState,
  defaultMode,
  isSecret,
  loadPanopticConfig,
  secret,
} from '../../server/config/index.js';
import { envFileNames, loadEnvironment, readEnvFiles } from '../../server/config/envFiles.js';
import {
  COLLECTOR_REQUIREMENTS,
  PANOPTIC_SCHEMA,
  applySchema,
} from '../../server/config/schema.js';
import { resolveBackendAddress } from '../../server/backendAddress.js';

/** A throwaway directory seeded with the given .env files. */
async function envDir(files = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'panoptic-config-'));
  for (const [name, body] of Object.entries(files)) {
    await writeFile(path.join(dir, name), body, 'utf8');
  }
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const load = (dir, processEnv = {}, extra = {}) =>
  loadPanopticConfig({ dir, mode: 'development', processEnv, ...extra });

// ---------------------------------------------------------------------------
// Scope — PANOPTIC owns only what it owns
// ---------------------------------------------------------------------------

test('the schema declares only PANOPTIC-owned variables', () => {
  assert.deepEqual(
    PANOPTIC_SCHEMA.map((e) => e.name),
    ['PANOPTIC_HOST', 'PANOPTIC_PORT', 'PANOPTIC_SHUTDOWN_TIMEOUT_MS'],
  );
  // Legacy variables still read by vite.config.js must NOT appear: modelling
  // them here would give one value two owners.
  const names = new Set(PANOPTIC_SCHEMA.map((e) => e.name));
  for (const legacy of [
    'FIRMS_MAP_KEY', 'TOMTOM_API_KEY', 'OPENAI_API_KEY', 'AISSTREAM_API_KEY',
    'OPENSKY_CLIENT_ID', 'OPENSKY_CREDENTIALS_FILE', 'GOOGLE_MAPS_API_KEY',
    'CESIUM_ION_TOKEN', 'HOST', 'PORT',
  ]) {
    assert.equal(names.has(legacy), false, `${legacy} is still Vite-owned and must not be in the schema`);
  }
  // None of the PANOPTIC-owned variables reach the browser.
  for (const entry of PANOPTIC_SCHEMA) assert.equal(entry.scope, 'server');
});

test('CelesTrak requires no configuration', async () => {
  assert.deepEqual([...COLLECTOR_REQUIREMENTS.celestrak], []);
  assert.equal(collectorConfigurationState('celestrak'), 'not-required');

  const { dir, cleanup } = await envDir();
  try {
    const config = load(dir);
    assert.deepEqual(config.collectors.celestrak, { configuration: 'not-required' });
  } finally { await cleanup(); }
});

// ---------------------------------------------------------------------------
// .env precedence
// ---------------------------------------------------------------------------

test('env files are read in Vite order', () => {
  assert.deepEqual(envFileNames('development'), [
    '.env', '.env.local', '.env.development', '.env.development.local',
  ]);
});

test('later env files override earlier ones', async () => {
  const { dir, cleanup } = await envDir({
    '.env': 'PANOPTIC_PORT=1111\n',
    '.env.local': 'PANOPTIC_PORT=2222\n',
    '.env.development': 'PANOPTIC_PORT=3333\n',
    '.env.development.local': 'PANOPTIC_PORT=4444\n',
  });
  try {
    assert.equal(load(dir).server.port, 4444, '.env.development.local has highest file precedence');
  } finally { await cleanup(); }
});

test('each file wins over the one below it', async () => {
  const cases = [
    [{ '.env': 'PANOPTIC_PORT=1111\n' }, 1111],
    [{ '.env': 'PANOPTIC_PORT=1111\n', '.env.local': 'PANOPTIC_PORT=2222\n' }, 2222],
    [{ '.env.local': 'PANOPTIC_PORT=2222\n', '.env.development': 'PANOPTIC_PORT=3333\n' }, 3333],
  ];
  for (const [files, expected] of cases) {
    const { dir, cleanup } = await envDir(files);
    try {
      assert.equal(load(dir).server.port, expected);
    } finally { await cleanup(); }
  }
});

test('the process environment beats every env file', async () => {
  const { dir, cleanup } = await envDir({
    '.env': 'PANOPTIC_PORT=1111\nPANOPTIC_HOST=10.0.0.1\n',
    '.env.development.local': 'PANOPTIC_PORT=4444\n',
  });
  try {
    const config = load(dir, { PANOPTIC_PORT: '9999', PANOPTIC_HOST: '127.0.0.2' });
    assert.equal(config.server.port, 9999, 'the real environment is the production case and must win');
    assert.equal(config.server.host, '127.0.0.2');
  } finally { await cleanup(); }
});

test('missing env files are normal, not an error', async () => {
  const { dir, cleanup } = await envDir();
  try {
    const config = load(dir);
    assert.deepEqual(config.envFiles, [], 'no files found, and that is fine');
    assert.equal(config.server.host, '127.0.0.1');
    assert.equal(config.server.port, 8787);
    assert.equal(config.server.shutdownTimeoutMs, 10_000);
  } finally { await cleanup(); }
});

test('loading env files never mutates process.env', async () => {
  const { dir, cleanup } = await envDir({ '.env': 'PANOPTIC_TEST_CANARY=leaked\n' });
  try {
    assert.equal(process.env.PANOPTIC_TEST_CANARY, undefined, 'precondition');
    const { env } = loadEnvironment({ dir, mode: 'development', processEnv: {} });
    assert.equal(env.PANOPTIC_TEST_CANARY, 'leaked', 'the value was read');
    assert.equal(
      process.env.PANOPTIC_TEST_CANARY,
      undefined,
      'util.parseEnv is used precisely so the global environment is not touched',
    );
  } finally { await cleanup(); }
});

test('the returned environment is frozen', async () => {
  const { dir, cleanup } = await envDir({ '.env': 'PANOPTIC_PORT=1234\n' });
  try {
    const { env } = loadEnvironment({ dir, mode: 'development', processEnv: {} });
    assert.equal(Object.isFrozen(env), true);
  } finally { await cleanup(); }
});

// ---------------------------------------------------------------------------
// Unsupported expansion
// ---------------------------------------------------------------------------

test('${...} expansion fails loudly rather than diverging from Vite', async () => {
  const { dir, cleanup } = await envDir({ '.env': 'PANOPTIC_HOST=${SOME_OTHER}\n' });
  try {
    assert.throws(() => load(dir), (err) => {
      assert.ok(err instanceof PanopticConfigError);
      assert.match(err.message, /PANOPTIC_HOST/);
      assert.match(err.message, /expansion/);
      return true;
    });
  } finally { await cleanup(); }
});

test('a plain value containing a dollar sign is not mistaken for expansion', async () => {
  const { dir, cleanup } = await envDir({ '.env': 'PANOPTIC_HOST=host$name\n' });
  try {
    assert.equal(load(dir).server.host, 'host$name');
  } finally { await cleanup(); }
});

test('"local" is rejected as a mode, as Vite rejects it', async () => {
  const { dir, cleanup } = await envDir();
  try {
    assert.throws(
      () => readEnvFiles({ dir, mode: 'local' }),
      /conflicts with the .local/,
    );
  } finally { await cleanup(); }
});

// ---------------------------------------------------------------------------
// Validation — malformed is fatal, absent is a default
// ---------------------------------------------------------------------------

test('an invalid PANOPTIC_PORT is fatal', async () => {
  const { dir, cleanup } = await envDir();
  try {
    for (const bad of ['eight', '80.5', '', ' ']) {
      if (bad.trim() === '') {
        // Empty means unset, which is a default rather than an error.
        assert.equal(load(dir, { PANOPTIC_PORT: bad }).server.port, 8787);
        continue;
      }
      assert.throws(() => load(dir, { PANOPTIC_PORT: bad }), PanopticConfigError, `expected ${bad} to fail`);
    }
  } finally { await cleanup(); }
});

test('an out-of-range PANOPTIC_PORT is fatal', async () => {
  const { dir, cleanup } = await envDir();
  try {
    for (const bad of ['-1', '65536', '99999']) {
      assert.throws(() => load(dir, { PANOPTIC_PORT: bad }), PanopticConfigError);
    }
    // Port 0 is legitimate — it asks the OS for an ephemeral port.
    assert.equal(load(dir, { PANOPTIC_PORT: '0' }).server.port, 0);
    assert.equal(load(dir, { PANOPTIC_PORT: '65535' }).server.port, 65_535);
  } finally { await cleanup(); }
});

test('an invalid PANOPTIC_SHUTDOWN_TIMEOUT_MS is fatal', async () => {
  const { dir, cleanup } = await envDir();
  try {
    for (const bad of ['soon', '-1', '999999', '1.5']) {
      assert.throws(() => load(dir, { PANOPTIC_SHUTDOWN_TIMEOUT_MS: bad }), PanopticConfigError);
    }
    assert.equal(load(dir, { PANOPTIC_SHUTDOWN_TIMEOUT_MS: '250' }).server.shutdownTimeoutMs, 250);
  } finally { await cleanup(); }
});

test('an empty or whitespace PANOPTIC_HOST is fatal, not silently defaulted away', async () => {
  const { dir, cleanup } = await envDir();
  try {
    // Unset falls back to the default...
    assert.equal(load(dir, {}).server.host, '127.0.0.1');
    // ...but a value that is present and nonsense stops startup.
    assert.throws(() => load(dir, { PANOPTIC_HOST: 'a host' }), PanopticConfigError);
  } finally { await cleanup(); }
});

test('every problem is reported at once, not just the first', () => {
  const { problems } = applySchema({
    PANOPTIC_PORT: 'nope',
    PANOPTIC_SHUTDOWN_TIMEOUT_MS: 'also-nope',
    PANOPTIC_HOST: 'bad host',
  });
  assert.equal(problems.length, 3, 'a misconfigured setup should be fixable in one pass');
  const message = new PanopticConfigError(problems).message;
  for (const name of ['PANOPTIC_PORT', 'PANOPTIC_SHUTDOWN_TIMEOUT_MS', 'PANOPTIC_HOST']) {
    assert.match(message, new RegExp(name));
  }
});

test('defaults apply when nothing is configured', () => {
  const { values, problems } = applySchema({});
  assert.deepEqual(problems, []);
  assert.deepEqual(values, {
    PANOPTIC_HOST: '127.0.0.1',
    PANOPTIC_PORT: 8787,
    PANOPTIC_SHUTDOWN_TIMEOUT_MS: 10_000,
  });
});

test('the mode defaults to development and follows NODE_ENV', () => {
  assert.equal(defaultMode({}), 'development');
  assert.equal(defaultMode({ NODE_ENV: '' }), 'development');
  assert.equal(defaultMode({ NODE_ENV: 'production' }), 'production');
});

// ---------------------------------------------------------------------------
// Secret wrapper
// ---------------------------------------------------------------------------

test('a secret cannot be revealed by accident', () => {
  // Synthetic — PANOPTIC owns no secret today. This proves the wrapper is ready
  // for the FIRMS migration without inventing a credential we do not own.
  const value = 'super-secret-map-key-1234567890';
  const wrapped = secret(value);

  assert.equal(String(wrapped), '[redacted]');
  assert.equal(`${wrapped}`, '[redacted]');
  assert.equal(JSON.stringify(wrapped), '"[redacted]"');
  assert.equal(JSON.stringify({ key: wrapped }), '{"key":"[redacted]"}');
  assert.equal(inspect(wrapped), '[redacted]');
  assert.equal(inspect({ nested: { key: wrapped } }, { depth: 5 }), '{ nested: { key: [redacted] } }');

  for (const rendering of [
    String(wrapped), JSON.stringify(wrapped), inspect(wrapped),
    inspect({ key: wrapped }), `${wrapped}`,
  ]) {
    assert.equal(rendering.includes(value), false, 'no rendering may contain the value');
  }

  // Only an explicit reveal() returns it.
  assert.equal(wrapped.reveal(), value);
  assert.equal(isSecret(wrapped), true);
  assert.equal(isSecret('plain'), false);
  assert.equal(isSecret(null), false);
});

test('a secret box is frozen', () => {
  const wrapped = secret('x');
  assert.equal(Object.isFrozen(wrapped), true);
});

// ---------------------------------------------------------------------------
// Address agreement — launcher, proxy and backend
// ---------------------------------------------------------------------------

test('the launcher, the Vite proxy and the backend resolve the same address', async () => {
  const cases = [
    [{}, {}],
    [{ '.env': 'PANOPTIC_PORT=4321\n' }, {}],
    [{ '.env': 'PANOPTIC_PORT=4321\n' }, { PANOPTIC_PORT: '5678' }],
    [{ '.env.development.local': 'PANOPTIC_HOST=127.0.0.5\n' }, {}],
  ];
  for (const [files, processEnv] of cases) {
    const { dir, cleanup } = await envDir(files);
    try {
      // What the launcher and the backend use.
      const config = load(dir, processEnv);
      // What panopticProxy() targets, given the same merged environment.
      const { env } = loadEnvironment({ dir, mode: 'development', processEnv });
      const proxyTarget = resolveBackendAddress(env);

      assert.equal(config.server.origin, proxyTarget.origin, 'proxy target must equal the backend origin');
      assert.equal(config.server.host, proxyTarget.host);
      assert.equal(config.server.port, proxyTarget.port);
    } finally { await cleanup(); }
  }
});

test('a wildcard bind still yields a dialable origin', async () => {
  const { dir, cleanup } = await envDir();
  try {
    const config = load(dir, { PANOPTIC_HOST: '0.0.0.0', PANOPTIC_PORT: '1234' });
    assert.equal(config.server.host, '0.0.0.0', 'bind every interface');
    assert.equal(config.server.origin, 'http://127.0.0.1:1234', 'but dial loopback');
  } finally { await cleanup(); }
});

// ---------------------------------------------------------------------------
// The config object leaks nothing
// ---------------------------------------------------------------------------

test('the loaded config carries file paths but no environment values', async () => {
  const { dir, cleanup } = await envDir({
    '.env': 'PANOPTIC_PORT=4321\nSOME_OTHER_SECRET=do-not-carry-me\n',
  });
  try {
    const config = load(dir);
    const rendered = JSON.stringify(config);
    assert.equal(rendered.includes('do-not-carry-me'), false, 'unowned values must not ride along');
    assert.equal(rendered.includes('SOME_OTHER_SECRET'), false);
    assert.equal(config.envFiles.length, 1, 'file paths are kept for diagnostics');
    assert.equal(Object.isFrozen(config), true);
    assert.equal(Object.isFrozen(config.server), true);
  } finally { await cleanup(); }
});
