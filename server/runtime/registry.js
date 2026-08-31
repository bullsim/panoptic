/**
 * PANOPTIC collector registry.
 *
 * A collector is one backend responsibility — a route, the state it owns, and
 * the handler that serves it — described independently of whatever HTTP host
 * happens to mount it. Nothing in this module imports Vite: mounting needs only
 * a connect-style `use(route, handler)`, which the Vite dev server, the Vite
 * preview server, and a future standalone PANOPTIC Node server all provide.
 *
 * `surfaces` is what keeps that generality honest. Each collector names the
 * hosts it is currently mounted on, so migrating a collector out of
 * `vite.config.js` cannot silently expose it somewhere it was not served
 * before. The proxies in `vite.config.js` differ on exactly this point today
 * (nine register a preview server, ten do not).
 *
 * @module server/runtime/registry
 */

/** Hosts a collector can be mounted on. */
export const SURFACES = Object.freeze(['dev', 'preview', 'standalone']);

/**
 * @typedef {object} CollectorContext
 * Per-process state and injected dependencies handed to every handler call.
 */

/**
 * @typedef {object} Collector
 * @property {string} id - Stable identifier, also the log label.
 * @property {string} route - Mount path, e.g. `/api/celestrak`.
 * @property {readonly string[]} surfaces - Hosts this collector is mounted on.
 * @property {(overrides?: object) => CollectorContext} createContext - Build per-process state.
 * @property {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, ctx: CollectorContext) => Promise<void>} handler
 */

/**
 * Validate and freeze a collector definition.
 *
 * @param {object} spec - Collector definition.
 * @returns {Collector} Frozen collector.
 */
export function defineCollector(spec) {
  const { id, route, surfaces, createContext, handler } = spec || {};
  if (!id || typeof id !== 'string') throw new TypeError('collector requires a string id');
  if (typeof route !== 'string' || !route.startsWith('/')) {
    throw new TypeError(`collector ${id}: route must be an absolute path`);
  }
  if (!Array.isArray(surfaces) || surfaces.length === 0) {
    throw new TypeError(`collector ${id}: surfaces must be a non-empty array`);
  }
  const unknown = surfaces.filter((surface) => !SURFACES.includes(surface));
  if (unknown.length) throw new TypeError(`collector ${id}: unknown surfaces ${unknown.join(', ')}`);
  if (typeof createContext !== 'function') throw new TypeError(`collector ${id}: createContext must be a function`);
  if (typeof handler !== 'function') throw new TypeError(`collector ${id}: handler must be a function`);
  return Object.freeze({ id, route, surfaces: Object.freeze([...surfaces]), createContext, handler });
}

/**
 * Instantiate a set of collectors once, ready to mount onto one or more hosts.
 *
 * Context is built here rather than per mount so a collector's caches and
 * in-flight maps are shared across every host in the process — matching the
 * plugin factories in `vite.config.js`, which close over their state once.
 *
 * @param {readonly Collector[]} collectors - Collectors to instantiate.
 * @returns {{mount: (app: {use: Function}, surface: string) => string[]}} Runtime handle.
 */
export function createRuntime(collectors) {
  const instances = collectors.map((collector) => ({
    collector,
    context: collector.createContext(),
  }));

  return {
    /**
     * Mount every collector that opts into `surface` onto a connect-style app.
     *
     * @param {{use: Function}} app - Host exposing `use(route, handler)`.
     * @param {string} surface - One of {@link SURFACES}.
     * @returns {string[]} Ids actually mounted.
     */
    mount(app, surface) {
      if (!SURFACES.includes(surface)) throw new TypeError(`unknown surface ${surface}`);
      const mounted = [];
      for (const { collector, context } of instances) {
        if (!collector.surfaces.includes(surface)) continue;
        app.use(collector.route, (req, res) => collector.handler(req, res, context));
        mounted.push(collector.id);
      }
      return mounted;
    },
  };
}
