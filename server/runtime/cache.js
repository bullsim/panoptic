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
import { randomUUID } from 'node:crypto';
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

  /**
   * Write the entry to a private temporary file, then rename it into place.
   *
   * `rename` within a directory is atomic on POSIX and on Windows (NTFS), so a
   * concurrent reader sees either the previous file or the complete new one,
   * never a half-written body. A plain `writeFile` truncates first and can be
   * read mid-write — reachable now that a Vite dev server and a standalone
   * PANOPTIC server can share `.gev-cache/` at the same time.
   *
   * The temporary name carries a UUID, so two processes (or two keys racing in
   * one process) can never collide on the same scratch path. It lives in the
   * destination directory because `rename` cannot cross filesystems.
   */
  async function writeDisk(key, entry) {
    const destination = diskPath(key);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(temporary, JSON.stringify(entry), 'utf8');
      await fsp.rename(temporary, destination);
    } catch (err) {
      // Leaving a scratch file behind would leak one per failed write; the
      // cleanup is best-effort because the failure may be the write itself.
      await fsp.rm(temporary, { force: true }).catch(() => {});
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
