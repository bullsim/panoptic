/**
 * Two-tier (memory + disk) TTL cache with single-flight refresh.
 *
 * Lifted verbatim in behaviour from the CelesTrak proxy that lived in
 * `vite.config.js`. Several other collectors in that file repeat the same
 * shape, but this module is intentionally scoped to what CelesTrak needs now —
 * it grows when a second collector is migrated onto it, not before.
 *
 * Entries are plain JSON objects carrying an `at` epoch-ms stamp; everything
 * else about their shape is the caller's business, checked by `validate` when
 * an entry is read back from disk.
 *
 * @module server/runtime/cache
 */

import { promises as fsp } from 'node:fs';
import path from 'node:path';

/**
 * @typedef {object} TtlCacheEntry
 * @property {number} at - Epoch-ms the entry was produced.
 */

/**
 * Build a memory + disk cache keyed by an arbitrary string.
 *
 * @param {object} options - Cache configuration.
 * @param {string} options.dir - Directory holding the disk tier.
 * @param {(key: string) => string} options.fileName - Disk file name for a key.
 * @param {number} options.ttlMs - Freshness window in milliseconds.
 * @param {(entry: unknown) => boolean} options.validate - Guard for entries read from disk.
 * @param {string} options.label - Log prefix, e.g. `celestrak-proxy`.
 * @param {Pick<Console,'warn'>} [options.log] - Log sink (injectable for tests).
 * @returns {{read: (key: string) => Promise<TtlCacheEntry|null>, isFresh: (entry: TtlCacheEntry|null, now: number) => boolean, refresh: (key: string, loader: (key: string) => Promise<TtlCacheEntry>) => Promise<TtlCacheEntry|null>}}
 */
export function createTtlCache({ dir, fileName, ttlMs, validate, label, log = console }) {
  /** @type {Map<string, TtlCacheEntry>} key -> entry */
  const mem = new Map();
  /** @type {Map<string, Promise<TtlCacheEntry|null>>} key -> in-flight refresh */
  const inflight = new Map();

  const diskPath = (key) => path.join(dir, fileName(key));

  async function readDisk(key) {
    try {
      const parsed = JSON.parse(await fsp.readFile(diskPath(key), 'utf8'));
      if (validate(parsed)) return parsed;
    } catch { /* no disk cache yet */ }
    return null;
  }

  async function writeDisk(key, entry) {
    try {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(diskPath(key), JSON.stringify(entry), 'utf8');
    } catch (err) {
      log.warn(`[${label}] cache write failed for ${key}:`, err?.message || err);
    }
  }

  return {
    /** Newest known entry for a key — memory first, then promoting from disk. */
    async read(key) {
      let entry = mem.get(key);
      if (!entry) {
        entry = await readDisk(key);
        if (entry) mem.set(key, entry);
      }
      return entry || null;
    },

    /** Whether an entry is still inside the TTL window. */
    isFresh(entry, now) {
      return Boolean(entry) && now - entry.at < ttlMs;
    },

    /**
     * Refresh a key through `loader`, coalescing concurrent callers.
     * Resolves to the fresh entry, or `null` when the loader failed — leaving
     * any stale entry intact for the caller to serve instead.
     */
    async refresh(key, loader) {
      if (!inflight.has(key)) {
        inflight.set(key, loader(key)
          .then(async (fresh) => {
            mem.set(key, fresh);
            await writeDisk(key, fresh);
            return fresh;
          })
          .catch((err) => {
            log.warn(`[${label}] ${key} refresh failed (${err?.message || err}) — serving cache if any`);
            return null;
          })
          .finally(() => inflight.delete(key)));
      }
      return inflight.get(key);
    },
  };
}
