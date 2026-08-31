/**
 * CelesTrak GP/TLE collector — `/api/celestrak/<group>`.
 *
 * CelesTrak does not send CORS headers, so this collector fetches satellite TLE
 * data server-side and forwards it to the browser.
 * Upstream: https://celestrak.org/NORAD/elements/gp.php?GROUP=<group>&FORMAT=tle
 *
 * CelesTrak asks clients not to re-fetch GP data more than ~every 2 h and
 * throttles offenders; every dev reload used to refetch every group. Cache TTL
 * 6 h; on upstream failure the freshest stale copy is served (a stale TLE beats
 * an empty satellites layer). Adapted from skylight's TleStore (MIT).
 *
 * Migrated out of `vite.config.js` unchanged — same route, same `x-tle-cache`
 * values, same `.gev-cache/celestrak-<group>.json` disk layout, same TTL.
 *
 * @module server/collectors/celestrak
 */

import path from 'node:path';
import { createTtlCache } from '../runtime/cache.js';
import { defineCollector } from '../runtime/registry.js';
import { routePath, sendText } from '../runtime/http.js';

/** Freshness window for a cached TLE group. */
const TLE_TTL_MS = 6 * 3600_000;

/** Groups are forwarded straight into the upstream query — keep them boring. */
const GROUP_RE = /^[a-z0-9-]+$/i;

/** Upstream request timeout (ms). */
const FETCH_TIMEOUT_MS = 20000;

/**
 * CelesTrak 403s bulk groups (e.g. `active`) unless the request carries a
 * descriptive User-Agent with a contact point. This string is a live
 * compatibility constraint with a third party, not product branding — it is
 * deliberately unchanged by the PANOPTIC fork.
 */
const USER_AGENT = 'gods-eye-view-celestrak-proxy/1.0 (+https://github.com/bilawalsidhu/gods-eye-view)';

/** Disk tier location — unchanged from the `vite.config.js` implementation. */
const CACHE_DIR = () => path.join(process.cwd(), '.gev-cache');

/** A usable cache entry: a TLE body with an epoch-ms stamp. */
const validEntry = (parsed) => typeof parsed?.body === 'string' && Number.isFinite(parsed?.at);

export default defineCollector({
  id: 'celestrak',
  route: '/api/celestrak',
  // Matches today's registration exactly: the plugin this replaced installed a
  // dev-server middleware only. Adding 'preview'/'standalone' here is how the
  // next stage widens it — a deliberate change, not a side effect of the move.
  surfaces: ['dev'],

  /**
   * Per-process state and injected dependencies.
   *
   * @param {object} [overrides] - Test seams: `fetchImpl`, `now`, `log`, `cacheDir`.
   * @returns {{cache: ReturnType<typeof createTtlCache>, fetchImpl: typeof fetch, now: () => number}}
   */
  createContext(overrides = {}) {
    const { log = console, cacheDir = CACHE_DIR(), ...rest } = overrides;
    return {
      cache: createTtlCache({
        dir: cacheDir,
        fileName: (group) => `celestrak-${group}.json`,
        ttlMs: TLE_TTL_MS,
        validate: validEntry,
        label: 'celestrak-proxy',
        log,
      }),
      fetchImpl: (...args) => fetch(...args),
      now: () => Date.now(),
      ...rest,
    };
  },

  async handler(req, res, ctx) {
    const group = routePath(req);
    if (!GROUP_RE.test(group)) {
      // Note: no x-tle-cache header on this path, as before — a rejected group
      // never consulted the cache.
      sendText(res, 400, 'invalid group');
      return;
    }

    const send = (status, body, cacheStatus) => {
      sendText(res, status, body, { 'x-tle-cache': cacheStatus });
    };

    const fetchUpstream = async () => {
      const url = new URL('https://celestrak.org/NORAD/elements/gp.php');
      url.searchParams.set('GROUP', group);
      url.searchParams.set('FORMAT', 'tle');
      const upstream = await ctx.fetchImpl(url.toString(), {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'User-Agent': USER_AGENT },
      });
      if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
      const body = await upstream.text();
      // An upstream error page parses to zero TLEs — treat as failure, keep cache.
      if (!/^1 /m.test(body)) throw new Error('no TLE lines in response');
      return { at: ctx.now(), body };
    };

    try {
      const now = ctx.now();
      const entry = await ctx.cache.read(group);
      if (ctx.cache.isFresh(entry, now)) {
        send(200, entry.body, 'HIT');
        return;
      }
      // Stale or missing → refresh, single-flight per group.
      const fresh = await ctx.cache.refresh(group, fetchUpstream);
      if (fresh) {
        send(200, fresh.body, 'MISS');
      } else if (entry) {
        send(200, entry.body, 'STALE-ERROR'); // upstream down — stale beats empty
      } else {
        send(502, 'celestrak fetch failed and no cache available', 'NONE');
      }
    } catch (err) {
      send(500, `celestrak proxy error: ${err?.message || err}`, 'ERROR');
    }
  },
});
