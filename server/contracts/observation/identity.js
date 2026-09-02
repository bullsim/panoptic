/**
 * Deterministic observation identity.
 *
 * Three identities are kept apart on purpose:
 *
 *   sourceRecordId  WHICH THING the source is describing. Stable across
 *                   revisions. Optional — many sources issue none.
 *   observationId   WHICH VERSION of that description this is. Changes when
 *                   identity-bearing content changes.
 *   lineageKey      Which versions belong to the same record, so a consumer can
 *                   order them and compute supersession.
 *
 * The whole point is that identical input yields an identical id — that is what
 * makes ingestion idempotent, replay safe, and duplicate delivery a no-op —
 * while a materially revised source record yields a DIFFERENT id.
 *
 * Two properties this file exists to guarantee:
 *
 *   1. NO ARBITRARY JSON IS HASHED. Identity inputs are an explicit, ordered
 *      allowlist declared per observation type. Hashing a payload would make
 *      every id hostage to property insertion order, float formatting, and any
 *      incidental metadata a source adds later.
 *   2. THE ENCODING IS INJECTIVE. Fields are length-prefixed, so no two
 *      distinct field sequences can ever produce the same string. A plain
 *      separator cannot promise that: a value containing the separator would
 *      forge a different sequence.
 *
 * ---------------------------------------------------------------------------
 * THE v1 IDENTITY CONTRACT — every clause below is normative
 * ---------------------------------------------------------------------------
 *
 *   1. The hash algorithm is SHA-256.
 *   2. Observation v1 retains the FIRST 128 BITS (first 16 bytes) of that
 *      digest. The truncation length is PART OF THE CONTRACT, not a tuning
 *      parameter.
 *   3. The digest is encoded with the deterministic lowercase RFC 4648 base32
 *      alphabet implemented in `base32Encode` below, without padding.
 *   4. The id is that encoding prefixed with `obs_`.
 *   5. The canonical string is built by `canonicalIdentityString`: an ordered,
 *      length-prefixed encoding of an explicit per-type field allowlist, with
 *      fixed decimal precision per numeric field.
 *
 * CHANGING ANY OF THE FOLLOWING IS AN IDENTITY-BREAKING CONTRACT CHANGE AND
 * REQUIRES A NEW OBSERVATION CONTRACT VERSION (v2), NOT AN EDIT HERE:
 *
 *   • the hash algorithm
 *   • the retained digest length
 *   • the base32 alphabet, case, or padding
 *   • the canonical field encoding or its length-prefix scheme
 *   • the separators
 *   • the numeric precision rules (including -0 and non-finite handling)
 *   • the field ORDER, or the membership of any type's revisionKey/contentKey
 *
 * Every previously derived id would be silently orphaned by such a change, and
 * deduplication and replay would both break without any error. The golden
 * vectors in `src/data/observationContract.test.mjs` pin the canonical strings
 * AND the resulting ids byte-for-byte precisely so this cannot happen quietly.
 *
 * @module server/contracts/observation/identity
 */

import { createHash } from 'node:crypto';
import { OBSERVATION_TYPES } from './v1.js';

/** Id prefix, so an observation id is recognisable on sight. */
const ID_PREFIX = 'obs_';

/**
 * Retained digest length, in bits. PART OF THE v1 IDENTITY CONTRACT.
 *
 * 128 bits of SHA-256. At PANOPTIC's largest observed batch (311,217 FIRMS
 * detections) the birthday collision probability is ~1e-28; even at 1e9
 * observations it is ~1e-21. Keeping all 256 bits would double the id length
 * for no reachable benefit — and at FIRMS scale an id's length is measured in
 * megabytes across a batch.
 *
 * Do NOT widen this to 256 bits in place. It would change every id ever
 * derived; that is a v2.
 */
const ID_BITS = 128;

/** Hash algorithm. PART OF THE v1 IDENTITY CONTRACT — see the module note. */
const ID_HASH = 'sha256';

/** RFC 4648 base32 alphabet, lowercased — case-insensitive and path-safe. */
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/**
 * Encode bytes as lowercase base32 without padding.
 *
 * Chosen over hex (shorter) and base64url (case-insensitive, no `-`/`_`), so an
 * id stays safe in a filename, a URL, and a case-folding store alike.
 *
 * @param {Buffer|Uint8Array} bytes - Bytes to encode.
 * @returns {string} Base32 text.
 */
export function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/**
 * Canonical text for one identity input.
 *
 * Numbers are fixed to a declared number of decimals so `4.2` and `4.20` cannot
 * produce different ids, and so the last bits of a float never ripple into
 * identity. `-0` is normalised to `0`. A non-finite number is an error rather
 * than a silent `"NaN"` — an id built from NaN would be stable nonsense.
 *
 * @param {unknown} value - Raw value.
 * @param {number} [decimals] - Decimal places; omit for text values.
 * @returns {string} Canonical text.
 */
export function canonicalValue(value, decimals) {
  if (value === undefined || value === null) return '';
  if (decimals === undefined) return String(value);
  const num = Number(value);
  if (!Number.isFinite(num)) {
    throw new TypeError(`identity input is not a finite number: ${JSON.stringify(value)}`);
  }
  const fixed = (num === 0 ? 0 : num).toFixed(decimals);
  // toFixed can still yield "-0.00" for small negatives; normalise the sign.
  return /^-0(?:\.0*)?$/.test(fixed) ? fixed.slice(1) : fixed;
}

/**
 * Read a dotted path (`properties.magnitude`, `geometry.coordinates.0`).
 *
 * @param {object} root - Object to read.
 * @param {string} path - Dotted path.
 * @returns {unknown} Value, or undefined.
 */
export function readPath(root, path) {
  let cursor = root;
  for (const segment of path.split('.')) {
    if (cursor === undefined || cursor === null) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

/**
 * Join parts injectively by length-prefixing each one.
 *
 * `["a", "bc"]` → `1:a|2:bc`. Because the leading count says exactly how many
 * characters to consume, no two distinct sequences can collide — including a
 * value that itself contains `:` or `|`. Lengths are UTF-8 byte counts so the
 * encoding is reproducible outside JavaScript.
 *
 * @param {readonly string[]} parts - Ordered parts.
 * @returns {string} Injective encoding.
 */
export function canonicalJoin(parts) {
  return parts.map((part) => `${Buffer.byteLength(part, 'utf8')}:${part}`).join('|');
}

/**
 * Build the ordered identity inputs declared by an allowlist.
 *
 * @param {object} observation - Observation.
 * @param {readonly {path: string, decimals?: number}[]} spec - Ordered allowlist.
 * @returns {string[]} Canonical values, in declared order.
 */
function allowlistValues(observation, spec) {
  return (spec ?? []).map((field) => canonicalValue(readPath(observation, field.path), field.decimals));
}

/**
 * The exact string an observation id is derived from.
 *
 * Exposed so tests can pin it byte-for-byte: a refactor must not be able to
 * change canonical ids silently.
 *
 * @param {object} observation - Observation.
 * @param {{id: string, feed?: string}} source - Batch source.
 * @returns {string} Canonical identity string.
 */
export function canonicalIdentityString(observation, source) {
  const type = observation?.observationType;
  const registered = OBSERVATION_TYPES[type];
  if (!registered) throw new TypeError(`unknown observationType: ${String(type)}`);

  // A source-issued id when there is one; otherwise the type's declared content
  // key. FIRMS has no id, which is a fact about FIRMS, not a missing value.
  const recordIdentity = observation.sourceRecordId !== undefined
    ? [canonicalValue(observation.sourceRecordId)]
    : allowlistValues(observation, registered.contentKey);

  if (observation.sourceRecordId === undefined && !registered.contentKey) {
    throw new TypeError(`${type}: observation has no sourceRecordId and the type declares no contentKey`);
  }

  return canonicalJoin([
    canonicalValue(source?.id),
    canonicalValue(source?.feed),
    canonicalValue(type),
    canonicalJoin(recordIdentity),
    canonicalValue(observation.observedAt, 0),
    canonicalJoin(allowlistValues(observation, registered.revisionKey)),
  ]);
}

/**
 * Derive the deterministic observation id.
 *
 * @param {object} observation - Observation.
 * @param {{id: string, feed?: string}} source - Batch source.
 * @returns {string} `obs_` + base32(first 128 bits of sha256(canonicalIdentityString)).
 */
export function deriveObservationId(observation, source) {
  const digest = createHash(ID_HASH)
    .update(canonicalIdentityString(observation, source), 'utf8')
    .digest()
    .subarray(0, ID_BITS / 8);
  return ID_PREFIX + base32Encode(digest);
}

/**
 * The key grouping every version of one source record.
 *
 * Supersession is computed OVER this key by a consumer that holds history. It
 * is deliberately not a stored `supersedes` pointer: a pure normaliser cannot
 * know what it emitted before, and giving it that memory would break replay and
 * idempotency both.
 *
 * Returns null when the source issues no record id — a lineage needs a stable
 * subject, and content-addressed records have none by definition.
 *
 * @param {object} observation - Observation.
 * @param {{id: string, feed?: string}} source - Batch source.
 * @returns {string|null} Lineage key.
 */
export function lineageKey(observation, source) {
  if (observation?.sourceRecordId === undefined) return null;
  return canonicalJoin([
    canonicalValue(source?.id),
    canonicalValue(source?.feed),
    canonicalValue(observation.observationType),
    canonicalValue(observation.sourceRecordId),
  ]);
}
