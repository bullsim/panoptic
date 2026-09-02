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
 * backend's bind address must agree. Both now resolve through the same rules —
 * Vite via its own `loadEnv`, PANOPTIC via `server/config` — but agreeing by
 * coincidence is not a guarantee. This launcher resolves the address ONCE and
 * passes the same explicit values to both children, so a `PANOPTIC_PORT`
 * anywhere in the .env chain moves the proxy target and the server together.
 *
 * Zero dependencies: node:child_process plus the PANOPTIC config loader. The
 * launcher orchestrates processes; it is not a configuration system.
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

import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadPanopticConfig } from '../server/config/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Extra args destined for Vite (npm puts everything after `--` in argv). */
const VITE_ARGS = process.argv.slice(2);

/** How long to wait for the backend's health endpoint before starting Vite. */
const READY_TIMEOUT_MS = 5_000;
const READY_POLL_MS = 100;

/** POSIX only: how long a child gets to honour SIGTERM before SIGKILL. */
const FORCE_KILL_AFTER_MS = 5_000;

/**
 * stdio for both children. stdin is a PIPE we hold open and never write to —
 * deliberately NOT 'inherit'. See the note on `start()` for why an inherited
 * console TTY breaks Ctrl-C. Exported so a regression test can pin it.
 */
export const CHILD_STDIO = Object.freeze(['pipe', 'pipe', 'pipe']);

/**
 * Resolve the backend address through the PANOPTIC config loader.
 *
 * The loader applies the same .env precedence Vite does, so the proxy target
 * and the bind address are decided once, here, from one set of rules.
 *
 * @returns {{host: string, port: number, origin: string, env: Record<string,string>}}
 */
function resolveEnvironment() {
  const { server } = loadPanopticConfig({ dir: ROOT });
  const { host, port, origin } = server;
  return {
    host,
    port,
    origin,
    // Explicit values for BOTH children. vite.config.js only copies a .env key
    // when process.env has none, so these win there too — which is what keeps
    // the Vite proxy and the backend from ever disagreeing.
    env: { ...process.env, PANOPTIC_HOST: host, PANOPTIC_PORT: String(port) },
  };
}

/**
 * Stop one child and everything it spawned.
 *
 * Windows has no POSIX process groups, and `child.kill()` terminates only the
 * immediate PID — a tool that spawns helpers (Vite starts an esbuild service)
 * would leak them. `taskkill /T` walks the descendant tree; `/F` is required
 * because a console application with no message loop never answers a polite
 * close request. This cannot touch unrelated processes: the tree is rooted at a
 * PID this launcher spawned itself, and Windows PIDs are not reused while the
 * handle is open.
 *
 * POSIX keeps the existing SIGTERM — `server/bin/serve.js` handles it and shuts
 * down gracefully — with a bounded escalation to SIGKILL so a child that ignores
 * the signal cannot hang the launcher.
 *
 * @param {import('node:child_process').ChildProcess} child - Child to stop.
 * @returns {void}
 */
export function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  child.kill('SIGTERM');
  const escalate = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, FORCE_KILL_AFTER_MS);
  escalate.unref?.();
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

export async function main() {
  const { host, port, origin, env } = resolveEnvironment();
  const children = new Map();
  let shuttingDown = false;
  let exitCode = 0;

  /** Stop every surviving child once, then let the process end naturally. */
  const stopAll = (except) => {
    for (const [name, child] of children) {
      if (name === except) continue;
      stopChild(child);
    }
  };

  // Both children are spawned as `node <script>` — never through a shell or a
  // .cmd shim. On Windows a shim makes the real process a GRANDchild, so
  // child.kill() would kill the shim and leave the server running.
  //
  // stdin is a PIPE we hold open and never write to, deliberately NOT 'inherit'.
  // Vite's bindCLIShortcuts() only engages when `process.stdin.isTTY`, and it
  // then builds a readline interface over that TTY. Readline takes the console
  // into raw mode and consumes Ctrl-C itself, so with an inherited console the
  // event never becomes a process signal and Vite — which registers SIGTERM but
  // no SIGINT handler — survives Ctrl-C still holding its port. Handing it a
  // pipe keeps isTTY false, so the shortcuts stay unbound and Ctrl-C reaches the
  // console group normally. The cost is Vite's r/u/o/q shortcuts under
  // `npm run dev`; `npm run dev:web` runs Vite directly and still has them.
  const start = (name, prefix, script) => {
    const child = spawn(process.execPath, [script, ...(name === 'web' ? VITE_ARGS : [])], {
      cwd: ROOT,
      env,
      stdio: [...CHILD_STDIO],
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

// Only self-start when executed directly, never when imported by a test.
// pathToFileURL handles Windows drive letters and separators correctly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`[panoptic] launcher failed: ${err?.message || err}`);
    process.exit(1);
  });
}
