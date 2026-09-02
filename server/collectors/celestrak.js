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
import { BATCH_SCHEMA } from '../contracts/observation/v1.js';
import { deriveObservationId } from '../contracts/observation/identity.js';

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
  // The standalone PANOPTIC server is now the ONE place this route executes.
  // 'dev' is deliberately absent: Vite proxies /api/celestrak here instead of
  // running its own copy. That is not cosmetic — Vite registers plugin
  // middlewares BEFORE server.proxy, so a collector still mounted on 'dev'
  // would silently win every request and the proxy would never fire.
  // 'preview' has never been served and still is not.
  surfaces: ['standalone'],

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

// ---------------------------------------------------------------------------
// Observation v1 normaliser
// ---------------------------------------------------------------------------
// PURE and DELIBERATELY UNWIRED. The handler above must never call this.
//
// The canonical observation is the ORBITAL ELEMENT SET — what CelesTrak
// actually reports. A satellite position is a deterministic SGP4 projection of
// that evidence for a requested instant, not a separate observation: PANOPTIC
// does not observe a new satellite position every second, and saying that it
// does would be a fabrication. `src/data/satellites.js` keeps propagating
// client-side exactly as it does today; nothing here changes that.

/** TLE fixed-column field slices (0-indexed, from the NORAD 2-line format). */
const TLE = Object.freeze({
  catalogNumber: [2, 7],
  classification: [7, 8],
  intlDesignator: [9, 17],
  epochYear: [18, 20],
  epochDay: [20, 32],
  meanMotionDot: [33, 43],
  meanMotionDdot: [44, 52],
  bstar: [53, 61],
  elementSetNumber: [64, 68],
  inclination: [8, 16],
  raan: [17, 25],
  eccentricity: [26, 33],
  argPerigee: [34, 42],
  meanAnomaly: [43, 51],
  meanMotion: [52, 63],
  revAtEpoch: [63, 68],
});

const tleField = (line, span) => line.slice(span[0], span[1]).trim();

/**
 * Decode a TLE implied-decimal exponent field: ` 79223-4` → 0.79223e-4,
 * `-60455-3` → -0.60455e-3, ` 00000+0` → 0.
 *
 * The leading decimal point is implied and the exponent sign is mandatory —
 * getting this wrong silently scales BSTAR by orders of magnitude.
 *
 * @param {string} raw - Raw field text.
 * @returns {number} Decoded value.
 */
export function decodeTleExponent(raw) {
  const text = String(raw).trim();
  if (!text) return 0;
  const match = /^([+-]?)(\d+)([+-]\d+)$/.exec(text);
  if (!match) return Number.NaN;
  const [, sign, digits, exponent] = match;
  const mantissa = Number(`0.${digits}`);
  return (sign === '-' ? -mantissa : mantissa) * (10 ** Number(exponent));
}

/**
 * Decode a TLE epoch (`26244.49851261`) to epoch milliseconds.
 *
 * Two-digit year follows the NORAD convention: 57–99 → 1957–1999 (Sputnik
 * onward), 00–56 → 2000–2056. Day-of-year is 1-based with a fractional day.
 *
 * @param {string} yearField - Two-digit year.
 * @param {string} dayField - Fractional day of year.
 * @returns {number} Epoch ms, or NaN.
 */
export function decodeTleEpoch(yearField, dayField) {
  const yy = Number(yearField);
  const day = Number(dayField);
  if (!Number.isFinite(yy) || !Number.isFinite(day)) return Number.NaN;
  const year = yy < 57 ? 2000 + yy : 1900 + yy;
  return Math.round(Date.UTC(year, 0, 1) + (day - 1) * 86_400_000);
}

/**
 * Parse a CelesTrak GP/TLE body into element-set records.
 *
 * Handles the 3-line (named) form CelesTrak serves. Lines arrive CRLF
 * terminated, so trailing whitespace is stripped before fixed-column slicing.
 *
 * @param {string} body - TLE text.
 * @returns {object[]} Element-set records.
 */
export function parseTleBody(body) {
  const lines = String(body ?? '').split('\n').map((line) => line.replace(/\s+$/, ''));
  const records = [];

  for (let i = 0; i < lines.length - 1; i += 1) {
    if (!lines[i].startsWith('1 ') || !lines[i + 1]?.startsWith('2 ')) continue;
    const line1 = lines[i];
    const line2 = lines[i + 1];
    // The optional name line precedes line 1 in the 3-line form.
    const previous = i > 0 ? lines[i - 1] : '';
    const name = previous && !previous.startsWith('1 ') && !previous.startsWith('2 ')
      ? previous.trim()
      : '';

    const catalogNumber = tleField(line1, TLE.catalogNumber);
    if (!catalogNumber) continue;

    const designator = tleField(line1, TLE.intlDesignator);
    records.push({
      catalogNumber,
      name,
      classification: tleField(line1, TLE.classification),
      // Absent for a few older objects — omitted rather than invented.
      intlDesignator: designator || undefined,
      observedAt: decodeTleEpoch(tleField(line1, TLE.epochYear), tleField(line1, TLE.epochDay)),
      elementSetNumber: Number(tleField(line1, TLE.elementSetNumber)),
      meanMotionDot: Number(tleField(line1, TLE.meanMotionDot)),
      meanMotionDdot: decodeTleExponent(tleField(line1, TLE.meanMotionDdot)),
      bstar: decodeTleExponent(tleField(line1, TLE.bstar)),
      inclinationDeg: Number(tleField(line2, TLE.inclination)),
      raanDeg: Number(tleField(line2, TLE.raan)),
      // Eccentricity carries an implied leading decimal point.
      eccentricity: Number(`0.${tleField(line2, TLE.eccentricity)}`),
      argPerigeeDeg: Number(tleField(line2, TLE.argPerigee)),
      meanAnomalyDeg: Number(tleField(line2, TLE.meanAnomaly)),
      meanMotion: Number(tleField(line2, TLE.meanMotion)),
      revAtEpoch: Number(tleField(line2, TLE.revAtEpoch)),
    });
    i += 1;
  }
  return records;
}

/**
 * Convert a CelesTrak cache entry into an Observation v1 batch.
 *
 * `observedAt` is the TLE EPOCH — the instant the element set describes — not
 * ingest time and not "now". That is the correct replay coordinate and the
 * correct answer to "when was this true".
 *
 * Emits NO geometry: `space.orbital_elements` declares
 * `GEOMETRY_POLICY.PROHIBITED`, and the validator rejects any observation of
 * this type carrying one.
 *
 * @param {{at: number, body: string}} entry - Cache entry.
 * @param {object} [options] - Options.
 * @param {string} [options.feed] - CelesTrak group, e.g. `stations`.
 * @returns {object} A `panoptic.observationBatch.v1` batch.
 */
export function toObservations(entry, { feed = null } = {}) {
  const source = feed ? { id: 'celestrak', feed } : { id: 'celestrak' };
  const ingestedAt = Number(entry?.at);
  const observations = [];

  for (const record of parseTleBody(entry?.body)) {
    if (!Number.isFinite(record.observedAt)) continue;

    // CelesTrak zero-pads catalogue numbers to five characters ('01361'). The
    // canonical form of a catalogue number is the number, so it is unpadded
    // here: otherwise a source that reports '1361' would split the lineage of
    // the same object in two.
    const noradId = Number(record.catalogNumber);
    const observation = {
      observationType: 'space.orbital_elements',
      observedAt: record.observedAt,
      sourceRecordId: String(noradId),
      entityRef: {
        keys: record.intlDesignator
          ? { noradId, intlDesignator: record.intlDesignator }
          : { noradId },
      },
      properties: {
        name: record.name,
        classification: record.classification,
        elementSetNumber: record.elementSetNumber,
        inclinationDeg: record.inclinationDeg,
        raanDeg: record.raanDeg,
        eccentricity: record.eccentricity,
        argPerigeeDeg: record.argPerigeeDeg,
        meanAnomalyDeg: record.meanAnomalyDeg,
        meanMotion: record.meanMotion,
        meanMotionDot: record.meanMotionDot,
        meanMotionDdot: record.meanMotionDdot,
        bstar: record.bstar,
        revAtEpoch: record.revAtEpoch,
      },
    };
    if (feed) observation.classification = { scheme: 'celestrak.group', value: feed };
    observation.observationId = deriveObservationId(observation, source);
    observations.push(observation);
  }

  return {
    schema: BATCH_SCHEMA,
    source,
    observationType: 'space.orbital_elements',
    ingestedAt,
    derivation: [
      { method: 'source_reported', by: 'celestrak' },
      { method: 'ingested', by: 'panoptic.collector.celestrak', at: ingestedAt },
    ],
    observations,
  };
}
