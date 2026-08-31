/**
 * PANOPTIC backend entry point.
 *
 * Owns the list of migrated collectors and adapts them to Vite's plugin API.
 * This is the only file in `server/` that knows Vite exists; the registry and
 * the collectors themselves are host-agnostic, so the same list can later be
 * mounted onto a standalone PANOPTIC Node server without being rewritten.
 *
 * Collectors are migrated out of `vite.config.js` one at a time. Each migration
 * removes one entry from that file's `plugins` array and adds one import here.
 *
 * @module server/index
 */

import celestrak from './collectors/celestrak.js';
import { createRuntime } from './runtime/registry.js';

/** Collectors migrated out of `vite.config.js` so far. */
export const COLLECTORS = Object.freeze([celestrak]);

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
