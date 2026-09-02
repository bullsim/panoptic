/**
 * NASA FIRMS live active-fire collector — `/api/firms`.
 *
 * Merges three VIIRS NRT sources (NOAA-20, NOAA-21, Suomi-NPP — independent
 * satellites, no cross-source dedup) fetched SEQUENTIALLY with `days=2`
 * (`days=1` means "current UTC day", nearly empty just after 00:00Z) and clamps
 * to the trailing 24 h via `src/data/firmsCsv.js`.
 *
 * FIRMS quota is 5,000 transactions / 10 min per MAP_KEY, so the cache is the
 * point: TTL 30 min, single-flight refresh, serve-stale-on-failure, and a
 * fresh-enough disk cache (`.gev-cache/firms.json`) prevents ANY upstream fetch
 * across server restarts.
 *
 * Routes:
 *   GET /api/firms        → {fetchedAt, stale, ttlMs, sources, count, fires}
 *   GET /api/firms/status → {hasKey, lastFetch, count, stale, ttlMs, transactions}
 *
 * Keyless (no FIRMS_MAP_KEY): /api/firms → 503 {error:'no_key'}; status → 200
 * {hasKey:false, …}. Upstream is never touched without a key. That keyless
 * state is a SPECIFIED product state (the layer reads KEY REQUIRED), not a
 * misconfiguration — which is why a missing key degrades this collector rather
 * than failing PANOPTIC startup.
 *
 * `/api/firms/status` deliberately keeps returning 200 when keyless: it is a
 * capability probe, and QA reads `hasKey` from it. Service-level configuration
 * health is a separate question, answered by `/health`.
 *
 * SECRET HANDLING: the key arrives as a `secret()` box on `ctx.config.mapKey`
 * and is unwrapped in exactly two places — `firmsCsvUrl` and `firmsStatusUrl`.
 * Those URLs carry the key in the path / query string and must never be logged,
 * stored, or echoed into an error.
 *
 * Migrated out of `vite.config.js` — same routes, same status codes, same
 * bodies, same headers, same TTLs, same disk path.
 *
 * @module server/collectors/firms
 */

import path from 'node:path';
import { filterTrailing24h, parseFirmsCsv } from '../../src/data/firmsCsv.js';
import { createTtlCache } from '../runtime/cache.js';
import { defineCollector } from '../runtime/registry.js';
import { sendJson } from '../runtime/http.js';

/** Freshness window for the merged fire set. */
const TTL_MS = 30 * 60_000;
/** Freshness window for the mapkey_status transaction memo. */
const STATUS_TTL_MS = 5 * 60_000;
/** The three VIIRS NRT sources, fetched in this order, one at a time. */
const SOURCES = Object.freeze(['VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'VIIRS_SNPP_NRT']);
/** Upstream budgets, unchanged from the proxy this replaced. */
const FETCH_TIMEOUT_MS = 60_000;
const STATUS_TIMEOUT_MS = 10_000;

/** Disk tier location — unchanged from the `vite.config.js` implementation. */
const CACHE_DIR = () => path.join(process.cwd(), '.gev-cache');

/** The single cache key. FIRMS holds one world-wide entry, not a keyed set. */
const CACHE_KEY = 'world';

/** A usable cache entry: a stamped set of sources and fires. */
const validEntry = (parsed) => Number.isFinite(parsed?.at)
  && Array.isArray(parsed?.sources)
  && Array.isArray(parsed?.fires);

/**
 * Upstream CSV URL for one source.
 *
 * ONE OF TWO PLACES the FIRMS key is unwrapped. The result embeds the key in
 * its PATH — never log it, never put it in an error, never store it.
 *
 * @param {{reveal: () => string}} mapKey - Boxed FIRMS key.
 * @param {string} source - VIIRS source id.
 * @returns {string} Secret-bearing URL.
 */
function firmsCsvUrl(mapKey, source) {
  return `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${encodeURIComponent(mapKey.reveal())}/${source}/world/2`;
}

/**
 * Upstream quota-status URL.
 *
 * THE OTHER PLACE the key is unwrapped. Embeds it in the QUERY STRING — same
 * rules apply.
 *
 * @param {{reveal: () => string}} mapKey - Boxed FIRMS key.
 * @returns {string} Secret-bearing URL.
 */
function firmsStatusUrl(mapKey) {
  return `https://firms.modaps.eosdis.nasa.gov/mapserver/mapkey_status/?MAP_KEY=${encodeURIComponent(mapKey.reveal())}`;
}

/**
 * Cache entry → response payload.
 *
 * Fires are RE-FILTERED to the trailing 24 h at serve time, so a stale cache
 * can never serve detections older than a day.
 *
 * @param {object} entry - Cache entry.
 * @param {boolean} stale - Whether the entry is past its TTL.
 * @param {number} now - Current epoch-ms.
 * @returns {object} Response payload.
 */
function buildPayload(entry, stale, now) {
  const fires = filterTrailing24h(entry.fires, now);
  return {
    fetchedAt: entry.at,
    stale,
    ttlMs: TTL_MS,
    sources: entry.sources,
    count: fires.length,
    fires,
  };
}

export default defineCollector({
  id: 'firms',
  route: '/api/firms',
  // The standalone PANOPTIC server is the ONE place this route executes. Vite
  // proxies /api/firms here instead of running its own copy — and it must not
  // be on 'dev', because Vite registers plugin middlewares BEFORE server.proxy,
  // so a collector left there would silently win and the proxy would never
  // fire. 'preview' has never served FIRMS and still does not.
  surfaces: ['standalone'],

  /**
   * Per-process state and injected dependencies.
   *
   * @param {object} [overrides] - Test seams: `config`, `fetchImpl`, `now`, `log`, `cacheDir`.
   * @returns {object} Collector context.
   */
  createContext(overrides = {}) {
    const {
      log = console,
      cacheDir = CACHE_DIR(),
      config = {},
      ...rest
    } = overrides;
    return {
      // Only this collector's slice: { configuration, mapKey }, injected by the
      // runtime. The collector never reads the process environment itself.
      config,
      cache: createTtlCache({
        dir: cacheDir,
        fileName: () => 'firms.json',
        ttlMs: TTL_MS,
        validate: validEntry,
        label: 'firms-proxy',
        log,
      }),
      // mapkey_status telemetry is deliberately memory-only: it is quota state,
      // not data, and persisting it across restarts would report stale usage.
      status: { at: 0, transactions: null, seeded: false, inflight: null },
      fetchImpl: (...args) => fetch(...args),
      now: () => Date.now(),
      log,
      ...rest,
    };
  },

  async handler(req, res, ctx) {
    const send = (status, body) => {
      sendJson(res, status, body, { 'Cache-Control': 'no-store' });
    };

    try {
      // The runtime guarantees req.url is route-relative, so this is the exact
      // expression the Vite middleware used: '/' for the feed, '/status' for
      // the probe. Anything else falls through to the feed, as before.
      const subPath = String(req.url || '').split('?')[0];
      const mapKey = ctx.config?.mapKey ?? null;
      const hasKey = Boolean(mapKey);
      const entry = await ctx.cache.read(CACHE_KEY);

      // --- /status -----------------------------------------------------------
      // Always 200, keyed or not: this is a capability probe, and QA reads
      // hasKey from it. Service configuration health lives at /health.
      if (subPath === '/status') {
        if (!hasKey) {
          send(200, {
            hasKey: false,
            lastFetch: null,
            count: null,
            stale: false,
            ttlMs: TTL_MS,
            transactions: null,
          });
          return;
        }
        const now = ctx.now();
        send(200, {
          hasKey: true,
          lastFetch: entry ? entry.at : null,
          count: entry ? entry.fires.length : null,
          stale: entry ? now - entry.at >= TTL_MS : false,
          ttlMs: TTL_MS,
          transactions: await transactions(ctx, mapKey),
        });
        return;
      }

      // --- main feed ---------------------------------------------------------
      if (!hasKey) {
        send(503, { error: 'no_key' });
        return;
      }

      const now = ctx.now();
      if (ctx.cache.isFresh(entry, now)) {
        send(200, buildPayload(entry, false, now));
        return;
      }

      // Stale or missing → refresh, single-flight (concurrent requests share
      // one upstream pass).
      const fresh = await ctx.cache.refresh(CACHE_KEY, () => refreshUpstream(ctx, mapKey));
      if (fresh) {
        send(200, buildPayload(fresh, false, ctx.now()));
      } else if (entry) {
        send(200, buildPayload(entry, true, ctx.now())); // upstream down — stale beats empty
      } else {
        send(502, { error: 'firms fetch failed and no cache available' });
      }
    } catch (err) {
      // err carries a status code or a short reason, never a URL.
      ctx.log.warn('[firms-proxy] error:', err?.message || err);
      send(500, { error: 'firms proxy error' });
    }
  },
});

/**
 * Fetch and parse one FIRMS source.
 *
 * Throws on HTTP error or a non-CSV body (FIRMS reports errors as HTML/plain
 * text, never CSV). The thrown message carries a status code or a short reason
 * and NEVER the URL, which embeds the key.
 *
 * @param {object} ctx - Collector context.
 * @param {{reveal: () => string}} mapKey - Boxed FIRMS key.
 * @param {string} source - VIIRS source id.
 * @returns {Promise<object[]>} Parsed records.
 */
async function fetchSource(ctx, mapKey, source) {
  const upstream = await ctx.fetchImpl(firmsCsvUrl(mapKey, source), {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
  const records = parseFirmsCsv(await upstream.text());
  if (records === null) throw new Error('non-CSV upstream response');
  return records;
}

/**
 * Refresh all sources sequentially (quota courtesy — never in parallel).
 *
 * Partial success (≥1 source ok) still produces a cacheable entry with the
 * failed sources marked `ok:false`; total failure throws so the caller can
 * serve stale.
 *
 * @param {object} ctx - Collector context.
 * @param {{reveal: () => string}} mapKey - Boxed FIRMS key.
 * @returns {Promise<{at: number, sources: object[], fires: object[]}>} Cache entry.
 */
async function refreshUpstream(ctx, mapKey) {
  const now = ctx.now();
  const sources = [];
  const fires = [];
  for (const source of SOURCES) {
    try {
      const records = filterTrailing24h(await fetchSource(ctx, mapKey, source), now);
      sources.push({ source, count: records.length, ok: true });
      fires.push(...records);
    } catch (err) {
      ctx.log.warn(`[firms-proxy] ${source} fetch failed:`, err?.message || err);
      sources.push({ source, count: 0, ok: false });
    }
  }
  if (!sources.some((s) => s.ok)) throw new Error('all FIRMS sources failed');
  return { at: now, sources, fires };
}

/**
 * mapkey_status transactions, memoised 5 minutes, best-effort.
 *
 * Memory-only by design — quota usage is live state, and persisting it would
 * report yesterday's numbers after a restart. Resolves to `{used, limit}` or
 * `null`; a failure is logged without the URL and never propagates.
 *
 * @param {object} ctx - Collector context.
 * @param {{reveal: () => string}} mapKey - Boxed FIRMS key.
 * @returns {Promise<?{used: number, limit: number}>} Transaction telemetry.
 */
function transactions(ctx, mapKey) {
  const now = ctx.now();
  const memo = ctx.status;
  if (memo.seeded && now - memo.at < STATUS_TTL_MS) return Promise.resolve(memo.transactions);
  if (!memo.inflight) {
    memo.inflight = (async () => {
      try {
        const upstream = await ctx.fetchImpl(firmsStatusUrl(mapKey), {
          signal: AbortSignal.timeout(STATUS_TIMEOUT_MS),
        });
        if (!upstream.ok) throw new Error(`HTTP ${upstream.status}`);
        const body = await upstream.json();
        const used = Number(body?.current_transactions);
        const limit = Number(body?.transaction_limit);
        return Number.isFinite(used) && Number.isFinite(limit) ? { used, limit } : null;
      } catch (err) {
        ctx.log.warn('[firms-proxy] mapkey status failed:', err?.message || err);
        return null;
      }
    })()
      .then((result) => {
        memo.at = ctx.now();
        memo.transactions = result;
        memo.seeded = true;
        return result;
      })
      .finally(() => { memo.inflight = null; });
  }
  return memo.inflight;
}
