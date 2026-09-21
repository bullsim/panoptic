// PANOPTIC persistence sink — admission, ordering, bounds and retry.
//
// THE SINK IS TESTED AGAINST THE IN-MEMORY STORE AND FAKES, NEVER A DATABASE.
// Its responsibilities are all about delivery — whether there is room, whether a
// failure is worth retrying, what the pipeline's state now is — and none of them
// need PostgreSQL to be true. `npm test` therefore stays green with no database
// and no container runtime, which is the whole point.
//
// Nothing here sleeps for real: backoff is injected, so the retry tests assert
// the delays that WOULD have been waited and finish in milliseconds.
//
// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MAX_PENDING_BATCHES,
  DEFAULT_MAX_PENDING_OBSERVATIONS,
  RETRY_ATTEMPTS,
  createObservationSink,
  createPipelineState,
} from '../../server/persistence/sink.js';
import { createMemoryObservationStore } from '../../server/storage/memory.js';

const silent = { warn() {}, error() {}, log() {} };

/** The error class the adapter raises when the database is unreachable. */
const unavailable = () => Object.assign(new Error('evidence store is unavailable'), {
  name: 'EvidenceStoreUnavailable',
});

/** A permanent fault: a constraint, a missing table, a validation bug. */
const permanent = () => Object.assign(new Error('null value violates not-null constraint'), {
  name: 'error',
  code: '23502',
});

/** A batch of `count` orbital element sets, tagged by feed so order is visible. */
function batchOf(count, feed = 'active', ingestedAt = 1_000) {
  return {
    schema: 'panoptic.observationBatch.v1',
    source: { id: 'celestrak', feed },
    observationType: 'space.orbital_elements',
    ingestedAt,
    observations: Array.from({ length: count }, (_, i) => ({
      observationId: `obs_${feed}_${i}`,
      observedAt: 1_700_000_000_000 + i,
      sourceRecordId: String(i),
      entityRef: { keys: { noradId: i } },
      properties: { meanMotion: 15.5 },
    })),
  };
}

/** A promise a test can release by hand, to hold a batch in flight. */
function gate() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release: () => release() };
}

/** A store that records what it was given, and can be told how to fail. */
function recordingStore({ failWith = () => null, hold = null } = {}) {
  const inserted = [];
  let attempts = 0;
  return {
    inserted,
    get attempts() { return attempts; },
    async insertBatch(batch) {
      attempts += 1;
      if (hold) await hold.promise;
      const error = failWith(attempts, batch);
      if (error) throw error;
      inserted.push(batch);
      return { inserted: batch.observations.length, duplicates: 0, observationIds: [] };
    },
  };
}

/** A sink wired for tests: silent, with injected backoff and no real waiting. */
function makeSink(store, options = {}) {
  const delays = [];
  const state = createPipelineState({ now: () => 1_000, log: silent });
  state.set('initialising');
  const sink = createObservationSink({
    store,
    state,
    log: silent,
    sleep: async (ms) => { delays.push(ms); },
    random: () => 0.5, // no jitter, so delays are exact
    ...options,
  });
  return { sink, state, delays };
}

// ---------------------------------------------------------------------------
// 1-2. FIFO ordering, and evidence is never replaced
// ---------------------------------------------------------------------------

test('accepted batches persist in submission order', async () => {
  const store = recordingStore();
  const { sink } = makeSink(store);

  for (const feed of ['first', 'second', 'third']) {
    assert.equal(sink.submit(`celestrak:${feed}`, batchOf(2, feed)).accepted, true);
  }
  assert.equal(await sink.drain({ timeoutMs: 1_000 }), true);

  assert.deepEqual(store.inserted.map((b) => b.source.feed), ['first', 'second', 'third']);
});

test('a newer batch never replaces an accepted older one', async () => {
  // PANOPTIC is an evidence-retention system: element set A is not disposable
  // merely because B is newer. A latest-wins queue would silently destroy
  // exactly the historical evidence this store exists to keep.
  const held = gate();
  const store = recordingStore({ hold: held });
  const { sink } = makeSink(store);

  sink.submit('celestrak:active', batchOf(1, 'active', 1));
  sink.submit('celestrak:active', batchOf(1, 'active', 2));
  sink.submit('celestrak:active', batchOf(1, 'active', 3));

  held.release();
  assert.equal(await sink.drain({ timeoutMs: 1_000 }), true);

  assert.equal(store.inserted.length, 3, 'every accepted batch must be written');
  assert.deepEqual(store.inserted.map((b) => b.ingestedAt), [1, 2, 3], 'in order, none dropped');
});

// ---------------------------------------------------------------------------
// 3-5. Saturation rejects the NEW submission
// ---------------------------------------------------------------------------

test('at the batch bound the NEW submission is refused and earlier ones survive', async () => {
  const held = gate();
  const store = recordingStore({ hold: held });
  const { sink, state } = makeSink(store, { maxPendingBatches: 3 });

  // One goes in flight immediately; two more wait. That is the bound.
  assert.equal(sink.submit('celestrak:a', batchOf(1, 'a')).accepted, true);
  assert.equal(sink.submit('celestrak:b', batchOf(1, 'b')).accepted, true);
  assert.equal(sink.submit('celestrak:c', batchOf(1, 'c')).accepted, true);

  const refused = sink.submit('celestrak:d', batchOf(1, 'd'));
  assert.equal(refused.accepted, false);
  assert.equal(refused.reason, 'saturated');
  assert.equal(state.status, 'unavailable', 'refused evidence impairs retention');
  assert.equal(state.reason, 'saturated');

  held.release();
  assert.equal(await sink.drain({ timeoutMs: 1_000 }), true);

  assert.deepEqual(store.inserted.map((b) => b.source.feed), ['a', 'b', 'c'],
    'the three already accepted batches are untouched');
  assert.equal(state.counters.droppedBatches, 1);
});

test('the observation bound is enforced independently of the batch bound', async () => {
  const held = gate();
  const store = recordingStore({ hold: held });
  const { sink } = makeSink(store, { maxPendingBatches: 100, maxPendingObservations: 10 });

  assert.equal(sink.submit('celestrak:a', batchOf(6, 'a')).accepted, true);
  // 6 in flight + 5 more would be 11, over the bound, so this is refused even
  // though only one batch is outstanding.
  const refused = sink.submit('celestrak:b', batchOf(5, 'b'));
  assert.equal(refused.accepted, false);
  assert.equal(refused.reason, 'saturated');
  // Something that fits is still admitted.
  assert.equal(sink.submit('celestrak:c', batchOf(4, 'c')).accepted, true);

  held.release();
  await sink.drain({ timeoutMs: 1_000 });
  assert.deepEqual(store.inserted.map((b) => b.source.feed), ['a', 'c']);
});

test('the shipped bounds are the measured ones', () => {
  assert.equal(DEFAULT_MAX_PENDING_BATCHES, 8);
  assert.equal(DEFAULT_MAX_PENDING_OBSERVATIONS, 40_000);
});

// ---------------------------------------------------------------------------
// 6. Admission is synchronous
// ---------------------------------------------------------------------------

test('submit returns a synchronous verdict, never a thenable', () => {
  const { sink } = makeSink(recordingStore());
  const verdict = sink.submit('celestrak:active', batchOf(3));

  // If this were awaitable, a request handler could await persistence — which
  // is precisely what must be impossible rather than merely discouraged.
  assert.equal(typeof verdict.then, 'undefined', 'a verdict must not be thenable');
  assert.equal(verdict instanceof Promise, false);
  assert.equal(verdict.accepted, true);
  assert.equal(verdict.observations, 3);
  assert.equal(typeof verdict.queueDepth, 'number');
});

// ---------------------------------------------------------------------------
// 7-10. Retry
// ---------------------------------------------------------------------------

test('only EvidenceStoreUnavailable is retried, exactly three times', async () => {
  const store = recordingStore({ failWith: () => unavailable() });
  const { sink, state, delays } = makeSink(store);

  sink.submit('celestrak:active', batchOf(1));
  await sink.drain({ timeoutMs: 1_000 });

  assert.equal(store.attempts, RETRY_ATTEMPTS, 'three total attempts');
  assert.equal(store.attempts, 3);
  // Three attempts have two gaps between them.
  assert.deepEqual(delays, [1_000, 4_000], 'bounded exponential backoff, injected');
  assert.equal(state.status, 'unavailable');
  assert.equal(state.reason, 'store-unavailable');
  assert.equal(state.counters.droppedBatches, 1);
});

test('a permanent failure is never retried', async () => {
  // A constraint violation, a missing table or a validation bug will not fix
  // itself. Retrying loops forever AND hides it.
  const store = recordingStore({ failWith: () => permanent() });
  const { sink, state, delays } = makeSink(store);

  sink.submit('celestrak:active', batchOf(1));
  await sink.drain({ timeoutMs: 1_000 });

  assert.equal(store.attempts, 1, 'tried once, then given up on');
  assert.deepEqual(delays, [], 'and never waited');
  assert.equal(state.status, 'unavailable');
  assert.equal(state.reason, 'store-rejected');
});

test('a transient failure that clears is retried and then succeeds', async () => {
  const store = recordingStore({ failWith: (attempt) => (attempt === 1 ? unavailable() : null) });
  const { sink, state, delays } = makeSink(store);

  sink.submit('celestrak:active', batchOf(2));
  await sink.drain({ timeoutMs: 1_000 });

  assert.equal(store.attempts, 2);
  assert.deepEqual(delays, [1_000]);
  assert.equal(store.inserted.length, 1);
  assert.equal(state.status, 'available');
});

// ---------------------------------------------------------------------------
// 11. Normalisation failure is contained, and impairs the pipeline
// ---------------------------------------------------------------------------

test('a throwing producer is contained and impairs pipeline health', async () => {
  const store = recordingStore();
  const { sink, state } = makeSink(store);

  const verdict = sink.submit('celestrak:active', () => {
    throw new TypeError('cannot read properties of undefined');
  });

  assert.equal(verdict.accepted, false);
  assert.equal(verdict.reason, 'normalisation-failed');
  assert.equal(store.inserted.length, 0, 'nothing reached the store');
  // Health is the EVIDENCE-RETENTION PIPELINE, not merely the database: the
  // database is perfectly well here, and PANOPTIC still failed to retain what
  // it acquired.
  assert.equal(state.status, 'unavailable');
  assert.equal(state.reason, 'normalisation-failed');
  assert.equal(state.counters.droppedBatches, 1);
});

test('a malformed batch is refused rather than handed to the store', async () => {
  const store = recordingStore();
  const { sink, state } = makeSink(store);

  for (const bad of [null, undefined, {}, { observations: 'not-an-array' }]) {
    const verdict = sink.submit('celestrak:active', bad);
    assert.equal(verdict.accepted, false);
    assert.equal(verdict.reason, 'normalisation-failed');
  }
  assert.equal(store.inserted.length, 0);
  assert.equal(state.status, 'unavailable');
});

// ---------------------------------------------------------------------------
// 12. A real successful write is what restores `available`
// ---------------------------------------------------------------------------

test('a successful write restores available after a failure', async () => {
  let fail = true;
  const store = recordingStore({ failWith: () => (fail ? unavailable() : null) });
  const { sink, state } = makeSink(store);

  sink.submit('celestrak:active', batchOf(1, 'a'));
  await sink.drain({ timeoutMs: 1_000 });
  assert.equal(state.status, 'unavailable');

  fail = false;
  sink.submit('celestrak:active', batchOf(1, 'b'));
  await sink.drain({ timeoutMs: 1_000 });
  assert.equal(state.status, 'available', 'only a real write establishes retention');
  assert.equal(state.reason, null);
});

// ---------------------------------------------------------------------------
// 13. Accounting, including the in-flight batch
// ---------------------------------------------------------------------------

test('the in-flight batch counts as pending', async () => {
  const held = gate();
  const store = recordingStore({ hold: held });
  const { sink, state } = makeSink(store);

  sink.submit('celestrak:active', batchOf(7));
  // Nothing is queued — it went straight into the write — but it is still held
  // in memory, so the bound that exists to cap retained work must count it.
  assert.equal(state.counters.pendingBatches, 1);
  assert.equal(state.counters.pendingObservations, 7);
  assert.equal(sink.state().pendingBatches, 1);

  sink.submit('celestrak:active', batchOf(3, 'queued'));
  assert.equal(state.counters.pendingBatches, 2, 'in flight plus queued');
  assert.equal(state.counters.pendingObservations, 10);

  held.release();
  assert.equal(await sink.drain({ timeoutMs: 1_000 }), true);
  assert.equal(state.counters.pendingBatches, 0);
  assert.equal(state.counters.pendingObservations, 0);
  assert.equal(state.counters.persistedBatches, 2);
});

// ---------------------------------------------------------------------------
// Admission closing and bounded drain
// ---------------------------------------------------------------------------

test('closed admission refuses new work but still drains what was accepted', async () => {
  const held = gate();
  const store = recordingStore({ hold: held });
  const { sink } = makeSink(store);

  sink.submit('celestrak:active', batchOf(1, 'accepted'));
  sink.closeAdmission();

  const refused = sink.submit('celestrak:active', batchOf(1, 'late'));
  assert.equal(refused.accepted, false);
  assert.equal(refused.reason, 'closing');

  held.release();
  assert.equal(await sink.drain({ timeoutMs: 1_000 }), true);
  assert.deepEqual(store.inserted.map((b) => b.source.feed), ['accepted']);
});

test('a drain against a hung store gives up at its bound', async () => {
  // Never released: shutdown must not be able to wait forever on a database.
  const store = recordingStore({ hold: gate() });
  const { sink } = makeSink(store);

  sink.submit('celestrak:active', batchOf(1));
  assert.equal(await sink.drain({ timeoutMs: 40 }), false, 'the drain is bounded');
});

// ---------------------------------------------------------------------------
// Against the real reference store
// ---------------------------------------------------------------------------

test('the sink writes real evidence and re-delivery is idempotent', async () => {
  const store = createMemoryObservationStore();
  const { sink, state } = makeSink(store);

  const first = batchOf(3, 'active', 1_111);
  // The same observations, delivered later. KNOWLEDGE TIME must not move.
  const second = { ...batchOf(3, 'active', 9_999) };

  sink.submit('celestrak:active', first);
  await sink.drain({ timeoutMs: 1_000 });
  sink.submit('celestrak:active', second);
  await sink.drain({ timeoutMs: 1_000 });

  assert.equal(await store.size(), 3, 'a duplicate delivery inserts nothing');
  assert.equal((await store.get('obs_active_0')).ingestedAt, 1_111,
    'first-known KNOWLEDGE TIME survives re-delivery');
  assert.equal(state.status, 'available');
  assert.equal(state.counters.persistedBatches, 2);
});
