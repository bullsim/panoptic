/**
 * PANOPTIC backend entry point.
 *
 * Owns the list of migrated collectors and adapts them to Vite. This is the
 * only file in `server/` that knows Vite exists; the registry, the collectors,
 * and the standalone host are all Vite-agnostic.
 *
 * Collectors are migrated out of `vite.config.js` one at a time. A migrated
 * collector declares `surfaces: ['standalone']`, which means Vite stops
 * EXECUTING it and starts PROXYING it — there is never a second implementation
 * of a route. `panopticProxy()` derives its entries from the same registry, so
 * a migration needs no further edit to `vite.config.js`.
 *
 * NOTE: this module now carries two Vite-facing exports. When a third appears,
 * move both into `server/hosts/vite.js` and leave `COLLECTORS` here — do not
 * keep growing the Vite surface in the package entry point.
 *
 * @module server/index
 */

import celestrak from './collectors/celestrak.js';
import firms from './collectors/firms.js';
import { createRuntime } from './runtime/registry.js';
import { resolveBackendAddress } from './backendAddress.js';

/** Collectors migrated out of `vite.config.js` so far. */
export const COLLECTORS = Object.freeze([celestrak, firms]);

/**
 * Vite plugins mounting every migrated collector.
 *
 * Returns an array so `vite.config.js` can spread it into `plugins` and later
 * migrations need no further edit there.
 *
 * @returns {import('vite').Plugin[]} Plugins to spread into the Vite config.
 */
export function panopticCollectors() {
  const runtime = createRuntime(COLLECTORS);
  return [{
    name: 'panoptic-collectors',
    configureServer(server) {
      runtime.mount(server.middlewares, 'dev');
    },
    configurePreviewServer(server) {
      // Mounts only the collectors that opt into the preview surface; CelesTrak
      // does not today, matching the plugin it replaced.
      runtime.mount(server.middlewares, 'preview');
    },
  }];
}

/**
 * Proxy context key for one collector route, anchored on a path segment.
 *
 * Vite matches a plain string key with `url.startsWith(context)`, which would
 * also capture `/api/celestrakfoo`. A key beginning with `^` is compiled to a
 * RegExp instead, giving the same segment boundary the runtime's own
 * `routeRemainder()` enforces.
 *
 * @param {string} route - Collector mount path.
 * @returns {string} Vite proxy context key.
 */
export function proxyContextKey(route) {
  return `^${route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:/|$)`;
}

/**
 * Vite dev-server proxy entries for every collector the standalone PANOPTIC
 * server owns.
 *
 * The browser keeps calling relative `/api/...` URLs and never learns the
 * backend's port. Because the entries come from the registry, migrating a
 * collector moves its route from "Vite executes" to "Vite proxies" with no edit
 * here and none in `vite.config.js`.
 *
 * @param {Record<string,string|undefined>} [env] - Environment carrying PANOPTIC_HOST/PANOPTIC_PORT.
 * @returns {Record<string, object>} A value for Vite's `server.proxy`.
 */
export function panopticProxy(env = process.env) {
  const { origin } = resolveBackendAddress(env);
  const runtime = createRuntime(COLLECTORS);
  const entries = {};

  for (const { route } of runtime.routes('standalone')) {
    entries[proxyContextKey(route)] = {
      target: origin,
      // Loopback hop to our own server, which never inspects Host.
      changeOrigin: false,
      configure(proxy) {
        proxy.on('error', (err, _req, res) => {
          // A missing backend must be loud and unmistakable. There is no
          // fallback to a Vite-hosted implementation — migrated collectors are
          // unmounted from the dev surface, not merely shadowed.
          const detail = err?.code === 'ECONNREFUSED'
            ? `PANOPTIC backend unreachable at ${origin}.`
            : `PANOPTIC backend proxy error at ${origin}: ${err?.message || err}`;
          const body = `${detail}\nStart it with \`npm run server\`, or use \`npm run dev\` to run both.\n`;
          if (res && typeof res.writeHead === 'function' && !res.headersSent) {
            res.writeHead(502, {
              'Content-Type': 'text/plain',
              'x-panoptic-proxy': 'backend-unreachable',
            });
            res.end(body);
          } else if (res && typeof res.destroy === 'function') {
            res.destroy(err);
          }
        });
      },
    };
  }

  return entries;
}
