#!/usr/bin/env node
/**
 * PANOPTIC standalone server entry point — `npm run server`.
 *
 * The only file in `server/` that touches `process`: environment, listening,
 * signals, and exit codes. Everything it drives is a plain factory, so the
 * server itself stays testable without spawning a process.
 *
 * Configuration is owned by `server/config` — this file no longer parses the
 * environment itself. See `server/config/schema.js` for the variables PANOPTIC
 * owns (PANOPTIC_HOST, PANOPTIC_PORT, PANOPTIC_SHUTDOWN_TIMEOUT_MS).
 *
 * `PORT` and `HOST` are deliberately NOT read: `vite.config.js` already
 * consumes those for the dev server, and sharing them would let one .env
 * configure two servers onto the same port.
 *
 * @module server/bin/serve
 */

import { pathToFileURL } from 'node:url';
import { createStandaloneServer } from '../standalone.js';
import { PanopticConfigError, loadPanopticConfig } from '../config/index.js';

/**
 * Wire SIGINT/SIGTERM to a bounded graceful shutdown.
 *
 * Stop accepting connections, let in-flight requests finish, drop idle
 * keep-alive sockets (without this the server lingers for the whole timeout
 * with nothing actually in flight), and hard-close anything still open once the
 * grace period expires. A second signal exits immediately, so Ctrl-C twice
 * always works.
 *
 * @param {import('node:http').Server} server - Server to close.
 * @param {object} options - Shutdown options.
 * @param {number} options.shutdownTimeoutMs - Grace period before forcing.
 * @param {NodeJS.Process} [options.proc] - Process to wire (injectable for tests).
 * @param {Pick<Console,'log'|'warn'>} [options.log] - Log sink.
 * @returns {() => void} Detach the signal handlers.
 */
export function installShutdown(server, { shutdownTimeoutMs, proc = process, log = console }) {
  let closing = false;

  const onSignal = (signal) => {
    if (closing) {
      log.warn(`[panoptic] ${signal} again — exiting now`);
      proc.exit(1);
      return;
    }
    closing = true;
    log.log(`[panoptic] ${signal} received — shutting down (grace ${shutdownTimeoutMs} ms)`);

    const forceTimer = setTimeout(() => {
      log.warn('[panoptic] grace period expired — closing remaining connections');
      server.closeAllConnections();
      proc.exit(1);
    }, shutdownTimeoutMs);
    // Never let the grace timer itself hold the process open.
    forceTimer.unref?.();

    server.close(() => {
      clearTimeout(forceTimer);
      log.log('[panoptic] closed cleanly');
      proc.exit(0);
    });
    // Keep-alive sockets are idle but open; without this, close() waits.
    server.closeIdleConnections();
  };

  const signals = ['SIGINT', 'SIGTERM'];
  for (const signal of signals) proc.on(signal, onSignal);
  return () => { for (const signal of signals) proc.off(signal, onSignal); };
}

/** Boot the server from the ambient environment. */
export async function main() {
  const config = loadPanopticConfig();
  const { host, port, shutdownTimeoutMs } = config.server;
  const { server, routes } = createStandaloneServer({ config });

  installShutdown(server, { shutdownTimeoutMs });

  server.on('error', (err) => {
    const hint = err?.code === 'EADDRINUSE' ? ` — ${host}:${port} is already in use` : '';
    console.error(`[panoptic] server error: ${err?.message || err}${hint}`);
    process.exit(1);
  });

  await new Promise((resolve) => server.listen(port, host, resolve));

  const bound = server.address();
  const shown = typeof bound === 'object' && bound ? `${host}:${bound.port}` : `${host}:${port}`;
  console.log(`[panoptic] standalone server listening on http://${shown}`);
  console.log(`[panoptic] health   http://${shown}/health`);
  for (const { id, route } of routes) {
    console.log(`[panoptic] collector ${id} → http://${shown}${route}`);
  }
}

// Only self-start when executed directly, never when imported by a test.
// pathToFileURL handles Windows drive letters and separators correctly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    // A PanopticConfigError already lists every problem it found; anything else
    // gets the usual one-line treatment.
    if (err instanceof PanopticConfigError) console.error(`[panoptic] ${err.message}`);
    else console.error(`[panoptic] failed to start: ${err?.message || err}`);
    process.exit(1);
  });
}
