/**
 * PANOPTIC collector registry.
 *
 * A collector is one backend responsibility — a route, the state it owns, and
 * the handler that serves it — described independently of whatever HTTP host
 * happens to mount it. Nothing in this module imports Vite.
 *
 * Two ways in, one contract:
 *   • `mount(app, surface)` for connect-style hosts that route themselves —
 *     the Vite dev and preview servers.
 *   • `dispatch(req, res, surface)` for hosts that do not route at all, such as
 *     a bare `node:http` server.
 *
 * Both guarantee the collector the same thing: **`req.url` is relative to the
 * collector's own route**, so `/api/celestrak/stations` reaches the handler as
 * `/stations`. Connect provides that by rewriting `req.url` when it matches a
 * mount path; `dispatch` reproduces it deliberately. That guarantee is the
 * runtime's, not any one host's — a collector must never have to ask which
 * server it is running under.
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
 * Match a request path against a collector route on a path-segment boundary.
 *
 * `/api/celestrak/stations` matches `/api/celestrak` and yields `/stations`;
 * `/api/celestrak` itself yields `/`. `/api/celestrakfoo` does NOT match — a
 * bare `startsWith` would wrongly claim it, which is the classic prefix-routing
 * bug Connect avoids and any hand-rolled router has to avoid too.
 *
 * @param {string} pathname - Request path, query string already removed.
 * @param {string} route - Collector mount path.
 * @returns {string|null} Route-relative path, or `null` when the route does not match.
 */
export function routeRemainder(pathname, route) {
  const base = route.endsWith('/') ? route.slice(0, -1) : route;
  if (pathname === base) return '/';
  if (pathname.startsWith(base) && pathname[base.length] === '/') return pathname.slice(base.length);
  return null;
}

/**
 * Instantiate a set of collectors once, ready to mount onto one or more hosts.
 *
 * Context is built here rather than per mount so a collector's caches and
 * in-flight maps are shared across every host in the process — matching the
 * plugin factories in `vite.config.js`, which close over their state once.
 *
 * Each collector is handed ONLY its own configuration slice — `config.collectors[id]`
 * — never the whole tree and never `process.env`. A misconfigured collector can
 * therefore affect only itself, and a test can build a context by passing one
 * small object.
 *
 * @param {readonly Collector[]} collectors - Collectors to instantiate.
 * @param {object} [options] - Runtime options.
 * @param {object} [options.config] - Loaded PANOPTIC configuration.
 * @returns {{mount: Function, dispatch: Function, routes: Function}} Runtime handle.
 */
export function createRuntime(collectors, { config = null } = {}) {
  const instances = collectors.map((collector) => ({
    collector,
    context: collector.createContext({ config: config?.collectors?.[collector.id] ?? {} }),
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

    /**
     * Route one request to the collector that owns it, for hosts with no
     * routing of their own (a bare `node:http` server).
     *
     * Normalizes `req.url` to the collector's route-relative form for the
     * duration of the call and restores it afterwards — including when the
     * handler throws — so the request object a host later inspects (for logging
     * or an error path) still describes the URL that actually arrived.
     *
     * @param {import('node:http').IncomingMessage} req - Incoming request.
     * @param {import('node:http').ServerResponse} res - Response.
     * @param {string} surface - One of {@link SURFACES}.
     * @returns {Promise<boolean>} `true` when a collector handled the request.
     */
    async dispatch(req, res, surface) {
      if (!SURFACES.includes(surface)) throw new TypeError(`unknown surface ${surface}`);
      const original = String(req.url || '');
      const queryAt = original.indexOf('?');
      const pathname = queryAt === -1 ? original : original.slice(0, queryAt);
      const search = queryAt === -1 ? '' : original.slice(queryAt);

      for (const { collector, context } of instances) {
        if (!collector.surfaces.includes(surface)) continue;
        const remainder = routeRemainder(pathname, collector.route);
        if (remainder === null) continue;
        // The query string rides along, exactly as Connect leaves it.
        req.url = remainder + search;
        try {
          await collector.handler(req, res, context);
        } finally {
          req.url = original;
        }
        return true;
      }
      return false;
    },

    /**
     * Collectors served on a surface, as `{id, route}` — enough for a health
     * endpoint to report what this process is actually serving.
     *
     * @param {string} surface - One of {@link SURFACES}.
     * @returns {{id: string, route: string}[]} Served collectors.
     */
    routes(surface) {
      return instances
        .filter(({ collector }) => collector.surfaces.includes(surface))
        .map(({ collector }) => ({ id: collector.id, route: collector.route }));
    },
  };
}
