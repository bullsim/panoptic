/**
 * Evidence persistence sink — bounded, in-memory, best-effort.
 *
 * THE SINK IS A DELIVERY MECHANISM, NOT A SEMANTIC ONE. It does not normalise
 * collector formats, mint observation ids, mutate batches, implement Evidence
 * Store rules, or know that PostgreSQL exists. It accepts a prepared
 * `panoptic.observationBatch.v1`, holds a bounded amount of it in memory, and
 * hands it to a store. Everything it decides is about *delivery*: whether there
 * is room, whether a failure is worth retrying, and what the pipeline's
 * operational state now is.
 *
 * DELIVERY GUARANTEE — best-effort delivery with bounded in-memory retry and
 * idempotent insertion. Not exactly-once. Not durable at-least-once. A process
 * crash loses queued and in-flight batches; an outage beyond the retry budget
 * loses evidence; saturation refuses new evidence. What makes re-delivery safe
 * is the store, not the sink: a repeated `observationId` is an idempotent
 * durable insertion that cannot move KNOWLEDGE TIME.
 *
 * ADMISSION IS SYNCHRONOUS. `submit()` returns a verdict object, never a
 * promise and never a thenable. A caller therefore *cannot* await persistence,
 * which is how live HTTP is kept structurally independent of it rather than
 * merely conventionally so.
 *
 * @module server/persistence/sink
 */

/**
 * The error name that means "the database was unreachable", as classified by
 * the PostgreSQL adapter.
 *
 * Matched by NAME rather than by `instanceof` on purpose: importing the adapter
 * here would drag PostgreSQL into a component whose whole point is not to know
 * about it. A store that never becomes unavailable simply never produces this.
 */
const TRANSIENT_ERROR_NAME = 'EvidenceStoreUnavailable';

/** Batches held in memory at once, in flight included. */
export const DEFAULT_MAX_PENDING_BATCHES = 8;

/**
 * Observations held in memory at once, in flight included.
 *
 * Measured, not guessed: a CelesTrak observation retains ~1.11 KiB, flat across
 * every group, so 40,000 caps the queue near 44 MiB. The largest real group
 * (`active`, 16,041 objects) is ~17 MiB, and all nine groups a cold start
 * requests total ~27,700 observations — so the entire cold-start burst is
 * admitted without a single drop, and saturation signals a genuine anomaly.
 */
export const DEFAULT_MAX_PENDING_OBSERVATIONS = 40_000;

/** Total attempts for one batch: the first try plus two retries. */
export const RETRY_ATTEMPTS = 3;

/**
 * Waits BETWEEN attempts.
 *
 * Three attempts have two gaps, so there are two delays rather than three. A
 * third delay would only ever apply to a fourth attempt.
 */
export const RETRY_BACKOFF_MS = Object.freeze([1_000, 4_000]);

/** Default bound on how long a shutdown drain may take. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;

/**
 * The persistence pipeline's operational state.
 *
 * ONE HOLDER, shared by the sink (which learns from real writes) and the
 * persistence runtime (which learns from readiness probes). Two holders would
 * eventually disagree about whether evidence is being retained.
 *
 * `disabled` is set by the runtime and never by the sink; the sink moves
 * between `initialising`, `available` and `unavailable`.
 *
 * @param {object} [options] - State options.
 * @param {() => number} [options.now] - Clock, injectable for tests.
 * @param {Pick<Console,'log'>} [options.log] - Log sink for transitions.
 * @returns {object} The shared state handle.
 */
export function createPipelineState({ now = () => Date.now(), log = console } = {}) {
  let status = 'disabled';
  let reason = null;
  let since = now();

  const counters = {
    pendingBatches: 0,
    pendingObservations: 0,
    persistedBatches: 0,
    persistedObservations: 0,
    droppedBatches: 0,
    failedBatches: 0,
  };

  return {
    counters,
    get status() { return status; },
    get reason() { return reason; },

    /**
     * Move to a state, logging only genuine transitions.
     *
     * @param {string} nextStatus - Target state.
     * @param {string|null} [nextReason] - Bounded, non-sensitive reason token.
     * @returns {boolean} Whether anything actually changed.
     */
    set(nextStatus, nextReason = null) {
      if (status === nextStatus && reason === nextReason) return false;
      status = nextStatus;
      reason = nextReason;
      since = now();
      log.log?.(`[panoptic] persistence ${nextStatus}${nextReason ? ` (${nextReason})` : ''}`);
      return true;
    },

    /**
     * A bounded, non-sensitive view for `/health`.
     *
     * Carries no connection string, host, user, schema name, raw database error
     * or stack — only an enum, a token, a timestamp and counters.
     *
     * @returns {Readonly<object>} Health fragment.
     */
    snapshot() {
      const base = { status, reason, since: new Date(since).toISOString() };
      if (status === 'disabled') return Object.freeze({ status, reason: null, since: base.since });
      return Object.freeze({
        ...base,
        pendingBatches: counters.pendingBatches,
        persistedBatches: counters.persistedBatches,
        droppedBatches: counters.droppedBatches,
      });
    },
  };
}

/**
 * Build a persistence sink over an Evidence Store.
 *
 * @param {object} options - Sink options.
 * @param {{insertBatch: Function}} options.store - Any Evidence Store.
 * @param {ReturnType<typeof createPipelineState>} options.state - Shared pipeline state.
 * @param {Pick<Console,'warn'|'log'>} [options.log] - Log sink.
 * @param {(ms: number) => Promise<void>} [options.sleep] - Backoff sleep (injectable).
 * @param {() => number} [options.random] - Jitter source (injectable).
 * @param {number} [options.maxPendingBatches] - Batch bound, in flight included.
 * @param {number} [options.maxPendingObservations] - Observation bound, in flight included.
 * @param {number} [options.attempts] - Total attempts per batch.
 * @param {readonly number[]} [options.backoffMs] - Waits between attempts.
 * @returns {object} The sink.
 */
export function createObservationSink({
  store,
  state,
  log = console,
  sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); }),
  random = Math.random,
  maxPendingBatches = DEFAULT_MAX_PENDING_BATCHES,
  maxPendingObservations = DEFAULT_MAX_PENDING_OBSERVATIONS,
  attempts = RETRY_ATTEMPTS,
  backoffMs = RETRY_BACKOFF_MS,
} = {}) {
  if (!store || typeof store.insertBatch !== 'function') {
    throw new TypeError('createObservationSink requires a store with insertBatch');
  }
  if (!state || typeof state.set !== 'function') {
    throw new TypeError('createObservationSink requires a pipeline state');
  }

  /** @type {{label: string, batch: object, count: number}[]} FIFO, oldest first. */
  const queue = [];
  /** The batch currently being written, which still counts as pending. */
  let inFlight = null;
  let running = false;
  let admitting = true;
  /** @type {(() => void)[]} Resolvers waiting for the queue to empty. */
  const idleWaiters = [];

  const isIdle = () => queue.length === 0 && inFlight === null;

  /**
   * Recompute the pending counters.
   *
   * THE IN-FLIGHT BATCH COUNTS. It is still held in memory, and the bound exists
   * to cap retained work rather than to cap the waiting list — the safer of the
   * two readings, and the one the admission arithmetic uses consistently.
   */
  function recount() {
    let batches = queue.length;
    let observations = 0;
    for (const item of queue) observations += item.count;
    if (inFlight) {
      batches += 1;
      observations += inFlight.count;
    }
    state.counters.pendingBatches = batches;
    state.counters.pendingObservations = observations;
    return { batches, observations };
  }

  /** Settle everything waiting on an empty queue. */
  function releaseIdleWaiters() {
    while (idleWaiters.length) idleWaiters.shift()();
  }

  /** Write one batch, retrying only genuine unavailability. */
  async function writeWithRetry(item) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await store.insertBatch(item.batch);
      } catch (error) {
        const transient = error?.name === TRANSIENT_ERROR_NAME;
        // A validation failure, an unknown type, a constraint violation or a
        // missing table is a bug or a misconfiguration. Retrying one loops
        // forever AND hides it.
        if (!transient || attempt >= attempts) throw error;
        const base = backoffMs[attempt - 1] ?? backoffMs[backoffMs.length - 1] ?? 0;
        await sleep(Math.round(base * (0.8 + random() * 0.4)));
      }
    }
  }

  /** Drain the queue one batch at a time. Never throws, never rejects. */
  async function pump() {
    while (queue.length > 0) {
      inFlight = queue.shift();
      recount();
      try {
        const result = await writeWithRetry(inFlight);
        state.counters.persistedBatches += 1;
        state.counters.persistedObservations += result?.inserted ?? 0;
        // A REAL successful write is the only thing that establishes retention.
        state.set('available', null);
      } catch (error) {
        state.counters.failedBatches += 1;
        state.counters.droppedBatches += 1;
        const reason = error?.name === TRANSIENT_ERROR_NAME ? 'store-unavailable' : 'store-rejected';
        // The message may carry a table name or a constraint; the error CLASS
        // is all health needs, and all a log line gets.
        log.warn?.(
          `[panoptic] persistence dropped a batch from ${inFlight.label} after `
          + `${error?.name === TRANSIENT_ERROR_NAME ? attempts : 1} attempt(s): ${error?.name || 'Error'}`,
        );
        state.set('unavailable', reason);
      } finally {
        inFlight = null;
        recount();
      }
    }
    running = false;
    releaseIdleWaiters();
  }

  /** Start the worker if it is not already running. Returns nothing awaitable. */
  function kick() {
    if (running) return;
    running = true;
    // Detached on purpose: pump() contains its own failures, and nothing may
    // hand a promise back toward an HTTP handler.
    void pump();
  }

  return {
    /**
     * Offer a batch for persistence, synchronously.
     *
     * @param {string} label - Diagnostic origin, e.g. `celestrak:active`.
     * @param {object|(() => object)} batchOrProduce - A prepared batch, or a
     *   synchronous producer run inside the sink's error boundary.
     * @returns {{accepted: boolean, reason: string|null, queueDepth: number, observations: number}}
     *   A plain verdict. NEVER a promise and never a thenable.
     */
    submit(label, batchOrProduce) {
      const verdict = (accepted, reason, observations = 0) => ({
        accepted,
        reason,
        queueDepth: state.counters.pendingBatches,
        observations,
      });

      if (!admitting) return verdict(false, 'closing');

      let batch;
      if (typeof batchOrProduce === 'function') {
        try {
          batch = batchOrProduce();
        } catch (error) {
          // Evidence was acquired and PANOPTIC failed to retain it, so the
          // PIPELINE is impaired even though the database may be perfectly well.
          state.counters.droppedBatches += 1;
          log.warn?.(`[panoptic] persistence could not normalise ${label}: ${error?.message || error}`);
          state.set('unavailable', 'normalisation-failed');
          return verdict(false, 'normalisation-failed');
        }
      } else {
        batch = batchOrProduce;
      }

      if (!batch || !Array.isArray(batch.observations)) {
        state.counters.droppedBatches += 1;
        log.warn?.(`[panoptic] persistence rejected a malformed batch from ${label}`);
        state.set('unavailable', 'normalisation-failed');
        return verdict(false, 'normalisation-failed');
      }

      const count = batch.observations.length;
      const { batches, observations } = recount();
      if (batches + 1 > maxPendingBatches || observations + count > maxPendingObservations) {
        // REJECT THE NEW SUBMISSION. Already accepted evidence is never
        // replaced, superseded or discarded to make room — a newer element set
        // does not make an older one disposable.
        state.counters.droppedBatches += 1;
        log.warn?.(
          `[panoptic] persistence saturated (${batches} batches, ${observations} observations) `
          + `— refused ${count} observations from ${label}`,
        );
        state.set('unavailable', 'saturated');
        return verdict(false, 'saturated', count);
      }

      queue.push({ label, batch, count });
      recount();
      kick();
      return verdict(true, null, count);
    },

    /** Stop accepting new work. Already accepted batches still drain. */
    closeAdmission() {
      admitting = false;
    },

    /** Whether new submissions are still being accepted. */
    get admitting() {
      return admitting;
    },

    /**
     * Wait for accepted work to finish, bounded.
     *
     * @param {{timeoutMs?: number}} [options] - Bound.
     * @returns {Promise<boolean>} True when fully drained, false on timeout.
     */
    async drain({ timeoutMs = DEFAULT_DRAIN_TIMEOUT_MS } = {}) {
      if (isIdle()) return true;
      let timer = null;
      const drained = new Promise((resolve) => { idleWaiters.push(() => resolve(true)); });
      const expired = new Promise((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref?.();
      });
      try {
        return await Promise.race([drained, expired]);
      } finally {
        clearTimeout(timer);
      }
    },

    /** A bounded, non-sensitive state view. */
    state: () => state.snapshot(),
  };
}
