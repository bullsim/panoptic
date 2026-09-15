/**
 * In-memory Evidence Store — the executable reference implementation.
 *
 * This is the DEFINITION of Evidence Store behaviour, not a stand-in for a
 * database. Every query semantic PANOPTIC relies on — event time, knowledge
 * time, revisions, record lineage, candidate-key history, element-set selection
 * — is expressed here in the plainest code that can express it, and pinned by
 * the shared conformance suite in `src/data/observationStoreConformance.mjs`.
 * Any later backing store must pass that same suite unchanged.
 *
 * Correctness first, deliberately. Grouping is by Map and ordering is per query,
 * because a reference implementation that is fast but subtly wrong teaches the
 * wrong semantics to everything built on it.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE STORE PROMISES
 * ---------------------------------------------------------------------------
 *
 *   IDEMPOTENT    Re-inserting an observation with an id already held is a
 *                 no-op. In particular it does NOT move KNOWLEDGE TIME: the
 *                 store records when PANOPTIC FIRST possessed the evidence, and
 *                 a source re-sending it does not make it newly known. This is
 *                 what makes a re-poll, a retry and a replay all safe.
 *
 *   APPEND-ONLY   Nothing is ever mutated or deleted. A revised earthquake is a
 *                 new observation alongside the old one, not a replacement —
 *                 which is the only way "what did we believe at 14:03?" can be
 *                 answered later.
 *
 *   WHOLE         The full observation is retained. Positions are not thinned,
 *                 summarised or down-sampled on the way in; deciding what is
 *                 interesting is not a storage decision.
 *
 * ---------------------------------------------------------------------------
 * WHY THERE IS NO SINGLE `stateAt`
 * ---------------------------------------------------------------------------
 *
 * Different evidence answers different questions, and one convenient query for
 * all of it would answer some of them wrongly:
 *
 *   aircraft / vessel positions   `statesAt` — successive states of one record;
 *                                 the answer is the LAST position before T.
 *   seismic solutions             `statesAt` — one state, several revisions;
 *                                 the answer is the BEST estimate as at T.
 *   orbital element sets          `elementSetFor` — the nearest usable set is
 *                                 not always the last one, so this is its own
 *                                 primitive with an explicit mode.
 *   fire detections               NEITHER. `statesAt` THROWS. A detection has
 *                                 no persistent subject, so nothing is "in
 *                                 force"; `observationsBetween` is the honest
 *                                 question, over a `[from, to)` window.
 *
 * @module server/storage/memory
 */

import { effectiveDerivation } from '../contracts/observation/v1.js';
import {
  ELEMENT_SET_MODES,
  assertStateful,
  candidateKeyTokens,
  isStateful,
  recordKey as buildRecordKey,
  recordKeyOf,
  stateKeyOf,
  withinWindow,
} from './contract.js';

/**
 * Freeze an observation and everything inside it.
 *
 * The store promises stored evidence never changes. A top-level freeze would
 * not deliver that — `row.observation.properties.magnitude = 9` would still
 * succeed — and silent mutation of held evidence is exactly the failure an
 * evidence store exists to prevent.
 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const inner of Object.values(value)) deepFreeze(inner);
  return value;
}

/** Append `value` to the array at `key`, creating it on first use. */
function push(index, key, value) {
  const bucket = index.get(key);
  if (bucket) bucket.push(value);
  else index.set(key, [value]);
}

/** Deterministic string order. */
function compareText(a, b) {
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
function byKnowledge(a, b) {
  if (a.ingestedAt !== b.ingestedAt) return a.ingestedAt - b.ingestedAt;
  return compareText(a.observationId, b.observationId);
}

/** Order by EVENT TIME, then by knowledge. Oldest first. */
function byEventTime(a, b) {
  if (a.observedAt !== b.observedAt) return a.observedAt - b.observedAt;
  return byKnowledge(a, b);
}

/** Resolve a record selector to a RECORD KEY. */
function selectorToRecordKey(selector) {
  if (typeof selector === 'string') return selector;
  if (selector?.recordKey) return selector.recordKey;
  return buildRecordKey({
    sourceId: selector?.sourceId ?? selector?.source?.id,
    feed: selector?.feed ?? selector?.source?.feed,
    observationType: selector?.observationType,
    sourceRecordId: selector?.sourceRecordId,
  });
}

/**
 * Create an in-memory Evidence Store.
 *
 * @returns {object} Store with the Slice A query surface.
 */
export function createMemoryObservationStore() {
  /** observationId -> stored row. The idempotency key. */
  const byId = new Map();
  /** observationType -> rows */
  const byType = new Map();
  /** RECORD KEY -> rows */
  const byRecord = new Map();
  /** STATE KEY -> rows */
  const byState = new Map();
  /** `namespace=value` -> rows */
  const byCandidateKey = new Map();

  /**
   * Freeze one observation into a stored row.
   *
   * Batch constants are RESOLVED here rather than kept as a reference to the
   * batch: an observation must remain interpretable on its own, and a store
   * that needed its batch alongside it to answer a question would have made the
   * batch part of the data model.
   *
   * THE STORE DOES NOT MINT IDENTITY. An observation arrives canonical:
   *
   *   SOURCE -> NORMALISER -> valid Observation v1 -> EVIDENCE STORE
   *
   * A missing `observationId` is REJECTED, never derived. Deriving one here
   * would put a second implementation of identity behind the storage boundary,
   * and the failure mode is silent: a normaliser bug that dropped ids would be
   * papered over, and the store's ids could drift from the collector's without
   * anything failing. The store owns persistence semantics; the contract owns
   * identity.
   *
   * The observation is COPIED, not referenced. A caller that reuses or mutates
   * its own array after insertion must not be able to change what the store
   * holds — and any real backing store serialises on the way in, so copying
   * here makes the reference implementation honest about the same semantics.
   * The copy costs; correctness is what this implementation is for, and Slice B
   * is where the cost is engineered away.
   */
  function toRow(batch, observation) {
    const source = batch.source;
    const observationType = observation.observationType ?? batch.observationType;
    const observationId = observation.observationId;
    if (typeof observationId !== 'string' || observationId === '') {
      throw new TypeError(
        'observation.observationId is required: the Evidence Store stores canonical '
        + 'Observation v1 records and never derives identity. Normalise before inserting.',
      );
    }
    const resolved = deepFreeze(structuredClone({
      ...observation,
      observationType,
      derivation: effectiveDerivation(batch, observation),
    }));

    return Object.freeze({
      observationId,
      observationType,
      source: Object.freeze({ id: source?.id, feed: source?.feed ?? null }),
      sourceRecordId: observation.sourceRecordId,
      // EVENT TIME — when the source says this was true.
      observedAt: observation.observedAt,
      // KNOWLEDGE TIME — when PANOPTIC first possessed it. Never updated.
      ingestedAt: batch.ingestedAt,
      recordKey: recordKeyOf(resolved, source),
      stateKey: stateKeyOf(resolved, source),
      candidateKeys: Object.freeze(candidateKeyTokens(observation.entityRef?.keys)),
      observation: resolved,
    });
  }

  /**
   * Insert a batch. Idempotent per observation id.
   *
   * @param {object} batch - A `panoptic.observationBatch.v1` batch.
   * @returns {{inserted: number, duplicates: number, observationIds: string[]}} Result.
   */
  function insertBatch(batch) {
    if (!batch || typeof batch !== 'object') throw new TypeError('insertBatch requires a batch object');
    if (!batch.source?.id) throw new TypeError('batch.source.id is required');
    if (!Number.isFinite(batch.ingestedAt)) {
      throw new TypeError('batch.ingestedAt (KNOWLEDGE TIME) must be epoch ms');
    }
    if (!Array.isArray(batch.observations)) throw new TypeError('batch.observations must be an array');

    const observationIds = [];
    let inserted = 0;
    let duplicates = 0;

    for (const observation of batch.observations) {
      const row = toRow(batch, observation);
      observationIds.push(row.observationId);

      // DUPLICATE: already known. No-op — and specifically no touch of
      // ingestedAt, so re-delivery cannot rewrite when we learned this.
      if (byId.has(row.observationId)) {
        duplicates += 1;
        continue;
      }

      byId.set(row.observationId, row);
      push(byType, row.observationType, row);
      if (row.recordKey !== null) {
        push(byRecord, row.recordKey, row);
        push(byState, row.stateKey, row);
      }
      for (const token of row.candidateKeys) push(byCandidateKey, token, row);
      inserted += 1;
    }

    return { inserted, duplicates, observationIds };
  }

  /** Rows of a type, or every row when no type is given. */
  function rowsOfType(observationType) {
    if (observationType === undefined || observationType === null) return [...byId.values()];
    return byType.get(observationType) ?? [];
  }

  /** Whether a row was known by `knowledgeTime` (always true when unset). */
  function known(row, knowledgeTime) {
    return knowledgeTime === undefined || knowledgeTime === null || row.ingestedAt <= knowledgeTime;
  }

  /**
   * Reduce each STATE to its single version in force.
   *
   * Without this, a source that revised one earthquake would appear in a track
   * as two events, and a caller counting rows would count PANOPTIC's changes of
   * mind as things that happened in the world. Callers who want the versions
   * ask `revisionsOf`, which is the audit primitive and never collapses.
   *
   * Rows with no STATE KEY pass through untouched: with no record identity
   * there is nothing to collapse them against, and merging them would fabricate
   * a lineage the source never asserted.
   *
   * Filtering by KNOWLEDGE TIME must happen BEFORE this, so the surviving
   * version is the latest one visible at that time rather than the latest one
   * that ever existed.
   */
  function collapseRevisions(rows) {
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
   * Every observation whose EVENT TIME falls in `[from, to)`.
   *
   * The primitive for occurrences, and the only honest query for evidence with
   * no persistent subject. Start inclusive, end exclusive, permanently — so
   * consecutive windows tile without counting a boundary detection twice.
   *
   * @param {object} query - Query.
   * @param {string} [query.observationType] - Restrict to one type.
   * @param {number} [query.from] - Window start, INCLUSIVE.
   * @param {number} [query.to] - Window end, EXCLUSIVE.
   * @param {number} [query.knowledgeTime] - As known at this time.
   * @param {string} [query.sourceId] - Restrict to one source.
   * @param {string} [query.feed] - Restrict to one feed of that source.
   * @returns {object[]} Rows, oldest EVENT TIME first.
   */
  function observationsBetween({ observationType, from, to, knowledgeTime, sourceId, feed } = {}) {
    return rowsOfType(observationType)
      .filter((row) => withinWindow(row.observedAt, from, to)
        && known(row, knowledgeTime)
        && (sourceId === undefined || row.source.id === sourceId)
        && (feed === undefined || row.source.feed === feed))
      .sort(byEventTime);
  }

  /**
   * What was in force at `eventTime`, one row per record.
   *
   * TWO SELECTIONS, AND THEY ARE NOT THE SAME ONE:
   *
   *   1. WHICH STATE — by EVENT TIME. The latest `observedAt` at or before
   *      `eventTime`. For an aircraft this picks the last reported position;
   *      collapsing by knowledge time instead would return the most recently
   *      RECEIVED position, which at 14:32 could be a 14:30 fix that arrived
   *      late. That is a different aeroplane-shaped answer, and a wrong one.
   *
   *   2. WHICH VERSION OF THAT STATE — by KNOWLEDGE TIME. The latest revision
   *      of that same instant, so a re-solved earthquake magnitude wins over
   *      the first estimate.
   *
   * `knowledgeTime` hides evidence that had not arrived yet, which is what makes
   * "what did we believe at 14:03?" answerable and auditable.
   *
   * Records with no `sourceRecordId` are ABSENT from the result. Such evidence
   * has no lineage to hold a state — there is no subject to be in force — and
   * inventing one from content would silently fabricate a track. Query it with
   * `observationsBetween`.
   *
   * @param {object} query - Query.
   * @param {string} query.observationType - Type, which MUST have `state` semantics.
   * @param {number} query.eventTime - EVENT TIME to evaluate at.
   * @param {number} [query.knowledgeTime] - KNOWLEDGE TIME horizon.
   * @param {string} [query.sourceId] - Restrict to one source.
   * @param {string} [query.feed] - Restrict to one feed.
   * @returns {object[]} One row per record, ordered by record key.
   * @throws {UnsupportedTemporalSemantics} For an `occurrence` type.
   * @throws {UnknownObservationType} For an unregistered type.
   */
  function statesAt({ observationType, eventTime, knowledgeTime, sourceId, feed } = {}) {
    assertStateful(observationType, 'statesAt');
    if (!Number.isFinite(eventTime)) throw new TypeError('statesAt requires a finite eventTime');

    const visible = rowsOfType(observationType).filter((row) => row.recordKey !== null
      && row.observedAt <= eventTime
      && known(row, knowledgeTime)
      && (sourceId === undefined || row.source.id === sourceId)
      && (feed === undefined || row.source.feed === feed));

    // 1. WHICH STATE: greatest visible EVENT TIME per record.
    const latestEventTime = new Map();
    for (const row of visible) {
      const best = latestEventTime.get(row.recordKey);
      if (best === undefined || row.observedAt > best) latestEventTime.set(row.recordKey, row.observedAt);
    }

    // 2. WHICH VERSION: greatest KNOWLEDGE TIME within that state.
    const winner = new Map();
    for (const row of visible) {
      if (row.observedAt !== latestEventTime.get(row.recordKey)) continue;
      const best = winner.get(row.recordKey);
      if (best === undefined || byKnowledge(best, row) < 0) winner.set(row.recordKey, row);
    }

    return [...winner.values()].sort((a, b) => compareText(a.recordKey, b.recordKey));
  }

  /**
   * The ordered STATES one source holds about one record, oldest first.
   *
   * One row per instant, with revisions resolved: a re-solved earthquake is one
   * state whose magnitude changed, not two earthquakes. `revisionsOf` is where
   * the versions live.
   *
   * This is a SINGLE SOURCE's account of a record. It never reaches across
   * sources — that is `entityHistory`, and conflating the two would attribute
   * one source's evidence to another.
   *
   * @param {object|string} selector - `{sourceId, feed, observationType, sourceRecordId}` or a record key.
   * @param {object} [window] - Optional `{from, to, knowledgeTime}`.
   * @returns {object[]} States, oldest EVENT TIME first.
   */
  function recordHistory(selector, { from, to, knowledgeTime } = {}) {
    const key = selectorToRecordKey(selector);
    const visible = (byRecord.get(key) ?? [])
      .filter((row) => withinWindow(row.observedAt, from, to) && known(row, knowledgeTime));
    return collapseRevisions(visible).sort(byEventTime);
  }

  /**
   * Every version of ONE assertion about ONE instant, oldest known first.
   *
   * The last element is the version in force. An empty result means the state
   * was never asserted, not that it was retracted — nothing is ever deleted.
   *
   * @param {object|string} selector - Record selector plus `observedAt`, or a state key.
   * @param {object} [options] - Optional `{knowledgeTime}`.
   * @returns {object[]} Rows in revision order.
   */
  function revisionsOf(selector, { knowledgeTime } = {}) {
    let key;
    if (typeof selector === 'string') {
      key = selector;
    } else if (selector?.stateKey) {
      key = selector.stateKey;
    } else {
      key = stateKeyOf(
        {
          observationType: selector?.observationType,
          sourceRecordId: selector?.sourceRecordId,
          observedAt: selector?.observedAt,
        },
        { id: selector?.sourceId ?? selector?.source?.id, feed: selector?.feed ?? selector?.source?.feed },
      );
    }
    return (byState.get(key) ?? [])
      .filter((row) => known(row, knowledgeTime))
      .sort(byKnowledge);
  }

  /**
   * Everything matching a candidate key, ACROSS sources.
   *
   * A CANDIDATE-KEY MATCH IS NOT AN IDENTITY. It says two observations carry the
   * same identifier — nothing more. `icao24` addresses are reassigned, `mmsi` is
   * routinely spoofed, and no entity resolution exists in PANOPTIC. Every row is
   * therefore marked `candidateKeyMatch: true` and carries `matchedOn`, so a
   * caller can never mistake the join for a resolved entity.
   *
   * A query key set matches a row when they share AT LEAST ONE recognised key:
   * `{icao24}` matches a row holding `{icao24, registration}`. Unrecognised
   * namespaces are ignored rather than compared, so an arbitrary field cannot
   * become a way to join unrelated evidence.
   *
   * Revisions are RESOLVED here. A source changing its mind about one instant
   * must not read as the craft having been in two places.
   *
   * @param {object} query - Query.
   * @param {object} query.keys - Candidate keys, e.g. `{icao24: 'abc123'}`.
   * @param {string} [query.observationType] - Restrict to one type.
   * @param {number} [query.from] - Window start, INCLUSIVE.
   * @param {number} [query.to] - Window end, EXCLUSIVE.
   * @param {number} [query.knowledgeTime] - As known at this time.
   * @returns {{candidateKeyMatch: true, matchedOn: string[], observations: object[]}} Result.
   */
  function entityHistory({ keys, observationType, from, to, knowledgeTime } = {}) {
    const tokens = candidateKeyTokens(keys);
    const empty = Object.freeze({
      candidateKeyMatch: true,
      matchedOn: Object.freeze([]),
      observations: Object.freeze([]),
    });
    if (tokens.length === 0) return empty;

    // Union over tokens, de-duplicated by observation id: a row matching on both
    // noradId and intlDesignator is one row, matched twice.
    const matched = new Map();
    for (const token of tokens) {
      for (const row of byCandidateKey.get(token) ?? []) {
        if (observationType !== undefined && row.observationType !== observationType) continue;
        if (!withinWindow(row.observedAt, from, to) || !known(row, knowledgeTime)) continue;
        const seen = matched.get(row.observationId);
        if (seen) seen.matchedOn.push(token);
        else matched.set(row.observationId, { row, matchedOn: [token] });
      }
    }

    const observations = collapseRevisions([...matched.values()].map(({ row }) => row))
      .sort(byEventTime)
      .map((row) => Object.freeze({
        ...row,
        matchedOn: Object.freeze([...matched.get(row.observationId).matchedOn].sort()),
      }));

    return Object.freeze({
      // NOT a resolved identity. These observations share an identifier, and
      // nothing here claims they describe the same object in the world.
      candidateKeyMatch: true,
      matchedOn: Object.freeze([...new Set(observations.flatMap((row) => row.matchedOn))].sort()),
      observations: Object.freeze(observations),
    });
  }

  /**
   * Choose the element set to propagate a satellite at `eventTime`.
   *
   * Its own primitive because the honest answer depends on the QUESTION, and
   * the two answers must never be confused:
   *
   *   CAUSAL          latest element set whose epoch is at or before
   *                   `eventTime`, and — when `knowledgeTime` is given — one
   *                   PANOPTIC already held. Uses no knowledge of the future.
   *                   This is the mode for "where could we have known it was?",
   *                   and the only mode admissible as evidence.
   *
   *   RECONSTRUCTION  element set with the epoch NEAREST `eventTime`, which may
   *                   be LATER than it. SGP4 accuracy decays in both directions
   *                   from epoch, so this is usually the better physical
   *                   estimate — and it is hindsight about the orbit.
   *                   `usesFutureEpoch` says so on every result; a
   *                   reconstruction may be rendered and measured, never cited
   *                   for what was knowable at the time.
   *
   * TWO DIFFERENT FUTURES, NEVER CONFLATED:
   *
   *   `usesFutureEpoch`   the selected TLE EPOCH is after `eventTime`. A fact
   *                       about the orbit, and about nothing else. PANOPTIC may
   *                       well have held that element set long before — an
   *                       element set with a 15:00 epoch ingested at 13:00 has
   *                       a future epoch and was already known.
   *
   *   knowledge           whether PANOPTIC held the evidence at all. That is
   *                       expressed ONLY by the `knowledgeTime` filter
   *                       (`ingestedAt <= knowledgeTime`), never by a flag. An
   *                       element set with a 12:00 epoch ingested at 15:00 has
   *                       no future epoch, and is simply absent from any query
   *                       whose knowledge horizon precedes 15:00.
   *
   * Ties on epoch distance resolve to the earlier epoch, then by knowledge, so
   * the choice is deterministic.
   *
   * @param {object} query - Query.
   * @param {object} query.keys - Candidate keys, e.g. `{noradId: 25544}`.
   * @param {number} query.eventTime - EVENT TIME to propagate to.
   * @param {string} [query.mode] - An `ELEMENT_SET_MODES` value; default causal.
   * @param {number} [query.knowledgeTime] - KNOWLEDGE TIME horizon.
   * @returns {object|null} `{row, mode, epochDeltaMs, usesFutureEpoch}` or null.
   */
  function elementSetFor({ keys, eventTime, mode = ELEMENT_SET_MODES.CAUSAL, knowledgeTime } = {}) {
    if (!Number.isFinite(eventTime)) throw new TypeError('elementSetFor requires a finite eventTime');
    if (mode !== ELEMENT_SET_MODES.CAUSAL && mode !== ELEMENT_SET_MODES.RECONSTRUCTION) {
      throw new TypeError(`unknown element set mode: ${JSON.stringify(mode)}`);
    }

    const candidates = entityHistory({ keys, observationType: 'space.orbital_elements', knowledgeTime })
      .observations
      .filter((row) => (mode === ELEMENT_SET_MODES.CAUSAL ? row.observedAt <= eventTime : true));
    if (candidates.length === 0) return null;

    let best = null;
    for (const row of candidates) {
      if (best === null) {
        best = row;
        continue;
      }
      if (mode === ELEMENT_SET_MODES.CAUSAL) {
        // Latest epoch at or before eventTime; later knowledge breaks a tie.
        if (byEventTime(best, row) < 0) best = row;
      } else {
        const delta = Math.abs(row.observedAt - eventTime);
        const bestDelta = Math.abs(best.observedAt - eventTime);
        if (delta < bestDelta || (delta === bestDelta && byEventTime(row, best) < 0)) best = row;
      }
    }

    return Object.freeze({
      row: best,
      mode,
      epochDeltaMs: best.observedAt - eventTime,
      // ORBITAL hindsight only: the epoch is later than the moment asked about.
      // Says nothing about when PANOPTIC learned of it — that is the
      // knowledgeTime filter's job, and folding the two together here would
      // make an element set held for hours look like knowledge from the future.
      usesFutureEpoch: best.observedAt > eventTime,
    });
  }

  /** One stored row by id, or null. */
  function get(observationId) {
    return byId.get(observationId) ?? null;
  }

  /** Number of distinct observations held. */
  function size() {
    return byId.size;
  }

  return Object.freeze({
    insertBatch,
    observationsBetween,
    statesAt,
    recordHistory,
    revisionsOf,
    entityHistory,
    elementSetFor,
    get,
    size,
  });
}

export { ELEMENT_SET_MODES, isStateful };
