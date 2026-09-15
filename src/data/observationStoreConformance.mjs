// PANOPTIC Evidence Store conformance suite.
//
// NOT A TEST FILE — deliberately named without `.test.mjs` so the discovery
// walk in scripts/run-unit-tests.mjs does not execute it on its own. It is a
// suite FACTORY: every Evidence Store implementation imports it and runs the
// identical assertions, so a future backing store cannot quietly answer a
// question differently from the reference implementation. That is the whole
// point — the semantics live here, not in any one store.
//
// The scenarios are the ones that actually decide whether a temporal store is
// correct, and each is a case where a plausible implementation gets it wrong:
//
//   AIRCRAFT     collapsing a lineage by arrival time returns the most recently
//                RECEIVED position instead of the one in force at the time.
//   EARTHQUAKE   collapsing by event time alone returns the first estimate and
//                never the revision.
//   LATE ARRIVAL evidence that had not arrived yet must be invisible to an
//                as-known query, or every audit is retrospectively falsified.
//   FIRE         a detection has no state; answering `[]` would look like "we
//                had nothing" instead of "that is not a question about this".
//   ORBIT        the nearest element set is often in the FUTURE of the moment
//                being reconstructed, which is fine for physics and fatal for
//                causal reasoning.
//
// Usage: runObservationStoreConformance({ makeStore: createMemoryObservationStore })
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { BATCH_SCHEMA } from '../../server/contracts/observation/v1.js';
import { deriveObservationId } from '../../server/contracts/observation/identity.js';
import { validateBatch } from '../../server/contracts/observation/validate.js';
import { ELEMENT_SET_MODES, recordKeyOf, stateKeyOf } from '../../server/storage/contract.js';

/** Readable epoch ms on one fixed day, so scenarios read as clock times. */
const T = (hour, minute, second = 0) => Date.UTC(2026, 6, 16, hour, minute, second);

/**
 * Build a batch envelope around a list of observations.
 *
 * The suite stamps canonical ids HERE, playing the part of the normaliser,
 * because the store does not and must not mint identity: an Observation is
 * canonical before it reaches storage. An observation that already carries an
 * id keeps it, so a scenario can supply one deliberately.
 */
function batchOf({ source, observationType, ingestedAt, observations }) {
  const canonical = observations.map((observation) => (observation.observationId !== undefined
    ? observation
    : { ...observation, observationId: deriveObservationId({ ...observation, observationType }, source) }));

  return {
    schema: BATCH_SCHEMA,
    source,
    observationType,
    ingestedAt,
    derivation: [
      { method: 'source_reported', by: source.id },
      { method: 'ingested', by: 'panoptic.test', at: ingestedAt },
    ],
    observations: canonical,
  };
}

/** One ADS-B style position report. Geometry is REQUIRED for air.position. */
function position({ icao24, observedAt, lon, lat }) {
  return {
    observedAt,
    sourceRecordId: icao24,
    entityRef: { keys: { icao24, registration: 'G-PNPT' } },
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: { callsign: 'PAN123' },
  };
}

/** One USGS style seismic solution. Magnitude and depth are revision-bearing. */
function solution({ usgsId, observedAt, magnitude, depthM }) {
  return {
    observedAt,
    sourceRecordId: usgsId,
    geometry: { type: 'Point', coordinates: [-122.8, 38.8] },
    properties: { magnitude, depthM },
  };
}

/** One FIRMS style detection: no sourceRecordId, identity from content. */
function detection({ observedAt, lon, lat }) {
  return {
    observedAt,
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: { satellite: 'N20', instrument: 'VIIRS', confidence: 'n' },
  };
}

/** One CelesTrak style element set. Geometry is PROHIBITED for this type. */
function elementSet({ noradId, intlDesignator, observedAt, elementSetNumber }) {
  return {
    observedAt,
    sourceRecordId: String(noradId),
    entityRef: { keys: { noradId, intlDesignator } },
    properties: {
      elementSetNumber,
      meanMotion: 15.48958602,
      eccentricity: 0.0005055,
      inclinationDeg: 51.6312,
      raanDeg: 282.3953,
      argPerigeeDeg: 96.474,
      meanAnomalyDeg: 263.6825,
      bstar: 0.000079223,
    },
  };
}

const AIR = { id: 'adsb', feed: 'live' };
const USGS = { id: 'usgs' };
const FIRMS = { id: 'firms', feed: 'VIIRS_NOAA20_NRT' };
const CELESTRAK = { id: 'celestrak', feed: 'stations' };

/**
 * Register the conformance suite against one store implementation.
 *
 * @param {object} options - Options.
 * @param {() => object} options.makeStore - Factory returning an empty store.
 * @param {string} [options.label] - Implementation name, used in test titles.
 */
export function runObservationStoreConformance({ makeStore, label = 'observation store' }) {
  const name = (title) => `${label}: ${title}`;

  // Three positions of one aircraft, one minute apart. `cIngestedAt` lets a
  // scenario delay the arrival of the last one without changing when it was
  // observed — the distinction the whole store exists to preserve.
  function seedAircraft(store, { cIngestedAt = T(14, 32) } = {}) {
    store.insertBatch(batchOf({
      source: AIR,
      observationType: 'air.position',
      ingestedAt: T(14, 30),
      observations: [
        position({ icao24: 'abc123', observedAt: T(14, 30), lon: -0.1, lat: 51.5 }),
        // A second aircraft, so per-record grouping is actually exercised.
        position({ icao24: 'def456', observedAt: T(14, 29), lon: -0.2, lat: 51.6 }),
      ],
    }));
    store.insertBatch(batchOf({
      source: AIR,
      observationType: 'air.position',
      ingestedAt: T(14, 31),
      observations: [position({ icao24: 'abc123', observedAt: T(14, 31), lon: -0.11, lat: 51.51 })],
    }));
    store.insertBatch(batchOf({
      source: AIR,
      observationType: 'air.position',
      ingestedAt: cIngestedAt,
      observations: [position({ icao24: 'abc123', observedAt: T(14, 32), lon: -0.12, lat: 51.52 })],
    }));
  }

  // One earthquake, revised upward five minutes after the first solution.
  function seedEarthquake(store) {
    store.insertBatch(batchOf({
      source: USGS,
      observationType: 'ground.seismic_solution',
      ingestedAt: T(14, 0),
      observations: [solution({ usgsId: 'nc73912345', observedAt: T(13, 58), magnitude: 4.2, depthM: 8200 })],
    }));
    store.insertBatch(batchOf({
      source: USGS,
      observationType: 'ground.seismic_solution',
      ingestedAt: T(14, 5),
      observations: [solution({ usgsId: 'nc73912345', observedAt: T(13, 58), magnitude: 4.4, depthM: 8100 })],
    }));
  }

  // ---------------------------------------------------------------------
  // FIXTURE INTEGRITY
  // ---------------------------------------------------------------------

  test(name('conformance fixtures are valid Observation v1 batches'), () => {
    const batches = [
      batchOf({
        source: AIR,
        observationType: 'air.position',
        ingestedAt: T(14, 30),
        observations: [position({ icao24: 'abc123', observedAt: T(14, 30), lon: -0.1, lat: 51.5 })],
      }),
      batchOf({
        source: USGS,
        observationType: 'ground.seismic_solution',
        ingestedAt: T(14, 0),
        observations: [solution({ usgsId: 'nc73912345', observedAt: T(13, 58), magnitude: 4.2, depthM: 8200 })],
      }),
      batchOf({
        source: FIRMS,
        observationType: 'environment.fire_detection',
        ingestedAt: T(14, 0),
        observations: [detection({ observedAt: T(13, 0), lon: -121.67046, lat: 38.99488 })],
      }),
      batchOf({
        source: CELESTRAK,
        observationType: 'space.orbital_elements',
        ingestedAt: T(14, 0),
        observations: [elementSet({ noradId: 25544, intlDesignator: '98067A', observedAt: T(12, 0), elementSetNumber: 999 })],
      }),
    ];
    // Fully canonical, ids included — the shape the store actually requires.
    for (const batch of batches) {
      const result = validateBatch(batch);
      assert.deepEqual(result.problems, [], `${batch.source.id} fixture`);
      for (const observation of batch.observations) {
        assert.match(observation.observationId, /^obs_[a-z2-7]+$/);
      }
    }
  });

  // ---------------------------------------------------------------------
  // INSERTION AND IDEMPOTENCY
  // ---------------------------------------------------------------------

  test(name('accepts an observation that arrives with its canonical id'), () => {
    const store = makeStore();
    const result = store.insertBatch(batchOf({
      source: FIRMS,
      observationType: 'environment.fire_detection',
      ingestedAt: T(14, 0),
      observations: [detection({ observedAt: T(13, 0), lon: -121.67046, lat: 38.99488 })],
    }));
    assert.equal(result.inserted, 1);
    assert.match(result.observationIds[0], /^obs_[a-z2-7]+$/);
    assert.equal(store.get(result.observationIds[0]).observationType, 'environment.fire_detection');
  });

  test(name('REJECTS an observation with no observationId'), () => {
    // SOURCE -> NORMALISER -> canonical Observation v1 -> EVIDENCE STORE.
    // Identity is minted before the storage boundary. A store that filled in a
    // missing id would be a second implementation of identity, and it would
    // silently paper over a normaliser that had stopped emitting ids.
    const store = makeStore();
    const unstamped = {
      observedAt: T(13, 0),
      geometry: { type: 'Point', coordinates: [-121.67046, 38.99488] },
      properties: { satellite: 'N20', instrument: 'VIIRS' },
    };

    assert.throws(
      () => store.insertBatch({
        schema: BATCH_SCHEMA,
        source: FIRMS,
        observationType: 'environment.fire_detection',
        ingestedAt: T(14, 0),
        observations: [unstamped],
      }),
      /observationId is required/,
    );
    assert.equal(store.size(), 0, 'a rejected batch stores nothing');
  });

  test(name('never re-derives identity: the supplied id is the id'), () => {
    // Proof that no derivation happens behind the boundary. This id is NOT what
    // the identity algorithm would produce for this content; the store must
    // still key by exactly what it was given, and duplicate detection must use
    // that same value.
    const store = makeStore();
    const supplied = 'obs_suppliedbythenormaliser';
    const build = (ingestedAt) => ({
      schema: BATCH_SCHEMA,
      source: FIRMS,
      observationType: 'environment.fire_detection',
      ingestedAt,
      observations: [{ ...detection({ observedAt: T(13, 0), lon: -121.1, lat: 38.1 }), observationId: supplied }],
    });

    const first = store.insertBatch(build(T(14, 0)));
    assert.deepEqual(first.observationIds, [supplied]);
    assert.notEqual(
      supplied,
      deriveObservationId(
        { ...detection({ observedAt: T(13, 0), lon: -121.1, lat: 38.1 }), observationType: 'environment.fire_detection' },
        FIRMS,
      ),
      'the fixture id is deliberately not the derived one',
    );

    // Duplicate handling is keyed SOLELY by the supplied id.
    const second = store.insertBatch(build(T(15, 0)));
    assert.equal(second.duplicates, 1);
    assert.equal(store.size(), 1);
    assert.equal(store.get(supplied).ingestedAt, T(14, 0), 'KNOWLEDGE TIME unmoved');
  });

  test(name('re-inserting identical evidence is a no-op'), () => {
    const store = makeStore();
    const build = (ingestedAt) => batchOf({
      source: FIRMS,
      observationType: 'environment.fire_detection',
      ingestedAt,
      observations: [detection({ observedAt: T(13, 0), lon: -121.67046, lat: 38.99488 })],
    });

    const first = store.insertBatch(build(T(14, 0)));
    const second = store.insertBatch(build(T(15, 0)));

    assert.equal(first.inserted, 1);
    assert.equal(second.inserted, 0);
    assert.equal(second.duplicates, 1);
    assert.equal(store.size(), 1);
    assert.deepEqual(second.observationIds, first.observationIds);
  });

  test(name('duplicate delivery MUST NOT move KNOWLEDGE TIME'), () => {
    // The audit property. If a re-poll could advance ingestedAt, then evidence
    // would appear to have arrived later than it did, and every as-known query
    // over it would silently become wrong.
    const store = makeStore();
    const build = (ingestedAt) => batchOf({
      source: USGS,
      observationType: 'ground.seismic_solution',
      ingestedAt,
      observations: [solution({ usgsId: 'nc73912345', observedAt: T(13, 58), magnitude: 4.2, depthM: 8200 })],
    });

    const { observationIds: [id] } = store.insertBatch(build(T(14, 0)));
    store.insertBatch(build(T(23, 0)));

    assert.equal(store.get(id).ingestedAt, T(14, 0));
  });

  test(name('rejects a batch with no KNOWLEDGE TIME'), () => {
    const store = makeStore();
    assert.throws(
      () => store.insertBatch({ schema: BATCH_SCHEMA, source: USGS, observations: [] }),
      /ingestedAt/,
    );
  });

  // ---------------------------------------------------------------------
  // statesAt — SUCCESSIVE STATES (aircraft)
  // ---------------------------------------------------------------------

  test(name('statesAt returns the position in force, not the last received'), () => {
    const store = makeStore();
    seedAircraft(store);

    const rows = store.statesAt({ observationType: 'air.position', eventTime: T(14, 32) });
    const abc = rows.find((row) => row.sourceRecordId === 'abc123');

    assert.equal(abc.observedAt, T(14, 32), 'must select state C, observed at 14:32');
    assert.deepEqual(abc.observation.geometry.coordinates, [-0.12, 51.52]);
    assert.equal(rows.length, 2, 'one row per record, both aircraft');
  });

  test(name('statesAt hides evidence that had not arrived yet'), () => {
    // C was OBSERVED at 14:32 but did not REACH PANOPTIC until 14:40. Asked
    // what we knew at 14:35, the honest answer is B.
    const store = makeStore();
    seedAircraft(store, { cIngestedAt: T(14, 40) });

    const rows = store.statesAt({
      observationType: 'air.position',
      eventTime: T(14, 32),
      knowledgeTime: T(14, 35),
    });
    const abc = rows.find((row) => row.sourceRecordId === 'abc123');

    assert.equal(abc.observedAt, T(14, 31), 'must select state B: C was not yet known');
    assert.deepEqual(abc.observation.geometry.coordinates, [-0.11, 51.51]);
  });

  test(name('statesAt at an EVENT TIME before a record exists omits it'), () => {
    const store = makeStore();
    seedAircraft(store);
    const rows = store.statesAt({ observationType: 'air.position', eventTime: T(14, 29, 30) });
    assert.deepEqual(rows.map((row) => row.sourceRecordId), ['def456']);
  });

  test(name('statesAt boundary: an EVENT TIME exactly on a state includes it'), () => {
    const store = makeStore();
    seedAircraft(store);
    const rows = store.statesAt({ observationType: 'air.position', eventTime: T(14, 31) });
    const abc = rows.find((row) => row.sourceRecordId === 'abc123');
    assert.equal(abc.observedAt, T(14, 31));
  });

  // ---------------------------------------------------------------------
  // statesAt — REVISIONS OF ONE STATE (earthquake)
  // ---------------------------------------------------------------------

  test(name('statesAt returns the latest revision of one state'), () => {
    const store = makeStore();
    seedEarthquake(store);
    const [row] = store.statesAt({ observationType: 'ground.seismic_solution', eventTime: T(14, 32) });
    assert.equal(row.observation.properties.magnitude, 4.4);
  });

  test(name('statesAt as-known returns the belief held at that KNOWLEDGE TIME'), () => {
    const store = makeStore();
    seedEarthquake(store);
    const [row] = store.statesAt({
      observationType: 'ground.seismic_solution',
      eventTime: T(14, 32),
      knowledgeTime: T(14, 3),
    });
    assert.equal(row.observation.properties.magnitude, 4.2, 'M4.4 was not solved until 14:05');
  });

  test(name('a revision does not create a new state'), () => {
    const store = makeStore();
    seedEarthquake(store);
    const rows = store.statesAt({ observationType: 'ground.seismic_solution', eventTime: T(14, 32) });
    assert.equal(rows.length, 1, 'two versions of one assertion are still one state');
  });

  // ---------------------------------------------------------------------
  // statesAt — SEMANTIC BOUNDARIES
  // ---------------------------------------------------------------------

  test(name('statesAt THROWS for an occurrence type rather than returning []'), () => {
    // Returning an empty array would read as "nothing was burning", which is a
    // different and false claim from "that question does not apply here".
    const store = makeStore();
    store.insertBatch(batchOf({
      source: FIRMS,
      observationType: 'environment.fire_detection',
      ingestedAt: T(14, 0),
      observations: [detection({ observedAt: T(13, 0), lon: -121.67046, lat: 38.99488 })],
    }));

    assert.throws(
      () => store.statesAt({ observationType: 'environment.fire_detection', eventTime: T(14, 32) }),
      (error) => error.name === 'UnsupportedTemporalSemantics'
        && error.observationType === 'environment.fire_detection',
    );
  });

  test(name('statesAt THROWS for an unregistered type'), () => {
    const store = makeStore();
    assert.throws(
      () => store.statesAt({ observationType: 'not.a.type', eventTime: T(14, 32) }),
      (error) => error.name === 'UnknownObservationType',
    );
  });

  test(name('a STATE type without sourceRecordId is evidence, but not a state'), () => {
    // temporalSemantics is a property of the TYPE; sourceRecordId is a property
    // of the OBSERVATION. A state-semantics observation that carries no record
    // id is still valid evidence — Observation v1 permits sourceRecordId to be
    // absent — it simply has no lineage to hold a state.
    //
    // What must NOT happen: manufacturing a record identity out of
    // entityRef.keys. Those are CANDIDATE ENTITY keys, deliberately not source
    // record identity, and promoting them would invent a lineage the source
    // never asserted and silently make a track out of guesses.
    //
    // Equally, it must not be quietly reclassified as occurrence evidence. The
    // type still has state semantics; this particular record just is not
    // addressable as one.
    const store = makeStore();
    const anonymous = {
      // Supplied by the caller, since the store never mints identity.
      observationId: 'obs_lineagelesspositionfixture',
      observedAt: T(14, 30),
      entityRef: { keys: { icao24: 'abc123' } },
      geometry: { type: 'Point', coordinates: [-0.3, 51.7] },
      properties: {},
    };
    store.insertBatch(batchOf({
      source: { id: 'anon-adsb' },
      observationType: 'air.position',
      ingestedAt: T(14, 30),
      observations: [anonymous],
    }));

    // Both keys are null — including for a type with 'state' semantics, and
    // even though a candidate entity key is present.
    const typed = { ...anonymous, observationType: 'air.position' };
    assert.equal(recordKeyOf(typed, { id: 'anon-adsb' }), null);
    assert.equal(stateKeyOf(typed, { id: 'anon-adsb' }), null);

    // Not addressable as a state...
    assert.deepEqual(store.statesAt({ observationType: 'air.position', eventTime: T(14, 32) }), []);
    assert.deepEqual(store.recordHistory({ sourceId: 'anon-adsb', observationType: 'air.position' }), []);

    // ...but retained in full, and retrievable as evidence.
    const window = store.observationsBetween({ observationType: 'air.position', from: T(14, 0), to: T(15, 0) });
    assert.equal(window.length, 1);
    assert.equal(window[0].recordKey, null);
    assert.equal(window[0].stateKey, null);
    assert.equal(window[0].observationType, 'air.position', 'not reclassified as an occurrence');

    // Still reachable by candidate key, which is a query, not a lineage.
    assert.equal(store.entityHistory({ keys: { icao24: 'abc123' } }).observations.length, 1);

    // statesAt still refuses on SEMANTICS, not on this record's shape.
    assert.equal(store.statesAt({ observationType: 'air.position', eventTime: T(14, 32) }).length, 0);
    assert.throws(
      () => store.statesAt({ observationType: 'environment.fire_detection', eventTime: T(14, 32) }),
      (error) => error.name === 'UnsupportedTemporalSemantics',
    );
  });

  // ---------------------------------------------------------------------
  // observationsBetween — [from, to) WINDOWS
  // ---------------------------------------------------------------------

  test(name('windows are [from, to): start inclusive, end exclusive'), () => {
    const store = makeStore();
    store.insertBatch(batchOf({
      source: FIRMS,
      observationType: 'environment.fire_detection',
      ingestedAt: T(15, 0),
      observations: [
        detection({ observedAt: T(13, 0), lon: -121.1, lat: 38.1 }),
        detection({ observedAt: T(14, 0), lon: -121.2, lat: 38.2 }),
        detection({ observedAt: T(15, 0), lon: -121.3, lat: 38.3 }),
      ],
    }));

    const window = store.observationsBetween({
      observationType: 'environment.fire_detection',
      from: T(13, 0),
      to: T(15, 0),
    });

    assert.deepEqual(window.map((row) => row.observedAt), [T(13, 0), T(14, 0)]);
  });

  test(name('adjacent windows tile without double-counting a boundary'), () => {
    const store = makeStore();
    store.insertBatch(batchOf({
      source: FIRMS,
      observationType: 'environment.fire_detection',
      ingestedAt: T(15, 0),
      observations: [
        detection({ observedAt: T(13, 0), lon: -121.1, lat: 38.1 }),
        detection({ observedAt: T(14, 0), lon: -121.2, lat: 38.2 }),
        detection({ observedAt: T(14, 30), lon: -121.4, lat: 38.4 }),
        detection({ observedAt: T(15, 0), lon: -121.3, lat: 38.3 }),
      ],
    }));

    const query = (from, to) => store.observationsBetween({ observationType: 'environment.fire_detection', from, to });
    const early = query(T(13, 0), T(14, 0));
    const late = query(T(14, 0), T(16, 0));
    const whole = query(T(13, 0), T(16, 0));

    assert.equal(early.length + late.length, whole.length);
    const ids = new Set([...early, ...late].map((row) => row.observationId));
    assert.equal(ids.size, whole.length, 'no observation appears in both windows');
  });

  test(name('observationsBetween filters by KNOWLEDGE TIME and by source'), () => {
    const store = makeStore();
    seedAircraft(store, { cIngestedAt: T(14, 40) });

    const asKnown = store.observationsBetween({
      observationType: 'air.position',
      from: T(14, 0),
      to: T(15, 0),
      knowledgeTime: T(14, 35),
    });
    assert.equal(asKnown.some((row) => row.observedAt === T(14, 32)), false);

    assert.equal(store.observationsBetween({ sourceId: 'nobody' }).length, 0);
    assert.equal(store.observationsBetween({ sourceId: 'adsb', feed: 'live' }).length, 4);
  });

  // ---------------------------------------------------------------------
  // LINEAGE: recordHistory AND revisionsOf
  // ---------------------------------------------------------------------

  test(name('recordHistory returns every version of one record, oldest first'), () => {
    const store = makeStore();
    seedAircraft(store);
    const history = store.recordHistory({
      sourceId: 'adsb',
      feed: 'live',
      observationType: 'air.position',
      sourceRecordId: 'abc123',
    });
    assert.deepEqual(history.map((row) => row.observedAt), [T(14, 30), T(14, 31), T(14, 32)]);
  });

  test(name('recordHistory resolves revisions: one state, not two events'), () => {
    // A source changing its mind must not read as a second earthquake. The
    // versions are still there — `revisionsOf` is where they live.
    const store = makeStore();
    seedEarthquake(store);
    const history = store.recordHistory({
      sourceId: 'usgs',
      observationType: 'ground.seismic_solution',
      sourceRecordId: 'nc73912345',
    });
    assert.equal(history.length, 1, 'two versions of one instant are one state');
    assert.equal(history[0].observation.properties.magnitude, 4.4);
  });

  test(name('recordHistory as-known returns the belief held at that time'), () => {
    const store = makeStore();
    seedEarthquake(store);
    const history = store.recordHistory(
      { sourceId: 'usgs', observationType: 'ground.seismic_solution', sourceRecordId: 'nc73912345' },
      { knowledgeTime: T(14, 3) },
    );
    assert.deepEqual(history.map((row) => row.observation.properties.magnitude), [4.2]);
  });

  test(name('recordHistory honours the [from, to) window'), () => {
    const store = makeStore();
    seedAircraft(store);
    const selector = {
      sourceId: 'adsb', feed: 'live', observationType: 'air.position', sourceRecordId: 'abc123',
    };
    const history = store.recordHistory(selector, { from: T(14, 30), to: T(14, 32) });
    assert.deepEqual(history.map((row) => row.observedAt), [T(14, 30), T(14, 31)]);
  });

  test(name('a record key is scoped to its source and feed'), () => {
    // Two sources reporting the same aircraft are two records. Merging them
    // here would erase which source said what.
    const store = makeStore();
    seedAircraft(store);
    store.insertBatch(batchOf({
      source: { id: 'other-adsb', feed: 'live' },
      observationType: 'air.position',
      ingestedAt: T(14, 33),
      observations: [position({ icao24: 'abc123', observedAt: T(14, 33), lon: -0.13, lat: 51.53 })],
    }));

    const mine = store.recordHistory({
      sourceId: 'adsb', feed: 'live', observationType: 'air.position', sourceRecordId: 'abc123',
    });
    assert.equal(mine.length, 3, 'the other source is a separate record');
  });

  test(name('revisionsOf returns versions of one instant in knowledge order'), () => {
    const store = makeStore();
    seedEarthquake(store);
    const revisions = store.revisionsOf({
      sourceId: 'usgs',
      observationType: 'ground.seismic_solution',
      sourceRecordId: 'nc73912345',
      observedAt: T(13, 58),
    });
    assert.deepEqual(revisions.map((row) => row.observation.properties.magnitude), [4.2, 4.4]);
    assert.deepEqual(revisions.map((row) => row.ingestedAt), [T(14, 0), T(14, 5)]);
  });

  test(name('revisionsOf as-known hides revisions not yet received'), () => {
    const store = makeStore();
    seedEarthquake(store);
    const revisions = store.revisionsOf(
      { sourceId: 'usgs', observationType: 'ground.seismic_solution', sourceRecordId: 'nc73912345', observedAt: T(13, 58) },
      { knowledgeTime: T(14, 3) },
    );
    assert.deepEqual(revisions.map((row) => row.observation.properties.magnitude), [4.2]);
  });

  test(name('revisionsOf a state never asserted is empty, not an error'), () => {
    const store = makeStore();
    seedEarthquake(store);
    const revisions = store.revisionsOf({
      sourceId: 'usgs', observationType: 'ground.seismic_solution', sourceRecordId: 'nc00000000', observedAt: T(13, 58),
    });
    assert.deepEqual(revisions, []);
  });

  test(name('equal KNOWLEDGE TIMES resolve deterministically'), () => {
    // Two revisions of one instant delivered in the same millisecond: the store
    // cannot know which the source considered later, but it must not answer
    // differently on different runs or in a different implementation. The
    // tie-break is the observation id — arbitrary, and stable everywhere.
    const store = makeStore();
    const both = batchOf({
      source: USGS,
      observationType: 'ground.seismic_solution',
      ingestedAt: T(14, 0),
      observations: [
        solution({ usgsId: 'nc73912345', observedAt: T(13, 58), magnitude: 4.2, depthM: 8200 }),
        solution({ usgsId: 'nc73912345', observedAt: T(13, 58), magnitude: 4.4, depthM: 8100 }),
      ],
    });
    store.insertBatch(both);

    const revisions = store.revisionsOf({
      sourceId: 'usgs',
      observationType: 'ground.seismic_solution',
      sourceRecordId: 'nc73912345',
      observedAt: T(13, 58),
    });
    assert.equal(revisions.length, 2);
    assert.deepEqual(
      revisions.map((row) => row.observationId),
      [...revisions.map((row) => row.observationId)].sort(),
      'equal ingestedAt orders by observation id',
    );

    // A second store, fed in the opposite order, must agree.
    const mirrored = makeStore();
    mirrored.insertBatch({ ...both, observations: [...both.observations].reverse() });
    const [chosen] = store.statesAt({ observationType: 'ground.seismic_solution', eventTime: T(14, 32) });
    const [mirroredChoice] = mirrored.statesAt({ observationType: 'ground.seismic_solution', eventTime: T(14, 32) });
    assert.equal(chosen.observationId, mirroredChoice.observationId, 'insertion order must not decide');
  });

  // ---------------------------------------------------------------------
  // RECORD AND STATE KEY COMPOSITION
  // ---------------------------------------------------------------------

  test(name('the record key is composed of source, feed, type and record id'), () => {
    const base = { observationType: 'air.position', sourceRecordId: 'abc123', observedAt: T(14, 30) };
    const key = recordKeyOf(base, { id: 'adsb', feed: 'live' });

    // Every component participates: changing any one is a different record.
    assert.notEqual(recordKeyOf(base, { id: 'other', feed: 'live' }), key, 'source id participates');
    assert.notEqual(recordKeyOf(base, { id: 'adsb', feed: 'other' }), key, 'feed participates');
    assert.notEqual(
      recordKeyOf({ ...base, observationType: 'sea.position' }, { id: 'adsb', feed: 'live' }),
      key,
      'observationType participates',
    );
    assert.notEqual(
      recordKeyOf({ ...base, sourceRecordId: 'def456' }, { id: 'adsb', feed: 'live' }),
      key,
      'sourceRecordId participates',
    );
    // EVENT TIME does NOT: successive states belong to one record.
    assert.equal(recordKeyOf({ ...base, observedAt: T(23, 0) }, { id: 'adsb', feed: 'live' }), key);
  });

  test(name('no sourceRecordId means no record key and no state key'), () => {
    const detectionRow = { observationType: 'environment.fire_detection', observedAt: T(13, 0) };
    assert.equal(recordKeyOf(detectionRow, { id: 'firms' }), null);
    assert.equal(stateKeyOf(detectionRow, { id: 'firms' }), null);
  });

  test(name('EVENT TIME distinguishes state keys within one record'), () => {
    const source = { id: 'adsb', feed: 'live' };
    const at = (observedAt) => stateKeyOf({ observationType: 'air.position', sourceRecordId: 'abc123', observedAt }, source);
    assert.notEqual(at(T(14, 30)), at(T(14, 31)), 'two instants are two states');
    assert.equal(at(T(14, 30)), at(T(14, 30)), 'the same instant is the same state');
    // A state key is scoped by its record key, so two records never collide.
    const other = stateKeyOf(
      { observationType: 'air.position', sourceRecordId: 'def456', observedAt: T(14, 30) },
      source,
    );
    assert.notEqual(at(T(14, 30)), other);
  });

  // ---------------------------------------------------------------------
  // ENTITY CANDIDATE KEYS
  // ---------------------------------------------------------------------

  test(name('a partial candidate key matches a richer key set'), () => {
    const store = makeStore();
    seedAircraft(store);
    const result = store.entityHistory({ keys: { icao24: 'abc123' } });
    assert.equal(result.candidateKeyMatch, true);
    assert.deepEqual(result.matchedOn, ['icao24=abc123']);
    assert.equal(result.observations.length, 3);
  });

  test(name('candidate-key results carry no resolved entity id'), () => {
    // Observation v1 holds candidate keys only. A store that added a resolved
    // id would be inventing a conclusion no subsystem is entitled to draw.
    const store = makeStore();
    seedAircraft(store);
    const result = store.entityHistory({ keys: { icao24: 'abc123' } });
    assert.equal(result.entityId, undefined);
    for (const row of result.observations) {
      assert.equal(row.entityId, undefined);
      assert.equal(row.observation.entityId, undefined);
      assert.equal(row.observation.entityRef?.resolved, undefined);
    }
  });

  test(name('candidate keys join ACROSS sources'), () => {
    const store = makeStore();
    seedAircraft(store);
    store.insertBatch(batchOf({
      source: { id: 'other-adsb', feed: 'live' },
      observationType: 'air.position',
      ingestedAt: T(14, 33),
      observations: [position({ icao24: 'abc123', observedAt: T(14, 33), lon: -0.13, lat: 51.53 })],
    }));

    const { observations } = store.entityHistory({ keys: { icao24: 'abc123' } });
    assert.deepEqual([...new Set(observations.map((row) => row.source.id))].sort(), ['adsb', 'other-adsb']);
  });

  test(name('candidate keys are canonicalised per namespace'), () => {
    const store = makeStore();
    store.insertBatch(batchOf({
      source: CELESTRAK,
      observationType: 'space.orbital_elements',
      ingestedAt: T(14, 0),
      observations: [elementSet({ noradId: 1361, intlDesignator: '65034C', observedAt: T(12, 0), elementSetNumber: 900 })],
    }));

    // A zero-padded catalogue number is the SAME object, and a lowercase
    // designator is the same designator.
    assert.equal(store.entityHistory({ keys: { noradId: '01361' } }).observations.length, 1);
    assert.equal(store.entityHistory({ keys: { intlDesignator: '65034c' } }).observations.length, 1);
    // Case-only difference on a hex address is likewise not a different aircraft.
    seedAircraft(store);
    assert.equal(store.entityHistory({ keys: { icao24: 'ABC123' } }).observations.length, 3);
  });

  test(name('a mismatched value does not match'), () => {
    const store = makeStore();
    seedAircraft(store);
    assert.deepEqual(store.entityHistory({ keys: { icao24: 'ffffff' } }).observations, []);
    // The same characters under a different namespace are a different
    // identifier, and must not be compared across namespaces.
    assert.deepEqual(store.entityHistory({ keys: { mmsi: '000abc123' } }).observations, []);
  });

  test(name('an unrecognised namespace is not identity'), () => {
    // Otherwise any incidental field a source added could silently join
    // unrelated evidence together.
    const store = makeStore();
    seedAircraft(store);
    assert.deepEqual(store.entityHistory({ keys: { registration: 'G-PNPT' } }).observations, []);
    assert.deepEqual(store.entityHistory({ keys: {} }).observations, []);
    assert.deepEqual(store.entityHistory({ keys: { icao24: 'not-hex' } }).observations, []);
  });

  test(name('entityHistory honours window and KNOWLEDGE TIME'), () => {
    const store = makeStore();
    seedAircraft(store, { cIngestedAt: T(14, 40) });
    const { observations } = store.entityHistory({
      keys: { icao24: 'abc123' },
      from: T(14, 30),
      to: T(14, 32),
      knowledgeTime: T(14, 35),
    });
    assert.deepEqual(observations.map((row) => row.observedAt), [T(14, 30), T(14, 31)]);
  });

  test(name('entityHistory resolves revisions, so a re-solve is not movement'), () => {
    // A source revising one instant must not surface as the object having been
    // in two places. `revisionsOf` is where a caller goes for the versions.
    const store = makeStore();
    store.insertBatch(batchOf({
      source: CELESTRAK,
      observationType: 'space.orbital_elements',
      ingestedAt: T(14, 0),
      observations: [elementSet({ noradId: 25544, intlDesignator: '98067A', observedAt: T(12, 0), elementSetNumber: 998 })],
    }));
    store.insertBatch(batchOf({
      source: CELESTRAK,
      observationType: 'space.orbital_elements',
      ingestedAt: T(14, 10),
      observations: [elementSet({ noradId: 25544, intlDesignator: '98067A', observedAt: T(12, 0), elementSetNumber: 999 })],
    }));

    const { observations } = store.entityHistory({ keys: { noradId: 25544 } });
    assert.equal(observations.length, 1, 'one epoch, two element-set numbers, one state');
    assert.equal(observations[0].observation.properties.elementSetNumber, 999);
    assert.equal(
      store.revisionsOf({
        sourceId: 'celestrak',
        feed: 'stations',
        observationType: 'space.orbital_elements',
        sourceRecordId: '25544',
        observedAt: T(12, 0),
      }).length,
      2,
      'both versions remain auditable',
    );
  });

  test(name('a row matching on several keys appears once'), () => {
    const store = makeStore();
    store.insertBatch(batchOf({
      source: CELESTRAK,
      observationType: 'space.orbital_elements',
      ingestedAt: T(14, 0),
      observations: [elementSet({ noradId: 25544, intlDesignator: '98067A', observedAt: T(12, 0), elementSetNumber: 999 })],
    }));
    const { observations, matchedOn } = store.entityHistory({ keys: { noradId: 25544, intlDesignator: '98067A' } });
    assert.equal(observations.length, 1);
    assert.deepEqual(observations[0].matchedOn, ['intlDesignator=98067A', 'noradId=25544']);
    assert.deepEqual(matchedOn, ['intlDesignator=98067A', 'noradId=25544']);
  });

  // ---------------------------------------------------------------------
  // ORBITAL ELEMENT SELECTION
  // ---------------------------------------------------------------------

  function seedElementSets(store) {
    store.insertBatch(batchOf({
      source: CELESTRAK,
      observationType: 'space.orbital_elements',
      ingestedAt: T(12, 30),
      observations: [elementSet({ noradId: 25544, intlDesignator: '98067A', observedAt: T(12, 0), elementSetNumber: 998 })],
    }));
    store.insertBatch(batchOf({
      source: CELESTRAK,
      observationType: 'space.orbital_elements',
      ingestedAt: T(15, 30),
      observations: [elementSet({ noradId: 25544, intlDesignator: '98067A', observedAt: T(15, 0), elementSetNumber: 999 })],
    }));
  }

  test(name('causal mode never uses an element set from the future'), () => {
    const store = makeStore();
    seedElementSets(store);
    const chosen = store.elementSetFor({
      keys: { noradId: 25544 },
      eventTime: T(14, 0),
      mode: ELEMENT_SET_MODES.CAUSAL,
    });
    assert.equal(chosen.row.observedAt, T(12, 0));
    assert.equal(chosen.epochDeltaMs, -2 * 3600 * 1000);
    assert.equal(chosen.usesFutureEpoch, false);
  });

  test(name('reconstruction mode may use a LATER element set, and says so'), () => {
    // The 15:00 epoch is one hour from the moment of interest; the 12:00 epoch
    // is two. SGP4 is more accurate from the nearer one — but that answer is
    // hindsight, and the flag is what keeps it from being cited as evidence.
    const store = makeStore();
    seedElementSets(store);
    const chosen = store.elementSetFor({
      keys: { noradId: 25544 },
      eventTime: T(14, 0),
      mode: ELEMENT_SET_MODES.RECONSTRUCTION,
    });
    assert.equal(chosen.row.observedAt, T(15, 0));
    assert.equal(chosen.epochDeltaMs, 3600 * 1000);
    assert.equal(chosen.usesFutureEpoch, true);
  });

  test(name('EXAMPLE A: a future EPOCH does not mean future KNOWLEDGE'), () => {
    // eventTime 14:00, TLE epoch 15:00, ingestedAt 13:00.
    // The epoch is ahead of the moment asked about, so this is orbital
    // hindsight — but PANOPTIC already held the element set an hour earlier.
    // A flag that folded the two together would libel evidence we genuinely had.
    const store = makeStore();
    store.insertBatch(batchOf({
      source: CELESTRAK,
      observationType: 'space.orbital_elements',
      ingestedAt: T(13, 0),
      observations: [elementSet({ noradId: 25544, intlDesignator: '98067A', observedAt: T(15, 0), elementSetNumber: 999 })],
    }));

    const chosen = store.elementSetFor({
      keys: { noradId: 25544 },
      eventTime: T(14, 0),
      mode: ELEMENT_SET_MODES.RECONSTRUCTION,
    });
    assert.equal(chosen.usesFutureEpoch, true, 'epoch 15:00 is after eventTime 14:00');
    assert.equal(chosen.row.ingestedAt, T(13, 0));

    // And it remains available at a knowledge horizon after its ingestion.
    const asKnown = store.elementSetFor({
      keys: { noradId: 25544 },
      eventTime: T(14, 0),
      mode: ELEMENT_SET_MODES.RECONSTRUCTION,
      knowledgeTime: T(13, 30),
    });
    assert.equal(asKnown.usesFutureEpoch, true);
    assert.equal(asKnown.row.observedAt, T(15, 0), 'known evidence, future epoch');
  });

  test(name('EXAMPLE B: a past EPOCH can still be unavailable knowledge'), () => {
    // eventTime 14:00, TLE epoch 12:00, ingestedAt 15:00.
    // No future epoch at all — but PANOPTIC did not hold it until 15:00, so at
    // any earlier knowledge horizon it is simply absent. Availability is the
    // knowledgeTime filter's job, never a flag's.
    const store = makeStore();
    store.insertBatch(batchOf({
      source: CELESTRAK,
      observationType: 'space.orbital_elements',
      ingestedAt: T(15, 0),
      observations: [elementSet({ noradId: 25544, intlDesignator: '98067A', observedAt: T(12, 0), elementSetNumber: 998 })],
    }));

    const chosen = store.elementSetFor({ keys: { noradId: 25544 }, eventTime: T(14, 0) });
    assert.equal(chosen.usesFutureEpoch, false, 'epoch 12:00 precedes eventTime 14:00');

    assert.equal(
      store.elementSetFor({ keys: { noradId: 25544 }, eventTime: T(14, 0), knowledgeTime: T(14, 30) }),
      null,
      'not yet ingested at that knowledge horizon',
    );
    assert.equal(
      store.elementSetFor({ keys: { noradId: 25544 }, eventTime: T(14, 0), knowledgeTime: T(15, 30) }).row.observedAt,
      T(12, 0),
    );
  });

  test(name('neither mode may use evidence ingested after KNOWLEDGE TIME'), () => {
    const store = makeStore();
    seedElementSets(store);
    for (const mode of [ELEMENT_SET_MODES.CAUSAL, ELEMENT_SET_MODES.RECONSTRUCTION]) {
      // The 15:00 epoch arrived at 15:30; at a 14:00 horizon neither mode sees it.
      const chosen = store.elementSetFor({
        keys: { noradId: 25544 }, eventTime: T(14, 0), mode, knowledgeTime: T(14, 0),
      });
      assert.equal(chosen.row.observedAt, T(12, 0), `${mode} must not reach past the knowledge horizon`);
    }
  });

  test(name('causal mode also respects KNOWLEDGE TIME'), () => {
    const store = makeStore();
    seedElementSets(store);
    // The 12:00 element set existed, but PANOPTIC did not hold it until 12:30.
    assert.equal(
      store.elementSetFor({ keys: { noradId: 25544 }, eventTime: T(14, 0), knowledgeTime: T(12, 15) }),
      null,
    );
    assert.equal(
      store.elementSetFor({ keys: { noradId: 25544 }, eventTime: T(14, 0), knowledgeTime: T(12, 45) }).row.observedAt,
      T(12, 0),
    );
  });

  test(name('causal mode defaults, and an unknown mode is an error'), () => {
    const store = makeStore();
    seedElementSets(store);
    assert.equal(store.elementSetFor({ keys: { noradId: 25544 }, eventTime: T(14, 0) }).mode, ELEMENT_SET_MODES.CAUSAL);
    assert.throws(
      () => store.elementSetFor({ keys: { noradId: 25544 }, eventTime: T(14, 0), mode: 'best' }),
      /unknown element set mode/,
    );
  });

  test(name('elementSetFor returns null for an unknown satellite'), () => {
    const store = makeStore();
    seedElementSets(store);
    assert.equal(store.elementSetFor({ keys: { noradId: 99999 }, eventTime: T(14, 0) }), null);
  });

  test(name('element-set selection introduces no geometry and no position'), () => {
    // The approved ruling: propagated satellite positions are NOT evidence and
    // are never persisted. Selecting a set must hand back the element set as
    // stored — if a store ever computed a point here, an SGP4 output would
    // become indistinguishable from something a source actually reported.
    const store = makeStore();
    seedElementSets(store);
    const chosen = store.elementSetFor({ keys: { noradId: 25544 }, eventTime: T(14, 0) });

    assert.equal(chosen.row.observation.geometry, undefined);
    assert.equal(chosen.row.observation.position, undefined);
    assert.equal(chosen.position, undefined);
    for (const row of store.observationsBetween({ observationType: 'space.orbital_elements' })) {
      assert.equal(row.observation.geometry, undefined, 'no element set may acquire geometry');
    }
  });

  // ---------------------------------------------------------------------
  // IMMUTABILITY
  // ---------------------------------------------------------------------

  test(name('stored evidence is frozen and complete'), () => {
    const store = makeStore();
    seedAircraft(store);
    const [row] = store.statesAt({ observationType: 'air.position', eventTime: T(14, 32) });

    assert.equal(Object.isFrozen(row), true);
    assert.equal(Object.isFrozen(row.observation), true);
    // RULING: observations are stored whole. Nothing is thinned on the way in.
    assert.equal(row.observation.properties.callsign, 'PAN123');
    assert.deepEqual(row.observation.entityRef.keys, { icao24: 'abc123', registration: 'G-PNPT' });
    // The batch derivation prefix is composed onto the record, not referenced.
    assert.deepEqual(row.observation.derivation.map((step) => step.method), ['source_reported', 'ingested']);
  });

  test(name('insertion does not mutate the caller batch'), () => {
    // A collector must be able to hand its batch to the store and still hold
    // exactly what it built — a store that stamped ids or normalised fields in
    // place would make the collector's own output depend on having stored it.
    const store = makeStore();
    const batch = batchOf({
      source: AIR,
      observationType: 'air.position',
      ingestedAt: T(14, 30),
      observations: [position({ icao24: 'abc123', observedAt: T(14, 30), lon: -0.1, lat: 51.5 })],
    });
    const before = structuredClone(batch);
    store.insertBatch(batch);
    assert.deepEqual(batch, before);
  });

  test(name('mutating a caller batch after insert cannot alter stored evidence'), () => {
    const store = makeStore();
    const observations = [position({ icao24: 'abc123', observedAt: T(14, 30), lon: -0.1, lat: 51.5 })];
    const batch = batchOf({ source: AIR, observationType: 'air.position', ingestedAt: T(14, 30), observations });
    const { observationIds: [id] } = store.insertBatch(batch);

    observations[0].properties.callsign = 'TAMPERED';
    observations[0].observedAt = T(23, 0);

    const stored = store.get(id);
    assert.equal(stored.observedAt, T(14, 30));
    assert.notEqual(stored.observation.properties.callsign, 'TAMPERED');
  });
}
