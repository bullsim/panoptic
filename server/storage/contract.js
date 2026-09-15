/**
 * PANOPTIC Evidence Store contract.
 *
 * Types, invariants and pure key helpers. No storage, no I/O, no database.
 *
 * ---------------------------------------------------------------------------
 * THE TWO TIME AXES — PANOPTIC terminology, used consistently everywhere
 * ---------------------------------------------------------------------------
 *
 *   EVENT TIME      `Observation.observedAt`
 *                   When the source says the evidence was true or occurred.
 *
 *   KNOWLEDGE TIME  `ObservationBatch.ingestedAt`
 *                   When PANOPTIC FIRST possessed that evidence. Written once
 *                   on first insert and never updated — re-delivery of the same
 *                   observation does not make it newly known.
 *
 * ---------------------------------------------------------------------------
 * THREE KEYS, THREE DIFFERENT QUESTIONS
 * ---------------------------------------------------------------------------
 *
 *   RECORD KEY  (source.id, feed, observationType, sourceRecordId)
 *               "all evidence one source has about one record"
 *               Identical to the committed `lineageKey()` in the Observation
 *               contract, and deliberately so.
 *
 *   STATE KEY   RECORD KEY + observedAt
 *               "all versions of one assertion about one instant"
 *
 *   ENTITY      recognised candidate keys (§CANDIDATE_KEY_NAMESPACES)
 *               "everything about this craft, ACROSS sources" — a best-effort
 *               match, never a claim of real-world identity.
 *
 * These are NOT one concept. For an aircraft, one RECORD KEY holds thousands of
 * STATES (different observedAt) with one version each. For an earthquake, one
 * RECORD KEY holds one STATE with several VERSIONS. `observedAt` is what tells
 * them apart — which is why it sits inside the identity string but outside the
 * record key.
 *
 * TIME WINDOWS ARE ALWAYS `[from, to)` — start inclusive, end exclusive — so
 * adjacent windows tile without counting a boundary observation twice.
 *
 * @module server/storage/contract
 */

import { temporalSemantics } from '../contracts/observation/v1.js';
import { canonicalJoin, canonicalValue } from '../contracts/observation/identity.js';

/** Raised when a state question is asked of an occurrence type. */
export class UnsupportedTemporalSemantics extends Error {
  /**
   * @param {string} observationType - The offending type.
   * @param {string} operation - The operation that rejected it.
   */
  constructor(observationType, operation) {
    super(
      `${operation} is not defined for ${observationType}: it has 'occurrence' semantics. `
      + 'An occurrence has no persistent subject whose state could be in force at a time — '
      + 'use observationsBetween() for a window of occurrences.',
    );
    this.name = 'UnsupportedTemporalSemantics';
    this.observationType = observationType;
    this.operation = operation;
  }
}

/** Raised when an observation type is not in the registry. */
export class UnknownObservationType extends Error {
  /** @param {string} observationType - The unknown type. */
  constructor(observationType) {
    super(`unknown observationType: ${JSON.stringify(observationType)}`);
    this.name = 'UnknownObservationType';
    this.observationType = observationType;
  }
}

/**
 * Whether a type supports state-in-force questions.
 *
 * @param {string} observationType - Observation type.
 * @returns {boolean} True for `state` semantics.
 * @throws {UnknownObservationType} When the type is not registered.
 */
export function isStateful(observationType) {
  const semantics = temporalSemantics(observationType);
  if (semantics === null) throw new UnknownObservationType(observationType);
  return semantics === 'state';
}

/** Throw unless the type supports state questions. */
export function assertStateful(observationType, operation) {
  if (!isStateful(observationType)) {
    throw new UnsupportedTemporalSemantics(observationType, operation);
  }
}

/**
 * RECORD KEY — all evidence one source has about one record.
 *
 * Preserves exactly the four fields of the committed lineage: `source.id`,
 * `source.feed`, `observationType`, `sourceRecordId`. `feed` and
 * `observationType` are part of the key, not decoration: two feeds of one
 * source describe different records, and so do two types.
 *
 * Returns `null` when the source issues no record identifier (FIRMS). Such
 * evidence has no record lineage, no state and no revisions — that is a fact
 * about the source, not a missing value.
 *
 * @param {object} observation - Observation.
 * @param {{id: string, feed?: string}} source - Batch source.
 * @returns {string|null} Record key.
 */
export function recordKeyOf(observation, source) {
  if (observation?.sourceRecordId === undefined || observation?.sourceRecordId === null) return null;
  return canonicalJoin([
    canonicalValue(source?.id),
    canonicalValue(source?.feed),
    canonicalValue(observation.observationType),
    canonicalValue(observation.sourceRecordId),
  ]);
}

/**
 * STATE KEY — one assertion about one instant. RECORD KEY + EVENT TIME.
 *
 * Every observation sharing a STATE KEY is a revision of the same assertion;
 * observations sharing only a RECORD KEY are successive states.
 *
 * @param {object} observation - Observation.
 * @param {{id: string, feed?: string}} source - Batch source.
 * @returns {string|null} State key, or null when there is no record key.
 */
export function stateKeyOf(observation, source) {
  const recordKey = recordKeyOf(observation, source);
  if (recordKey === null) return null;
  return canonicalJoin([recordKey, canonicalValue(observation.observedAt, 0)]);
}

/** Build a RECORD KEY from its four parts, for callers that hold them directly. */
export function recordKey({ sourceId, feed, observationType, sourceRecordId }) {
  return canonicalJoin([
    canonicalValue(sourceId),
    canonicalValue(feed),
    canonicalValue(observationType),
    canonicalValue(sourceRecordId),
  ]);
}

/**
 * Recognised candidate-key namespaces.
 *
 * DERIVED FROM COMMITTED CODE, not invented. Each entry exists because the
 * repository already treats that value as the identity of a craft:
 *
 *   noradId, intlDesignator  emitted by server/collectors/celestrak.js (entityRef.keys)
 *   icao24                   the aircraft identity throughout src/data/flights.js
 *                            and militaryFlights.js; the key of `air.position`
 *   mmsi, imo                the vessel record in vite.config.js and the
 *                            `ais-live-vessels` vocabulary in analystEngine.js;
 *                            the keys of `sea.position`
 *
 * Deliberately absent: any seismic namespace. USGS `feature.id` identifies an
 * EVENT, and an event is not a persistent entity — it is already the record key.
 *
 * A match on one of these is EVIDENCE OF A SHARED IDENTIFIER, never proof of
 * real-world identity: `icao24` and `mmsi` are both reassigned in practice, and
 * `mmsi` is routinely spoofed. Results say so.
 *
 * `canonicalise` returns `null` for a value this namespace cannot accept, which
 * keeps a malformed key from matching anything.
 */
export const CANDIDATE_KEY_NAMESPACES = Object.freeze({
  // ADS-B 24-bit address. Hex, case-insensitive upstream; lowercased here.
  icao24: Object.freeze({
    describes: 'aircraft',
    canonicalise: (v) => {
      const text = String(v ?? '').trim().toLowerCase();
      return /^[0-9a-f]{6}$/.test(text) ? text : null;
    },
  }),
  // Maritime Mobile Service Identity: exactly 9 digits. Leading zeros are
  // SIGNIFICANT (they denote group/coast-station categories), so they are kept.
  mmsi: Object.freeze({
    describes: 'vessel',
    canonicalise: (v) => {
      const text = String(v ?? '').trim();
      return /^\d{9}$/.test(text) ? text : null;
    },
  }),
  // IMO ship number, sometimes carried with an 'IMO' prefix upstream.
  imo: Object.freeze({
    describes: 'vessel',
    canonicalise: (v) => {
      const text = String(v ?? '').trim().toUpperCase().replace(/^IMO[\s-]*/, '');
      return /^\d{7}$/.test(text) ? text : null;
    },
  }),
  // NORAD catalogue number. Canonical form is the number, so a zero-padded
  // '01361' and an unpadded 1361 are the same object — the same rule the
  // CelesTrak normaliser applies to sourceRecordId.
  noradId: Object.freeze({
    describes: 'satellite',
    canonicalise: (v) => {
      const text = String(v ?? '').trim();
      if (!/^\d{1,9}$/.test(text)) return null;
      return String(Number(text));
    },
  }),
  // COSPAR international designator, e.g. '98067A', '23028AX'.
  intlDesignator: Object.freeze({
    describes: 'satellite',
    canonicalise: (v) => {
      const text = String(v ?? '').trim().toUpperCase();
      return /^\d{5}[A-Z]{1,3}$/.test(text) ? text : null;
    },
  }),
});

/**
 * Reduce an `entityRef.keys` object to recognised `namespace=value` tokens.
 *
 * Unknown property names are IGNORED rather than treated as identity: an
 * arbitrary field must never become a way for two unrelated observations to
 * match. A key whose value fails its namespace's canonicaliser is dropped for
 * the same reason.
 *
 * @param {object|null|undefined} keys - `entityRef.keys`.
 * @returns {string[]} Sorted, de-duplicated tokens.
 */
export function candidateKeyTokens(keys) {
  if (!keys || typeof keys !== 'object') return [];
  const tokens = new Set();
  for (const [namespace, raw] of Object.entries(keys)) {
    const spec = CANDIDATE_KEY_NAMESPACES[namespace];
    if (!spec) continue;                       // unknown namespace is not identity
    const value = spec.canonicalise(raw);
    if (value === null) continue;              // malformed value matches nothing
    tokens.add(`${namespace}=${value}`);
  }
  return [...tokens].sort();
}

/** Whether two key sets share at least one recognised candidate key. */
export function candidateKeysIntersect(a, b) {
  const left = new Set(candidateKeyTokens(a));
  if (left.size === 0) return false;
  return candidateKeyTokens(b).some((token) => left.has(token));
}

/**
 * Whether an EVENT TIME falls inside a `[from, to)` window.
 *
 * Start inclusive, end exclusive — permanently. Adjacent windows tile, and an
 * observation exactly on a boundary is counted once.
 *
 * @param {number} observedAt - Event time.
 * @param {number} [from] - Window start, inclusive.
 * @param {number} [to] - Window end, exclusive.
 * @returns {boolean} True when inside.
 */
export function withinWindow(observedAt, from, to) {
  if (from !== undefined && from !== null && observedAt < from) return false;
  if (to !== undefined && to !== null && observedAt >= to) return false;
  return true;
}

/** Element-set selection modes for satellite replay. See `elementSetFor`. */
export const ELEMENT_SET_MODES = Object.freeze({
  /**
   * Best physical estimate. MAY select an element set whose epoch is LATER than
   * the event time, and one PANOPTIC received after it — SGP4 accuracy degrades
   * in both directions from epoch, so the nearest set is usually the best.
   *
   * A reconstruction may be rendered, measured and compared. It must NEVER be
   * cited as evidence for what was knowable at a time.
   */
  RECONSTRUCTION: 'reconstruction',
  /**
   * Latest element set whose epoch is at or before the event time. Uses no
   * knowledge of the orbit's future. This is the mode for causal reasoning.
   */
  CAUSAL: 'causal',
});
