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
 * The RULES live in `./semantics.js`, shared with every other adapter; this file
 * is the indexes over them. That split is deliberate: a database adapter must be
 * a different place to put rows, never a different set of rules.
 *
 * Correctness first, deliberately. Grouping is by Map and ordering is per query,
 * because a reference implementation that is fast but subtly wrong teaches the
 * wrong semantics to everything built on it.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE STORE PROMISES
 * ---------------------------------------------------------------------------
 *
 *   ATOMIC        A batch is prepared and validated in full before anything is
 *                 applied. One unacceptable observation stores none of them.
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
 * The public surface is AWAITABLE. These methods happen to return their values
 * synchronously, which is what a Map can do; a database adapter returns
 * promises. Callers await either way, so one conformance suite tests both.
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

import { ELEMENT_SET_MODES, isStateful, withinWindow } from './contract.js';
import {
  EMPTY_ENTITY_HISTORY,
  assembleEntityHistory,
  assertObservationId,
  buildElementSetResult,
  byEventTime,
  byKnowledge,
  collapseRevisions,
  compareText,
  prepareBatch,
  prepareElementSetQuery,
  prepareEntityHistoryQuery,
  prepareObservationsBetweenQuery,
  prepareRecordHistoryQuery,
  prepareRevisionsOfQuery,
  prepareStatesAtQuery,
} from './semantics.js';

/** Append `value` to the array at `key`, creating it on first use. */
function push(index, key, value) {
  const bucket = index.get(key);
  if (bucket) bucket.push(value);
  else index.set(key, [value]);
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
   * Insert a batch. Atomic, and idempotent per observation id.
   *
   * `prepareBatch` validates and builds every row first, so nothing below runs
   * unless the whole batch is acceptable. That matches a database transaction,
   * and it is the only way a caller can retry a rejected batch without wondering
   * which half of it landed.
   *
   * @param {object} batch - A `panoptic.observationBatch.v1` batch.
   * @returns {{inserted: number, duplicates: number, observationIds: string[]}} Result.
   */
  function insertBatch(batch) {
    const { rows, observationIds } = prepareBatch(batch);

    let inserted = 0;
    for (const row of rows) {
      // DUPLICATE: already known. No-op — and specifically no touch of
      // ingestedAt, so re-delivery cannot rewrite when we learned this.
      //
      // The id is the idempotency key, full stop. If two observations ever share
      // an id but differ materially, that is an INTEGRITY ANOMALY in whatever
      // produced them — identity is content-addressed, so it should be
      // impossible — and it is emphatically NOT a way to revise evidence. A real
      // revision changes identity-bearing content and therefore gets its own id.
      // Detecting and reporting such an anomaly is deliberately not done here.
      if (byId.has(row.observationId)) continue;

      byId.set(row.observationId, row);
      push(byType, row.observationType, row);
      if (row.recordKey !== null) {
        push(byRecord, row.recordKey, row);
        push(byState, row.stateKey, row);
      }
      for (const token of row.candidateKeys) push(byCandidateKey, token, row);
      inserted += 1;
    }

    return { inserted, duplicates: observationIds.length - inserted, observationIds };
  }

  /** Rows of a type, or every row when the filter is absent. */
  function rowsOfType(observationType) {
    if (observationType === undefined) return [...byId.values()];
    return byType.get(observationType) ?? [];
  }

  /** Whether a row was known by `knowledgeTime` (always true when unset). */
  function known(row, knowledgeTime) {
    return knowledgeTime === undefined || knowledgeTime === null || row.ingestedAt <= knowledgeTime;
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
   * @param {string|null} [query.feed] - One feed, or null for sources with none.
   * @returns {object[]} Rows, oldest EVENT TIME first.
   */
  function observationsBetween(query = {}) {
    const { observationType, from, to, knowledgeTime, sourceId, feed } = prepareObservationsBetweenQuery(query);

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
  function statesAt(query = {}) {
    const { observationType, eventTime, knowledgeTime, sourceId, feed } = prepareStatesAtQuery(query);

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
  function recordHistory(selector, window = {}) {
    const { recordKey, from, to, knowledgeTime } = prepareRecordHistoryQuery(selector, window);
    const visible = (byRecord.get(recordKey) ?? [])
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
  function revisionsOf(selector, options = {}) {
    const { stateKey, knowledgeTime } = prepareRevisionsOfQuery(selector, options);
    return (byState.get(stateKey) ?? [])
      .filter((row) => known(row, knowledgeTime))
      .sort(byKnowledge);
  }

  /**
   * Everything matching a candidate key, ACROSS sources.
   *
   * A query key set matches a row when they share AT LEAST ONE recognised key:
   * `{icao24}` matches a row holding `{icao24, registration}`. Unrecognised
   * namespaces are ignored rather than compared, so an arbitrary field cannot
   * become a way to join unrelated evidence.
   *
   * @param {object} query - Query.
   * @param {object} query.keys - Candidate keys, e.g. `{icao24: 'abc123'}`.
   * @param {string} [query.observationType] - Restrict to one type.
   * @param {number} [query.from] - Window start, INCLUSIVE.
   * @param {number} [query.to] - Window end, EXCLUSIVE.
   * @param {number} [query.knowledgeTime] - As known at this time.
   * @returns {{candidateKeyMatch: true, matchedOn: string[], observations: object[]}} Result.
   */
  function matchTokens(tokens, { observationType, from, to, knowledgeTime }) {
    if (tokens.length === 0) return EMPTY_ENTITY_HISTORY;

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

    return assembleEntityHistory(matched.values());
  }

  function entityHistory(query = {}) {
    const { tokens, observationType, from, to, knowledgeTime } = prepareEntityHistoryQuery(query);
    return matchTokens(tokens, { observationType, from, to, knowledgeTime });
  }

  /**
   * Choose the element set to propagate a satellite at `eventTime`.
   *
   * Its own primitive because the honest answer depends on the QUESTION, and
   * the two answers must never be confused:
   *
   *   CAUSAL          latest element set whose epoch is at or before
   *                   `eventTime`. Uses no knowledge of the orbit's future.
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
   * THE MODE CHANGES EPOCH SELECTION AND NOTHING ELSE. Candidate matching and
   * revision resolution happen first, identically, in both modes — a question
   * about orbits is not a different theory of what supersedes what. See
   * `selectElementSetEpoch` for the three selections kept apart.
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
   * @param {object} query - Query.
   * @param {object} query.keys - Candidate keys, e.g. `{noradId: 25544}`.
   * @param {number} query.eventTime - EVENT TIME to propagate to.
   * @param {string} [query.mode] - An `ELEMENT_SET_MODES` value; default causal.
   * @param {number} [query.knowledgeTime] - KNOWLEDGE TIME horizon.
   * @returns {object|null} `{row, mode, epochDeltaMs, usesFutureEpoch}` or null.
   */
  function elementSetFor(query = {}) {
    const { tokens, eventTime, mode, knowledgeTime } = prepareElementSetQuery(query);

    // The same candidate match every other query uses: it applies the knowledge
    // horizon and resolves revisions, so what reaches epoch selection is one row
    // per state — already the version in force. Epoch selection is the only step
    // that reads `mode`.
    const { observations } = matchTokens(tokens, {
      observationType: 'space.orbital_elements',
      knowledgeTime,
    });

    return buildElementSetResult(observations, { eventTime, mode });
  }

  /** One stored row by id, or null when no such evidence is held. */
  function get(observationId) {
    return byId.get(assertObservationId(observationId)) ?? null;
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
