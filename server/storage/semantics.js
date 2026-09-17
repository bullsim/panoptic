/**
 * Evidence Store semantics — pure, shared by every storage adapter.
 *
 * ONE IMPLEMENTATION OF THE RULES, TWO STORAGE ADAPTERS. The in-memory store is
 * the executable reference; a database adapter is a different PLACE TO PUT ROWS,
 * never a different set of rules. Anything both adapters must agree on — what is
 * acceptable evidence, how a batch is prepared, how revisions collapse, how
 * ordering breaks ties, which element set answers a question — lives here, so
 * the two cannot drift apart without a shared test failing.
 *
 * Nothing in this module stores anything, and nothing here is asynchronous. A
 * storage adapter's own job is only: apply prepared rows, and hand rows back.
 *
 * ---------------------------------------------------------------------------
 * KNOWLEDGE TIME IS SUPPLIED, NOT OBSERVED BY THE STORE
 * ---------------------------------------------------------------------------
 *
 * `batch.ingestedAt` is semantic data: when PANOPTIC first possessed the
 * evidence. It is NOT a database commit time, NOT `Date.now()` at insert, and no
 * adapter may substitute one. A durable adapter stores the supplied value
 * verbatim. If an archive importer later needs `importedAt`, `persistedAt` or
 * `custodyReceivedAt`, those are separate metadata and must never overwrite or
 * reinterpret `ingestedAt`.
 *
 * ---------------------------------------------------------------------------
 * WHY ACCEPTANCE RULES LIVE HERE
 * ---------------------------------------------------------------------------
 *
 * A durable store has opinions a Map does not: a column is typed, a timestamp
 * cannot be NaN, and JSON cannot hold a function. If the reference accepted
 * those and the database rejected them, the two would disagree the first time a
 * normaliser emitted something odd — and the disagreement would surface in
 * production, not in a test. So the reference enforces exactly what the strictest
 * planned representation can hold, and does so through this module.
 *
 * These are STORAGE ACCEPTANCE rules. They do not redefine Observation v1
 * identity or its envelope; `identity.js` and `validate.js` remain untouched.
 *
 * @module server/storage/semantics
 */

import { effectiveDerivation, isKnownObservationType } from '../contracts/observation/v1.js';
import {
  ELEMENT_SET_MODES,
  UnknownObservationType,
  assertStateful,
  candidateKeyTokens,
  recordKey as buildRecordKey,
  recordKeyOf,
  stateKeyOf,
} from './contract.js';

/**
 * Freeze a value and everything inside it.
 *
 * The store promises stored evidence never changes. A top-level freeze would
 * not deliver that — `row.observation.properties.magnitude = 9` would still
 * succeed — and silent mutation of held evidence is exactly the failure an
 * evidence store exists to prevent.
 *
 * @param {unknown} value - Value to freeze.
 * @returns {unknown} The same value, deeply frozen.
 */
export function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const inner of Object.values(value)) deepFreeze(inner);
  return value;
}

/** Whether a value is a plain object literal (or a null-prototype bag). */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Name a value for an error message without printing the whole thing. */
function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  const type = typeof value;
  if (type !== 'object') return type === 'number' ? String(value) : type;
  return value.constructor?.name ?? 'object with no prototype';
}

/**
 * Convert evidence to its canonical JSON form, rejecting what JSON cannot hold.
 *
 * The durable representation is JSON, so the reference must hold exactly what
 * JSON holds — no more. This is a deliberate, explicit walk rather than a
 * `JSON.stringify` round trip, because `JSON.stringify` SILENTLY changes things:
 * it turns `undefined` and functions inside arrays into `null`, drops them
 * inside objects, calls `toJSON` on anything that has one, renders a `Date` as a
 * string and a `Map` as `{}`. Every one of those is a value that would mean one
 * thing in memory and another in a database.
 *
 * ACCEPTED, and preserved exactly:
 *   null, booleans, strings, finite numbers, plain objects, dense arrays.
 *
 * NORMALISED, because JSON has no other form for them:
 *   `-0` becomes `0`.
 *   An object property whose value is `undefined` is OMITTED, which is what
 *   "absent" already means in Observation v1.
 *   Symbol-keyed properties are not evidence and are not stored.
 *
 * REJECTED, loudly, rather than quietly reshaped:
 *   NaN, Infinity, -Infinity      — "stable nonsense" in a numeric column.
 *   `undefined` inside an array   — JSON would store `null`, changing meaning.
 *   a sparse array hole           — same, and it is almost always a bug.
 *   functions, symbols, bigints   — not data.
 *   Date, Map, Set, RegExp, class instances — a Date would silently become a
 *                                   string; Observation v1 carries epoch ms.
 *   circular references           — no JSON form at all.
 *
 * @param {unknown} value - Value to convert.
 * @param {string} [path] - Location, for error messages.
 * @param {Set<object>} [seen] - Ancestors, for cycle detection.
 * @returns {unknown} A JSON-safe copy.
 */
export function toJsonEvidence(value, path = 'observation', seen = new Set()) {
  if (value === null) return null;

  const type = typeof value;
  if (type === 'boolean' || type === 'string') return value;
  if (type === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${path} is not JSON-representable: ${value}`);
    }
    // -0 and 0 are the same JSON number; keep one form so a round trip is exact.
    return value === 0 ? 0 : value;
  }
  if (type === 'undefined' || type === 'bigint' || type === 'function' || type === 'symbol') {
    throw new TypeError(`${path} is not JSON-representable: ${type}`);
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) throw new TypeError(`${path} is not JSON-representable: circular reference`);
    seen.add(value);
    const out = [];
    for (let i = 0; i < value.length; i += 1) {
      if (!(i in value)) {
        throw new TypeError(`${path}[${i}] is not JSON-representable: sparse array hole (JSON would store null)`);
      }
      if (value[i] === undefined) {
        throw new TypeError(`${path}[${i}] is not JSON-representable: undefined array entry (JSON would store null)`);
      }
      out.push(toJsonEvidence(value[i], `${path}[${i}]`, seen));
    }
    seen.delete(value);
    return out;
  }

  if (!isPlainObject(value)) {
    throw new TypeError(`${path} is not JSON-representable: ${describe(value)}`);
  }
  if (seen.has(value)) throw new TypeError(`${path} is not JSON-representable: circular reference`);
  seen.add(value);
  const entries = [];
  for (const [key, inner] of Object.entries(value)) {
    if (inner === undefined) continue; // absent, which is what Observation v1 means
    entries.push([key, toJsonEvidence(inner, `${path}.${key}`, seen)]);
  }
  seen.delete(value);
  // fromEntries, not assignment: `out['__proto__'] = x` would set the prototype
  // instead of creating a property, quietly losing the field.
  return Object.fromEntries(entries);
}

/** Whether a value is a millisecond timestamp a durable store can hold exactly. */
export function isStorableEpochMs(value) {
  return Number.isSafeInteger(value);
}

/**
 * Validate a batch source's feed.
 *
 * A feed is a name or it is absent. `undefined` and `null` both mean "this
 * source has no feed" — which is what the record key already encodes, so the two
 * are interchangeable here and normalise to `null`.
 *
 * Anything else is REJECTED rather than coerced. A store that accepted
 * `feed: 123` would hand back a number while a text column handed back `"123"`,
 * and the two adapters would disagree about the same evidence. An empty string
 * is rejected too: it is not a name, and it would be indistinguishable from "no
 * feed" in the key while differing in every query that compares the value.
 *
 * @param {string} where - Field name, for the error message.
 * @param {unknown} feed - Supplied feed.
 * @returns {string|null} The feed, or null when the source has none.
 */
export function assertStoredFeed(where, feed) {
  if (feed === undefined || feed === null) return null;
  if (typeof feed !== 'string' || feed === '') {
    throw new TypeError(`${where} must be a non-empty string, null, or absent`);
  }
  return feed;
}

/**
 * Validate a `feed` QUERY FILTER, where absent and null mean different things.
 *
 *   undefined  no filter at all — every feed, and sources with none
 *   null       match only evidence from a source with NO feed
 *   "name"     match only that feed
 *
 * @param {unknown} feed - Supplied filter.
 * @returns {string|null|undefined} The filter, unchanged.
 */
export function assertFeedFilter(feed) {
  if (feed === undefined || feed === null) return feed;
  if (typeof feed !== 'string' || feed === '') {
    throw new TypeError('feed filter must be a non-empty string, null (no feed), or absent (no filter)');
  }
  return feed;
}

/**
 * Validate a temporal query argument.
 *
 * PANOPTIC time is integer epoch milliseconds, everywhere, including in queries.
 * A fractional or non-finite bound has no meaning against integer evidence, and
 * silently rounding one would make a database answer a question the reference
 * never asked — so both refuse it instead.
 *
 * `undefined` and `null` are the absence form for optional bounds; a required
 * argument accepts neither.
 *
 * @param {string} name - Argument name, for the error message.
 * @param {unknown} value - Supplied value.
 * @param {{required?: boolean}} [options] - Whether the argument is required.
 * @returns {number|null} The value, or null when absent.
 */
export function assertQueryTime(name, value, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) {
      throw new TypeError(`${name} is required: epoch ms, a finite, whole, safe integer`);
    }
    return null;
  }
  if (!isStorableEpochMs(value)) {
    throw new TypeError(`${name} must be epoch ms: a finite, whole, safe integer`);
  }
  return value;
}

/**
 * Validate a `[from, to)` window.
 *
 * Half-open, permanently. `from === to` is a valid EMPTY interval — it is the
 * natural result of slicing a timeline at one instant, and returning nothing is
 * the correct answer. `from > to` is not an empty interval, it is a malformed
 * query, and answering `[]` would hide the caller's mistake.
 *
 * @param {{from?: unknown, to?: unknown}} window - Supplied bounds.
 * @returns {{from: number|null, to: number|null}} Validated bounds.
 */
export function assertQueryWindow({ from, to } = {}) {
  const start = assertQueryTime('from', from);
  const end = assertQueryTime('to', to);
  if (start !== null && end !== null && start > end) {
    throw new RangeError(`invalid window: from (${start}) is after to (${end})`);
  }
  return { from: start, to: end };
}

/** Whether a value is a string with something in it. */
function isNonEmptyString(value) {
  return typeof value === 'string' && value !== '';
}

/**
 * Validate an OPTIONAL `sourceId` query filter.
 *
 *   undefined          no filter — every source
 *   non-empty string   exactly that source
 *   anything else      rejected, and never coerced
 *
 * Unlike `feed`, `null` is rejected: every stored observation carries a source
 * id, so "evidence with no source" is not a thing that can be asked for. And
 * nothing is stringified — a store that turned `sourceId: 123` into `"123"`
 * would match evidence the caller never named.
 *
 * @param {unknown} sourceId - Supplied filter.
 * @returns {string|undefined} The filter, unchanged.
 */
export function assertSourceIdFilter(sourceId) {
  if (sourceId === undefined) return undefined;
  if (!isNonEmptyString(sourceId)) {
    throw new TypeError('sourceId filter must be a non-empty string, or absent (no filter)');
  }
  return sourceId;
}

/**
 * Validate an observation id used to look one up.
 *
 * A Map tolerates any key and a SQL parameter would coerce one; between them
 * that is two different API contracts for the same call. So the argument is a
 * non-empty string or it is an error — never stringified. An id that is
 * well-formed but unknown returns null, which is an answer, not a mistake.
 *
 * @param {unknown} observationId - Supplied id.
 * @returns {string} The id, unchanged.
 */
export function assertObservationId(observationId) {
  if (!isNonEmptyString(observationId)) {
    throw new TypeError('observationId must be a non-empty string');
  }
  return observationId;
}

/**
 * Validate an element-set selection mode, applying the default.
 *
 * Shared so every adapter fails identically on an unknown mode. `causal` is the
 * default because it is the only mode admissible as evidence: a caller who did
 * not think about the distinction gets the answer that uses no hindsight.
 *
 * @param {unknown} mode - Supplied mode, or undefined for the default.
 * @returns {string} An `ELEMENT_SET_MODES` value.
 */
export function assertElementSetMode(mode) {
  if (mode === undefined) return ELEMENT_SET_MODES.CAUSAL;
  if (mode !== ELEMENT_SET_MODES.CAUSAL && mode !== ELEMENT_SET_MODES.RECONSTRUCTION) {
    throw new TypeError(`unknown element set mode: ${JSON.stringify(mode)}`);
  }
  return mode;
}

/**
 * Validate an OPTIONAL `observationType` query filter.
 *
 *   undefined          no filter — every type
 *   registered string  filter to that type
 *   anything else      rejected
 *
 * `null` is rejected rather than treated as "all types": it read as "all" in one
 * query and "no rows" in another, which is precisely the kind of quiet
 * disagreement that survives into a database adapter. An unregistered type is
 * rejected too — storage holds none, so filtering by one could only ever return
 * an empty result that looks like evidence of absence.
 *
 * @param {unknown} observationType - Supplied filter.
 * @returns {string|undefined} The filter, unchanged.
 * @throws {UnknownObservationType} For null, a non-string, or an unknown type.
 */
export function assertTypeFilter(observationType) {
  if (observationType === undefined) return undefined;
  if (!isKnownObservationType(observationType)) throw new UnknownObservationType(observationType);
  return observationType;
}

/**
 * Validate a batch and turn it into rows ready to apply. Pure; stores nothing.
 *
 * ATOMICITY LIVES HERE. Everything that can be rejected is rejected before this
 * function returns, so an adapter that only applies the rows it is handed cannot
 * half-insert a batch. A batch with one bad observation stores none of it.
 *
 * @param {object} batch - A `panoptic.observationBatch.v1` batch.
 * @returns {{rows: readonly object[], observationIds: string[], ingestedAt: number}} Prepared batch.
 */
export function prepareBatch(batch) {
  if (!batch || typeof batch !== 'object') throw new TypeError('insertBatch requires a batch object');

  const source = batch.source;
  if (typeof source?.id !== 'string' || source.id === '') {
    throw new TypeError('batch.source.id must be a non-empty string');
  }
  const feed = assertStoredFeed('batch.source.feed', source.feed);
  if (!isStorableEpochMs(batch.ingestedAt)) {
    throw new TypeError(
      'batch.ingestedAt (KNOWLEDGE TIME) must be epoch ms: a finite, whole, safe integer',
    );
  }
  if (!Array.isArray(batch.observations)) throw new TypeError('batch.observations must be an array');

  const observationIds = [];
  const rows = [];
  const claimed = new Set();

  batch.observations.forEach((observation, index) => {
    const where = `observations[${index}]`;
    if (!isPlainObject(observation)) {
      throw new TypeError(`${where} must be an object`);
    }

    const observationId = observation.observationId;
    if (!isNonEmptyString(observationId)) {
      throw new TypeError(
        `${where}.observationId is required: the Evidence Store stores canonical `
        + 'Observation v1 records and never derives identity. Normalise before inserting.',
      );
    }

    // A batch hoists its type; a record inherits it unless it says otherwise.
    const observationType = observation.observationType ?? batch.observationType;
    if (!isKnownObservationType(observationType)) throw new UnknownObservationType(observationType);

    if (!isStorableEpochMs(observation.observedAt)) {
      throw new TypeError(
        `${where}.observedAt (EVENT TIME) must be epoch ms: a finite, whole, safe integer`,
      );
    }

    // A record id that is present must identify something. An empty string is
    // not an identifier, and accepting one would build a record key that a
    // selector with NO record id also builds — quietly joining unrelated
    // evidence. Absence is how a source says it issues no id.
    if (observation.sourceRecordId === '') {
      throw new TypeError(
        `${where}.sourceRecordId must identify a record: an empty string identifies nothing. `
        + 'Omit it when the source issues none.',
      );
    }

    observationIds.push(observationId);

    // WITHIN-BATCH DUPLICATE: the first occurrence is the evidence, later ones
    // are duplicates — the same rule as a re-delivered batch, applied inside one.
    if (claimed.has(observationId)) return;
    claimed.add(observationId);

    const resolved = deepFreeze(toJsonEvidence({
      ...observation,
      observationType,
      derivation: effectiveDerivation(batch, observation),
    }, where));

    rows.push(Object.freeze({
      observationId,
      observationType,
      source: Object.freeze({ id: source.id, feed }),
      sourceRecordId: resolved.sourceRecordId,
      // EVENT TIME — when the source says this was true.
      observedAt: resolved.observedAt,
      // KNOWLEDGE TIME — supplied by the batch, and never replaced by a clock.
      ingestedAt: batch.ingestedAt,
      recordKey: recordKeyOf(resolved, source),
      stateKey: stateKeyOf(resolved, source),
      candidateKeys: Object.freeze(candidateKeyTokens(resolved.entityRef?.keys)),
      observation: resolved,
    }));
  });

  return { rows: Object.freeze(rows), observationIds, ingestedAt: batch.ingestedAt };
}

/** Deterministic string order, matching a byte-ordered database collation. */
export function compareText(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * Order two versions of one STATE by knowledge.
 *
 * Later KNOWLEDGE TIME wins — that is the revision order. When two revisions
 * were ingested in the same millisecond the store still has to answer, so it
 * falls back to the observation id: arbitrary, but stable across runs, hosts
 * and backing stores, which is the property that actually matters. A tie here
 * means two versions arrived in one batch, and the store cannot know which the
 * source considered later.
 */
export function byKnowledge(a, b) {
  if (a.ingestedAt !== b.ingestedAt) return a.ingestedAt - b.ingestedAt;
  return compareText(a.observationId, b.observationId);
}

/** Order by EVENT TIME, then by knowledge. Oldest first. */
export function byEventTime(a, b) {
  if (a.observedAt !== b.observedAt) return a.observedAt - b.observedAt;
  return byKnowledge(a, b);
}

/**
 * Reduce each STATE to its single version in force.
 *
 * Without this, a source that revised one earthquake would appear in a track as
 * two events, and a caller counting rows would count PANOPTIC's changes of mind
 * as things that happened in the world. Callers who want the versions ask
 * `revisionsOf`, which is the audit primitive and never collapses.
 *
 * Rows with no STATE KEY pass through untouched: with no record identity there
 * is nothing to collapse them against, and merging them would fabricate a
 * lineage the source never asserted.
 *
 * Filtering by KNOWLEDGE TIME must happen BEFORE this, so the surviving version
 * is the latest one visible at that time rather than the latest one that ever
 * existed.
 *
 * @param {readonly object[]} rows - Visible rows.
 * @returns {object[]} One row per state, plus every unkeyed row.
 */
export function collapseRevisions(rows) {
  const winners = new Map();
  const unkeyed = [];
  for (const row of rows) {
    if (row.stateKey === null) {
      unkeyed.push(row);
      continue;
    }
    const best = winners.get(row.stateKey);
    if (best === undefined || byKnowledge(best, row) < 0) winners.set(row.stateKey, row);
  }
  return [...winners.values(), ...unkeyed];
}

/**
 * RAW KEYS ARE OPAQUE.
 *
 * `recordHistory('<canonical record key>')` and `revisionsOf('<canonical state
 * key>')` accept a key string — the same string the store hands back on every
 * row — and pass it through untouched. It is never parsed, never re-encoded and
 * never checked for internal structure. There is exactly ONE key encoder, in
 * `contract.js`; a decoder here would be a second implementation of the format,
 * and the two would eventually disagree about some record.
 *
 * A well-formed string that matches nothing returns `[]`, which is an answer.
 * The `{recordKey}` / `{stateKey}` object forms behave the same way. Only the
 * PARTS form is validated, because only the parts form builds a key.
 */

/**
 * Validate the parts form of a selector, which builds a key rather than filters.
 *
 * The type must be registered and the feed must be a feed, for the same reason
 * the stored values must: a key built from something storage would have refused
 * can never match, and returning `[]` would look like "no such evidence" rather
 * than "that was not a well-formed question".
 *
 * A missing `sourceRecordId` is permitted and left alone — it builds the key of
 * a record whose id is absent, which matches nothing, and that is the approved
 * unaddressable-evidence semantics.
 */
function assertSelectorParts(selector) {
  const observationType = selector?.observationType;
  if (!isKnownObservationType(observationType)) throw new UnknownObservationType(observationType);
  if (selector?.sourceRecordId === '') {
    throw new TypeError('selector.sourceRecordId must identify a record: an empty string identifies nothing');
  }
  return assertStoredFeed('selector.feed', selector?.feed ?? selector?.source?.feed);
}

/** Resolve a record selector — a key, `{recordKey}`, or the parts — to a RECORD KEY. */
export function selectorToRecordKey(selector) {
  if (typeof selector === 'string') return selector;
  if (selector?.recordKey) return selector.recordKey;
  const feed = assertSelectorParts(selector);
  return buildRecordKey({
    sourceId: selector?.sourceId ?? selector?.source?.id,
    feed,
    observationType: selector?.observationType,
    sourceRecordId: selector?.sourceRecordId,
  });
}

/** Resolve a state selector — a key, `{stateKey}`, or the parts plus `observedAt`. */
export function selectorToStateKey(selector) {
  if (typeof selector === 'string') return selector;
  if (selector?.stateKey) return selector.stateKey;
  const feed = assertSelectorParts(selector);
  // A state is an assertion about ONE instant, so the instant is required.
  assertQueryTime('selector.observedAt', selector?.observedAt, { required: true });
  return stateKeyOf(
    {
      observationType: selector?.observationType,
      sourceRecordId: selector?.sourceRecordId,
      observedAt: selector?.observedAt,
    },
    { id: selector?.sourceId ?? selector?.source?.id, feed },
  );
}

/** The answer when no recognised candidate key was supplied, or none matched. */
export const EMPTY_ENTITY_HISTORY = Object.freeze({
  candidateKeyMatch: true,
  matchedOn: Object.freeze([]),
  observations: Object.freeze([]),
});

/**
 * Build the entity-history envelope from matched rows.
 *
 * A CANDIDATE-KEY MATCH IS NOT AN IDENTITY. It says two observations carry the
 * same identifier — nothing more. `icao24` addresses are reassigned, `mmsi` is
 * routinely spoofed, and no entity resolution exists in PANOPTIC. The envelope
 * says `candidateKeyMatch` and every row carries `matchedOn`, so a caller can
 * never mistake the join for a resolved entity.
 *
 * Revisions are RESOLVED here: a source changing its mind about one instant must
 * not read as the craft having been in two places.
 *
 * @param {Iterable<{row: object, matchedOn: string[]}>} entries - Matched rows.
 * @returns {{candidateKeyMatch: true, matchedOn: readonly string[], observations: readonly object[]}} Envelope.
 */
export function assembleEntityHistory(entries) {
  const matched = [...entries];
  if (matched.length === 0) return EMPTY_ENTITY_HISTORY;

  const tokensById = new Map(matched.map(({ row, matchedOn }) => [row.observationId, matchedOn]));
  const observations = collapseRevisions(matched.map(({ row }) => row))
    .sort(byEventTime)
    .map((row) => Object.freeze({
      ...row,
      matchedOn: Object.freeze([...tokensById.get(row.observationId)].sort()),
    }));

  return Object.freeze({
    candidateKeyMatch: true,
    matchedOn: Object.freeze([...new Set(observations.flatMap((row) => row.matchedOn))].sort()),
    observations: Object.freeze(observations),
  });
}

/**
 * Choose the orbital EPOCH to answer with. Revisions must already be resolved.
 *
 * THREE DIFFERENT SELECTIONS, AND ONLY THE LAST ONE DEPENDS ON THE MODE:
 *
 *   CANDIDATE MATCH    which observations describe this object at all. A shared
 *                      identifier, never a resolved identity.
 *   REVISION SELECTION which version of one state is in force: greatest
 *                      KNOWLEDGE TIME, then the greatest observation id. This is
 *                      the ordinary PANOPTIC revision rule and it is IDENTICAL
 *                      in both modes — a mode is a question about orbits, not a
 *                      different theory of what supersedes what.
 *   EPOCH SELECTION    which element set to propagate from. THIS, and only this,
 *                      is what `causal` and `reconstruction` disagree about.
 *
 * @param {readonly object[]} candidates - Rows, already collapsed to state winners.
 * @param {{eventTime: number, mode: string}} query - Event time and mode.
 * @returns {number|null} The chosen epoch, or null when nothing is eligible.
 */
export function selectElementSetEpoch(candidates, { eventTime, mode }) {
  let chosen = null;
  for (const { observedAt: epoch } of candidates) {
    if (mode === ELEMENT_SET_MODES.CAUSAL) {
      // Causal reasoning may not look at the orbit's future, ever.
      if (epoch > eventTime) continue;
      if (chosen === null || epoch > chosen) chosen = epoch;
      continue;
    }
    // Reconstruction wants the nearest epoch on either side. Equidistant epochs
    // resolve to the earlier one, so the answer never depends on iteration order.
    if (chosen === null) {
      chosen = epoch;
      continue;
    }
    const distance = Math.abs(epoch - eventTime);
    const best = Math.abs(chosen - eventTime);
    if (distance < best || (distance === best && epoch < chosen)) chosen = epoch;
  }
  return chosen;
}

/**
 * Choose the element set to propagate a satellite at `eventTime`.
 *
 * @param {readonly object[]} candidates - Rows, already collapsed to state winners.
 * @param {{eventTime: number, mode: string}} query - Event time and mode.
 * @returns {object|null} `{row, mode, epochDeltaMs, usesFutureEpoch}` or null.
 */
export function buildElementSetResult(candidates, { eventTime, mode }) {
  // Validated here as well as at the query boundary, so an adapter that reached
  // this helper by another route still cannot invent a third mode.
  const selection = assertElementSetMode(mode);
  const epoch = selectElementSetEpoch(candidates, { eventTime, mode: selection });
  if (epoch === null) return null;

  // Several DISTINCT records can hold the same epoch — CelesTrak groups overlap,
  // so the ISS arrives in `stations` and in `active`. Pick between them with the
  // same rule that picks between revisions: latest knowledge, then id.
  let best = null;
  for (const row of candidates) {
    if (row.observedAt !== epoch) continue;
    if (best === null || byKnowledge(best, row) < 0) best = row;
  }

  return Object.freeze({
    row: best,
    mode: selection,
    epochDeltaMs: best.observedAt - eventTime,
    // ORBITAL hindsight only: the epoch is later than the moment asked about.
    // Says nothing about when PANOPTIC learned of it — that is the knowledgeTime
    // filter's job, and folding the two together here would make an element set
    // held for hours look like knowledge from the future.
    usesFutureEpoch: best.observedAt > eventTime,
  });
}

/* ---------------------------------------------------------------------------
 * QUERY PREPARATION — one entry point per operation
 * ---------------------------------------------------------------------------
 *
 * Every rule above is a function an adapter could forget to call. These six are
 * the answer: one per query operation, each validating and normalising that
 * operation's whole parameter set, and each returning the values the adapter
 * actually needs to execute — a resolved record key, a state key, candidate-key
 * tokens.
 *
 * That makes the rules hard to skip rather than merely available. An adapter
 * that did not call `prepareRecordHistoryQuery` would have no record key to look
 * up and would have to re-derive one, which is conspicuous in review in a way
 * that a missing `assertQueryWindow` is not.
 *
 * They are pure, know nothing about storage, and deliberately do NOT execute
 * anything. Reading rows is the adapter's job; agreeing on what was asked is
 * this module's.
 */

/**
 * Validate an `observationsBetween` query.
 *
 * @param {object} [query] - Raw query.
 * @returns {Readonly<object>} Normalised parameters.
 */
export function prepareObservationsBetweenQuery({
  observationType, from, to, knowledgeTime, sourceId, feed,
} = {}) {
  return Object.freeze({
    observationType: assertTypeFilter(observationType),
    ...assertQueryWindow({ from, to }),
    knowledgeTime: assertQueryTime('knowledgeTime', knowledgeTime),
    sourceId: assertSourceIdFilter(sourceId),
    feed: assertFeedFilter(feed),
  });
}

/**
 * Validate a `statesAt` query. The type must be registered AND stateful.
 *
 * @param {object} [query] - Raw query.
 * @returns {Readonly<object>} Normalised parameters.
 */
export function prepareStatesAtQuery({
  observationType, eventTime, knowledgeTime, sourceId, feed,
} = {}) {
  assertStateful(observationType, 'statesAt');
  return Object.freeze({
    observationType,
    eventTime: assertQueryTime('eventTime', eventTime, { required: true }),
    knowledgeTime: assertQueryTime('knowledgeTime', knowledgeTime),
    sourceId: assertSourceIdFilter(sourceId),
    feed: assertFeedFilter(feed),
  });
}

/**
 * Validate a `recordHistory` query and resolve its RECORD KEY.
 *
 * @param {object|string} selector - Record selector.
 * @param {object} [window] - Optional window.
 * @returns {Readonly<object>} Normalised parameters, including `recordKey`.
 */
export function prepareRecordHistoryQuery(selector, { from, to, knowledgeTime } = {}) {
  const window = assertQueryWindow({ from, to });
  return Object.freeze({
    ...window,
    knowledgeTime: assertQueryTime('knowledgeTime', knowledgeTime),
    recordKey: selectorToRecordKey(selector),
  });
}

/**
 * Validate a `revisionsOf` query and resolve its STATE KEY.
 *
 * @param {object|string} selector - State selector.
 * @param {object} [options] - Optional knowledge horizon.
 * @returns {Readonly<object>} Normalised parameters, including `stateKey`.
 */
export function prepareRevisionsOfQuery(selector, { knowledgeTime } = {}) {
  return Object.freeze({
    knowledgeTime: assertQueryTime('knowledgeTime', knowledgeTime),
    stateKey: selectorToStateKey(selector),
  });
}

/**
 * Validate an `entityHistory` query and canonicalise its candidate keys.
 *
 * The tokens come out of here, so an adapter cannot accidentally match on raw
 * key values and miss that `'01361'` and `1361` are one satellite.
 *
 * @param {object} [query] - Raw query.
 * @returns {Readonly<object>} Normalised parameters, including `tokens`.
 */
export function prepareEntityHistoryQuery({
  keys, observationType, from, to, knowledgeTime,
} = {}) {
  return Object.freeze({
    observationType: assertTypeFilter(observationType),
    ...assertQueryWindow({ from, to }),
    knowledgeTime: assertQueryTime('knowledgeTime', knowledgeTime),
    tokens: Object.freeze(candidateKeyTokens(keys)),
  });
}

/**
 * Validate an `elementSetFor` query and canonicalise its candidate keys.
 *
 * @param {object} [query] - Raw query.
 * @returns {Readonly<object>} Normalised parameters, including `mode` and `tokens`.
 */
export function prepareElementSetQuery({ keys, eventTime, mode, knowledgeTime } = {}) {
  return Object.freeze({
    eventTime: assertQueryTime('eventTime', eventTime, { required: true }),
    knowledgeTime: assertQueryTime('knowledgeTime', knowledgeTime),
    mode: assertElementSetMode(mode),
    tokens: Object.freeze(candidateKeyTokens(keys)),
  });
}
