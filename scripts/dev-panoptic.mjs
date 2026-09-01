#!/usr/bin/env node
/**
 * PANOPTIC development launcher — `npm run dev`.
 *
 * Starts the two processes a complete PANOPTIC development environment needs:
 *
 *   [api]  node server/bin/serve.js     the standalone backend, loopback only
 *   [web]  vite                         the frontend, which proxies /api/* to it
 *
 * Why a launcher rather than two terminals: the Vite proxy target and the
 * backend's bind address must agree, and they resolve from environments that
 * are NOT the same. `vite.config.js` calls Vite's `loadEnv`, which folds `.env`
 * into the config; `server/bin/serve.js` deliberately does not read `.env` yet.
 * A `PANOPTIC_PORT` in `.env` would therefore move the proxy target without
 * moving the server. This launcher resolves the address ONCE and passes the
 * same explicit values to both children, so they cannot diverge.
 *
 * Zero dependencies: node:child_process plus Vite's own loadEnv.
 *
 * Usage:
 *   npm run dev
 *   npm run dev -- --host 0.0.0.0 --port 5173     (forwarded verbatim to Vite)
 *
 * Everything after `--` reaches the Vite child unchanged, which is what keeps
 * `scripts/dev-secure.sh` (`npm run dev -- --host … --port …`) working.
 *
 * The backend stays bound to loopback. Exposing the frontend to a LAN is a
 * Vite-side decision (`--host`), and API traffic still reaches the backend over
 * loopback via the proxy — the backend is never itself LAN-visible.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from 'vite';
import { resolveBackendAddress } from '../server/backendAddress.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Extra args destined for Vite (npm puts everything after `--` in argv). */
const VITE_ARGS = process.argv.slice(2);

/** How long to wait for the backend's health endpoint before starting Vite. */
const READY_TIMEOUT_MS = 5_000;
const READY_POLL_MS = 100;

/**
 * Resolve the backend address the same way `vite.config.js` will.
 *
 * `loadEnv(mode, root, '')` reads this checkout's .env files; real environment
 * variables still win, matching the precedence in `vite.config.js`.
 *
 * @returns {{host: string, port: number, origin: string, env: Record<string,string>}}
 */
function resolveEnvironment() {
  const mode = process.env.NODE_ENV || 'development';
  const dotenv = loadEnv(mode, ROOT, '');
  const merged = { ...dotenv, ...process.env };
  const { host, port, origin } = resolveBackendAddress(merged);
  return {
    host,
    port,
    origin,
    // Explicit values for BOTH children. vite.config.js only copies a .env key
    // when process.env has none, so these win there too.
    env: { ...process.env, PANOPTIC_HOST: host, PANOPTIC_PORT: String(port) },
  };
}

/** Prefix every line of a child's output so two streams stay readable. */
function pipePrefixed(stream, prefix, sink) {
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) sink.write(`${prefix} ${line}\n`);
  });
  stream.on('end', () => { if (buffer) sink.write(`${prefix} ${buffer}\n`); });
}

/** Poll the backend's health endpoint until it answers or the deadline passes. */
async function waitForBackend(origin, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(READY_POLL_MS * 5) });
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
  return false;
}

async function main() {
  const { host, port, origin, env } = resolveEnvironment();
  const children = new Map();
  let shuttingDown = false;
  let exitCode = 0;

  /** Stop every surviving child once, then let the process end naturally. */
  const stopAll = (except) => {
    for (const [name, child] of children) {
      if (name === except || child.exitCode !== null || child.signalCode !== null) continue;
      child.kill();
    }
  };

  // Both children are spawned as `node <script>` — never through a shell or a
  // .cmd shim. On Windows a shim makes the real process a GRANDchild, so
  // child.kill() would kill the shim and leave the server running.
  const start = (name, prefix, script) => {
    const child = spawn(process.execPath, [script, ...(name === 'web' ? VITE_ARGS : [])], {
      cwd: ROOT,
      env,
      stdio: ['inherit', 'pipe', 'pipe'],
    });
    children.set(name, child);
    pipePrefixed(child.stdout, prefix, process.stdout);
    pipePrefixed(child.stderr, prefix, process.stderr);

    child.on('exit', (code, signal) => {
      children.delete(name);
      if (shuttingDown) return;
      shuttingDown = true;
      const how = signal ? `signal ${signal}` : `code ${code}`;
      console.log(`[panoptic] ${name} exited (${how}) — stopping the other process`);
      exitCode = code === null ? 1 : code;
      stopAll(name);
    });

    child.on('error', (err) => {
      console.error(`[panoptic] failed to start ${name}: ${err?.message || err}`);
      if (shuttingDown) return;
      shuttingDown = true;
      exitCode = 1;
      stopAll(name);
    });

    return child;
  };

  console.log(`[panoptic] backend  → ${origin}  (loopback${host === '127.0.0.1' ? '' : ` · bind ${host}`})`);
  start('api', '[api]', path.join(ROOT, 'server', 'bin', 'serve.js'));

  const ready = await waitForBackend(origin, READY_TIMEOUT_MS);
  if (!ready && !shuttingDown) {
    console.warn(`[panoptic] backend not ready after ${READY_TIMEOUT_MS} ms — starting Vite anyway; /api/* will 502 until it is`);
  }

  if (!shuttingDown) {
    start('web', '[web]', path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'));
  }

  // Ctrl-C reaches both children through the shared console/process group; this
  // is the backstop for a signal that does not, and for SIGTERM.
  const onSignal = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n[panoptic] shutting down');
    stopAll();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  // Never leave orphans behind if this process ends for any other reason.
  process.on('exit', () => stopAll());

  // Stay alive until both children are gone, then mirror their exit code.
  const idle = setInterval(() => {
    if (children.size === 0) {
      clearInterval(idle);
      process.exit(exitCode);
    }
  }, 100);
}

main().catch((err) => {
  console.error(`[panoptic] launcher failed: ${err?.message || err}`);
  process.exit(1);
});
