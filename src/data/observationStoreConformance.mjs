// PANOPTIC Evidence Store conformance suite.
//
// NOT A TEST FILE — deliberately named without `.test.mjs` so the discovery
// walk in scripts/run-unit-tests.mjs does not execute it on its own. It is a
// suite FACTORY: every Evidence Store implementation imports it and runs the
// identical assertions, so a future backing store cannot quietly answer a
// question differently from the reference implementation. That is the whole
// point — the semantics live here, not in any one store.
//
// THE SUITE IS ASYNC ON PURPOSE. Every store call is awaited and every expected
// failure is asserted with `assert.rejects`. The in-memory store answers
// synchronously and needs no Promise wrappers — awaiting a plain value is a
// no-op — while a database adapter returns promises. One form fits both, which
// is the only way the same suite can ever test both.
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
//   ACCEPTANCE   a durable store has opinions a Map does not — a timestamp
//                cannot be NaN, JSON cannot hold a function. The reference must
//                refuse exactly what the database would refuse, or the two
//                disagree in production instead of here.
//
// Usage: runObservationStoreConformance({ makeStore: createMemoryObservationStore })
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';

import { BATCH_SCHEMA } from '../../server/contracts/observation/v1.js';
import { deriveObservationId } from '../../server/contracts/observation/identity.js';
import { validateBatch } from '../../server/contracts/observation/validate.js';
import {
  CANDIDATE_KEY_NAMESPACES,
  ELEMENT_SET_MODES,
  recordKeyOf,
  stateKeyOf,
} from '../../server/storage/contract.js';

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

/**
 * An observation carrying an explicit id, for acceptance-rule fixtures.
 *
 * These are built by hand rather than through `batchOf` because several of them
 * are deliberately UN-MINTABLE: a NaN event time has no canonical identity, so
 * the normaliser step could not stamp one even in principle. Supplying the id
 * keeps each test about the rule it names.
 */
function rawDetection(observationId, overrides = {}) {
  return {
    observationId,
    observedAt: T(13, 0),
    geometry: { type: 'Point', coordinates: [-121.1, 38.1] },
    properties: { satellite: 'N20', instrument: 'VIIRS' },
    ...overrides,
  };
}

/** A batch envelope around hand-built observations. */
function rawBatch(observations, overrides = {}) {
  return {
    schema: BATCH_SCHEMA,
    source: { id: 'firms', feed: 'VIIRS_NOAA20_NRT' },
    observationType: 'environment.fire_detection',
    ingestedAt: T(14, 0),
    observations,
    ...overrides,
  };
}

const AIR = { id: 'adsb', feed: 'live' };
const USGS = { id: 'usgs' };
const FIRMS = { id: 'firms', feed: 'VIIRS_NOAA20_NRT' };
const CELESTRAK = { id: 'celestrak', feed: 'stations' };

/**
 * Values no query may use as a millisecond bound.
 *
 * Absence is handled separately: `undefined` and `null` are the absence form for
 * an optional bound, and neither is an absence form for a required one.
 */
const INVALID_QUERY_TIMES = Object.freeze([
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['-Infinity', Number.NEGATIVE_INFINITY],
  ['fractional milliseconds', T(14, 0) + 0.5],
  ['an unsafe integer', Number.MAX_SAFE_INTEGER + 2],
  ['a numeric string', String(T(14, 0))],
]);

/** Values no durable store can hold as a millisecond timestamp. */
const UNSTORABLE_TIMES = Object.freeze([
  ['missing', undefined],
  ['null', null],
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['-Infinity', Number.NEGATIVE_INFINITY],
  ['fractional milliseconds', T(13, 0) + 0.5],
  ['an unsafe integer', Number.MAX_SAFE_INTEGER + 2],
  ['a numeric string', String(T(13, 0))],
]);

/**
 * Register the conformance suite against one store implementation.
 *
 * @param {object} options - Options.
 * @param {() => object|Promise<object>} options.makeStore - Factory returning an empty store.
 * @param {(store: object) => unknown} [options.destroyStore] - Released after each test.
 * @param {string} [options.label] - Implementation name, used in test titles.
 * @param {boolean|string} [options.skip] - Skip reason, for an adapter whose backing service is absent.
 */
export function runObservationStoreConformance({
  makeStore,
  destroyStore,
  label = 'observation store',
  skip = false,
}) {
  const it = (title, fn) => test(`${label}: ${title}`, { skip }, fn);

  // Stores are tracked so an adapter that holds a resource (a schema, a
  // connection) can release it. The memory store needs nothing, so
  // `destroyStore` is optional and this is a no-op for it.
  const live = [];
  const open = async () => {
    const store = await makeStore();
    live.push(store);
    return store;
  };
  afterEach(async () => {
    const stores = live.splice(0);
    if (!destroyStore) return;
    for (const store of stores) await destroyStore(store);
  });

  // Three positions of one aircraft, one minute apart. `cIngestedAt` lets a
  // scenario delay the arrival of the last one without changing when it was
  // observed — the distinction the whole store exists to preserve.
  async function seedAircraft(store, { cIngestedAt = T(14, 32) } = {}) {
    await store.insertBatch(batchOf({
      source: AIR,
      observationType: 'air.position',
      ingestedAt: T(14, 30),
      observations: [
        position({ icao24: 'abc123', observedAt: T(14, 30), lon: -0.1, lat: 51.5 }),
        // A second aircraft, so per-record grouping is actually exercised.
        position({ icao24: 'def456', observedAt: T(14, 29), lon: -0.2, lat: 51.6 }),
      ],
    }));
    await store.insertBatch(batchOf({
      source: AIR,
      observationType: 'air.position',
      ingestedAt: T(14, 31),
      observations: [position({ icao24: 'abc123', observedAt: T(14, 31), lon: -0.11, lat: 51.51 })],
    }));
    await store.insertBatch(batchOf({
      source: AIR,
      observationType: 'air.position',
      ingestedAt: cIngestedAt,
      observations: [position({ icao24: 'abc123', observedAt: T(14, 32), lon: -0.12, lat: 51.52 })],
    }));
  }

  // One earthquake, revised upward five minutes after the first solution.
  async function seedEarthquake(store) {
    await store.insertBatch(batchOf({
      source: USGS,
      observationType: 'ground.seismic_solution',
      ingestedAt: T(14, 0),
      observations: [solution({ usgsId: 'nc73912345', observedAt: T(13, 58), magnitude: 4.2, depthM: 8200 })],
    }));
    await store.insertBatch(batchOf({
      source: USGS,
      observationType: 'ground.seismic_solution',
      ingestedAt: T(14, 5),
      observations: [solution({ usgsId: 'nc73912345', observedAt: T(13, 58), magnitude: 4.4, depthM: 8100 })],
    }));
  }

  // ---------------------------------------------------------------------
  // FIXTURE INTEGRITY
  // ---------------------------------------------------------------------

  it('conformance fixtures are valid Observation v1 batches', async () => {
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

  it('accepts an observation that arrives with its canonical id', async () => {
    const store = await open();
    const result = await store.insertBatch(batchOf({
      source: FIRMS,
      observationType: 'environment.fire_detection',
      ingestedAt: T(14, 0),
      observations: [detection({ observedAt: T(13, 0), lon: -121.67046, lat: 38.99488 })],
    }));
    assert.equal(result.inserted, 1);
    assert.match(result.observationIds[0], /^obs_[a-z2-7]+$/);
    assert.equal((await store.get(result.observationIds[0])).observationType, 'environment.fire_detection');
  });

  it('REJECTS an observation with no observationId', async () => {
    // SOURCE -> NORMALISER -> canonical Observation v1 -> EVIDENCE STORE.
    // Identity is minted before the storage boundary. A store that filled in a
    // missing id would be a second implementation of identity, and it would
    // silently paper over a normaliser that had stopped emitting ids.
    const store = await open();
    const unstamped = {
      observedAt: T(13, 0),
      geometry: { type: 'Point', coordinates: [-121.67046, 38.99488] },
      properties: { satellite: 'N20', instrument: 'VIIRS' },
    };

    await assert.rejects(
      async () => store.insertBatch(rawBatch([unstamped])),
      /observationId is required/,
    );
    assert.equal(await store.size(), 0, 'a rejected batch stores nothing');
  });

  it('never re-derives identity: the supplied id is the id', async () => {
    // Proof that no derivation happens behind the boundary. This id is NOT what
    // the identity algorithm would produce for this content; the store must
    // still key by exactly what it was given, and duplicate detection must use
    // that same value.
    const store = await open();
    const supplied = 'obs_suppliedbythenormaliser';
    const build = (ingestedAt) => rawBatch(
      [{ ...detection({ observedAt: T(13, 0), lon: -121.1, lat: 38.1 }), observationId: supplied }],
      { ingestedAt },
    );

    const first = await store.insertBatch(build(T(14, 0)));
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
    const second = await store.insertBatch(build(T(15, 0)));
    assert.equal(second.duplicates, 1);
    assert.equal(await store.size(), 1);
    assert.equal((await store.get(supplied)).ingestedAt, T(14, 0), 'KNOWLEDGE TIME unmoved');
  });

  it('re-inserting identical evidence is a no-op', async () => {
    const store = await open();
    const build = (ingestedAt) => batchOf({
      source: FIRMS,
      observationType: 'environment.fire_detection',
      ingestedAt,
      observations: [detection({ observedAt: T(13, 0), lon: -121.67046, lat: 38.99488 })],
    });

    const first = await store.insertBatch(build(T(14, 0)));
    const second = await store.insertBatch(build(T(15, 0)));

    assert.equal(first.inserted, 1);
    assert.equal(second.inserted, 0);
    assert.equal(second.duplicates, 1);
    assert.equal(await store.size(), 1);
    assert.deepEqual(second.observationIds, first.observationIds);
  });

  it('duplicate delivery MUST NOT move KNOWLEDGE TIME', async () => {
    // The audit property. If a re-poll could advance ingestedAt, then evidence
    // would appear to have arrived later than it did, and every as-known query
    // over it would silently become wrong. KNOWLEDGE TIME is supplied semantic
    // data, never a clock reading taken when the row happened to be written.
    const store = await open();
    const build = (ingestedAt) => batchOf({
      source: USGS,
      observationType: 'ground.seismic_solution',
      ingestedAt,
      observations: [solution({ usgsId: 'nc73912345', observedAt: T(13, 58), magnitude: 4.2, depthM: 8200 })],
    });

    const { observationIds: [id] } = await store.insertBatch(build(T(14, 0)));
    await store.insertBatch(build(T(23, 0)));

    assert.equal((await store.get(id)).ingestedAt, T(14, 0));
  });

  it('the supplied KNOWLEDGE TIME is stored verbatim', async () => {
    // Not "now", not a commit time. A batch replayed from an archive keeps the
    // knowledge time the evidence actually had.
    const store = await open();
    const { observationIds: [id] } = await store.insertBatch(batchOf({
      source: USGS,
      observationType: 'ground.seismic_solution',
      ingestedAt: T(9, 17),
      observations: [solution({ usgsId: 'nc73999999', observedAt: T(9, 15), magnitude: 3.1, depthM: 5000 })],
    }));
    assert.equal((await store.get(id)).ingestedAt, T(9, 17));
  });

  it('rejects a batch with no KNOWLEDGE TIME', async () => {
    const store = await open();
    await assert.rejects(
      async () => store.insertBatch({ schema: BATCH_SCHEMA, source: USGS, observations: [] }),
      /ingestedAt/,
    );
  });

  // ---------------------------------------------------------------------
  // ACCEPTANCE RULES — what a durable store can actually hold
  // ---------------------------------------------------------------------

  it('a batch is atomic: one unacceptable observation stores nothing', async () => {
    // A half-applied batch is the worst outcome: the caller cannot retry without
    // wondering which rows landed. Preparation happens in full before anything
    // is applied, which is what a database transaction would give.
    const store = await open();
    await store.insertBatch(rawBatch([rawDetection('obs_atomicityfixtureexisting')]));
    assert.equal(await store.size(), 1);

    await assert.rejects(
      async () => store.insertBatch(rawBatch([
        rawDetection('obs_atomicityfixturegood', { observedAt: T(13, 10) }),
        rawDetection('obs_atomicityfixturebad', { observedAt: Number.NaN }),
      ])),
      /observedAt/,
    );

    assert.equal(await store.size(), 1, 'the acceptable row of a rejected batch is not stored');
    assert.equal(await store.get('obs_atomicityfixturegood'), null);
  });

  it('EVENT TIME must be a whole, safe millisecond integer', async () => {
    const store = await open();
    for (const [what, value] of UNSTORABLE_TIMES) {
      await assert.rejects(
        async () => store.insertBatch(rawBatch([rawDetection('obs_eventtimefixture', { observedAt: value })])),
        /observedAt/,
        `observedAt must reject ${what}`,
      );
    }
    assert.equal(await store.size(), 0);
  });

  it('KNOWLEDGE TIME must be a whole, safe millisecond integer', async () => {
    const store = await open();
    for (const [what, value] of UNSTORABLE_TIMES) {
      await assert.rejects(
        async () => store.insertBatch(rawBatch([rawDetection('obs_knowledgetimefixture')], { ingestedAt: value })),
        /ingestedAt/,
        `ingestedAt must reject ${what}`,
      );
    }
    assert.equal(await store.size(), 0);
  });

  it('storage accepts only registered observation types', async () => {
    const store = await open();
    const unknown = (error) => error.name === 'UnknownObservationType';

    await assert.rejects(
      async () => store.insertBatch(rawBatch([rawDetection('obs_typefixture')], { observationType: 'not.a.type' })),
      unknown,
    );
    await assert.rejects(
      async () => store.insertBatch(rawBatch([rawDetection('obs_typefixture')], { observationType: undefined })),
      unknown,
      'a missing type is not storable either',
    );
    assert.equal(await store.size(), 0);
  });

  it('a hoisted observationType is inherited, and a record may override it', async () => {
    const store = await open();
    await store.insertBatch(rawBatch([
      rawDetection('obs_hoistedtypefixture'),
      {
        observationId: 'obs_overriddentypefixture',
        observationType: 'air.position',
        observedAt: T(13, 5),
        sourceRecordId: 'abc123',
        geometry: { type: 'Point', coordinates: [-0.1, 51.5] },
        properties: {},
      },
    ]));

    assert.equal((await store.get('obs_hoistedtypefixture')).observationType, 'environment.fire_detection');
    assert.equal((await store.get('obs_overriddentypefixture')).observationType, 'air.position');
  });

  it('batch.source.id must be a non-empty string', async () => {
    const store = await open();
    for (const source of [undefined, {}, { id: '' }, { id: 42 }, { id: null }]) {
      await assert.rejects(
        async () => store.insertBatch(rawBatch([rawDetection('obs_sourcefixture')], { source })),
        /source\.id/,
      );
    }
    assert.equal(await store.size(), 0);
  });

  // ---------------------------------------------------------------------
  // ACCEPTANCE RULES — the stored form is JSON
  // ---------------------------------------------------------------------

  it('an undefined object property is stored as absent', async () => {
    const store = await open();
    await store.insertBatch(rawBatch([rawDetection('obs_undefinedpropfixture', {
      properties: { satellite: 'N20', instrument: 'VIIRS', note: undefined },
    })]));

    const { observation } = await store.get('obs_undefinedpropfixture');
    assert.equal('note' in observation.properties, false, 'absent, not stored as null');
    assert.deepEqual(observation.properties, { satellite: 'N20', instrument: 'VIIRS' });
  });

  it('negative zero is stored as zero', async () => {
    // JSON has one zero. Keeping two would mean the reference and a database
    // disagreed about a value that compares equal but serialises differently.
    const store = await open();
    await store.insertBatch(rawBatch([rawDetection('obs_negativezerofixture', {
      geometry: { type: 'Point', coordinates: [-0, 38.1] },
      properties: { drift: -0 },
    })]));

    const { observation } = await store.get('obs_negativezerofixture');
    assert.equal(Object.is(observation.properties.drift, -0), false);
    assert.equal(Object.is(observation.properties.drift, 0), true);
    assert.equal(Object.is(observation.geometry.coordinates[0], 0), true);
  });

  it('non-finite numbers are rejected, never stored as null', async () => {
    const store = await open();
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      await assert.rejects(
        async () => store.insertBatch(rawBatch([rawDetection('obs_nonfinitefixture', {
          properties: { satellite: 'N20', brightness: value },
        })])),
        /not JSON-representable/,
      );
    }
    assert.equal(await store.size(), 0);
  });

  it('undefined entries and holes in arrays are rejected, never stored as null', async () => {
    // JSON.stringify turns both into `null`, which silently invents a reading
    // that the source never made. Refusing is the only honest option.
    const store = await open();
    const sparse = [1, 2, 3];
    delete sparse[1];

    await assert.rejects(
      async () => store.insertBatch(rawBatch([rawDetection('obs_undefinedentryfixture', {
        properties: { satellite: 'N20', samples: [1, undefined, 3] },
      })])),
      /not JSON-representable/,
    );
    await assert.rejects(
      async () => store.insertBatch(rawBatch([rawDetection('obs_sparsearrayfixture', {
        properties: { satellite: 'N20', samples: sparse },
      })])),
      /not JSON-representable/,
    );
    assert.equal(await store.size(), 0);
  });

  it('values JSON cannot hold are rejected rather than reshaped', async () => {
    // Every one of these has a JSON.stringify behaviour that changes meaning: a
    // Date becomes a string, a Map becomes {}, a function disappears. A store
    // that accepted them would hold something different from what a database
    // would hold.
    class Sensor {}
    const store = await open();
    const unsupported = [
      ['a function', () => 'nope'],
      ['a symbol', Symbol('nope')],
      ['a bigint', 10n],
      ['a Date', new Date(T(13, 0))],
      ['a Map', new Map([['a', 1]])],
      ['a Set', new Set([1])],
      ['a RegExp', /nope/],
      ['a class instance', new Sensor()],
    ];

    for (const [what, value] of unsupported) {
      await assert.rejects(
        async () => store.insertBatch(rawBatch([rawDetection('obs_unsupportedvaluefixture', {
          properties: { satellite: 'N20', odd: value },
        })])),
        /not JSON-representable/,
        `must reject ${what}`,
      );
    }
    assert.equal(await store.size(), 0);
  });

  it('circular evidence is rejected', async () => {
    const store = await open();
    const properties = { satellite: 'N20' };
    properties.self = properties;

    await assert.rejects(
      async () => store.insertBatch(rawBatch([rawDetection('obs_circularfixture', { properties })])),
      /circular reference/,
    );
    assert.equal(await store.size(), 0);
  });

  it('symbol-keyed properties are not evidence', async () => {
    const store = await open();
    const properties = { satellite: 'N20', instrument: 'VIIRS' };
    properties[Symbol('internal')] = 'not evidence';

    await store.insertBatch(rawBatch([rawDetection('obs_symbolkeyfixture', { properties })]));

    const stored = (await store.get('obs_symbolkeyfixture')).observation;
    assert.equal(Object.getOwnPropertySymbols(stored.properties).length, 0);
    assert.deepEqual(stored.properties, { satellite: 'N20', instrument: 'VIIRS' });
  });

  it('nested objects and arrays survive preparation exactly', async () => {
    const store = await open();
    const properties = {
      satellite: 'N20',
      confidence: 'n',
      flags: ['day', 'high'],
      nested: { depth: { value: 1.25, ok: true, missing: null }, list: [[1, 2], [3]] },
      count: 0,
    };
    await store.insertBatch(rawBatch([rawDetection('obs_nestedfixture', { properties })]));

    const stored = (await store.get('obs_nestedfixture')).observation;
    assert.deepEqual(stored.properties, properties);
    assert.equal(Object.isFrozen(stored.properties.nested.depth), true);
    assert.equal(Object.isFrozen(stored.properties.flags), true);
  });

  it('within a batch, the first occurrence of an id wins', async () => {
    const store = await open();
    const result = await store.insertBatch(rawBatch([
      rawDetection('obs_withinbatchduplicate', { properties: { satellite: 'N20', order: 'first' } }),
      rawDetection('obs_withinbatchduplicate', { properties: { satellite: 'N20', order: 'second' } }),
    ]));

    assert.equal(result.inserted, 1);
    assert.equal(result.duplicates, 1);
    assert.deepEqual(result.observationIds, ['obs_withinbatchduplicate', 'obs_withinbatchduplicate']);
    assert.equal(await store.size(), 1);
    assert.equal((await store.get('obs_withinbatchduplicate')).observation.properties.order, 'first');
  });

  it('candidate-key namespace names cannot contain "="', async () => {
    // Storage may represent a candidate key as the token `namespace=value`, so a
    // namespace containing '=' would make the two halves ambiguous. Namespaces
    // are a closed allowlist, which is what keeps the split total.
    for (const namespace of Object.keys(CANDIDATE_KEY_NAMESPACES)) {
      assert.equal(namespace.includes('='), false, `${namespace} must not contain '='`);
      assert.match(namespace, /^[A-Za-z][A-Za-z0-9]*$/);
    }
  });

  // ---------------------------------------------------------------------
  // ACCEPTANCE RULES — feed, record id, and query arguments
  // ---------------------------------------------------------------------

  it('a stored feed is a non-empty string, null, or absent', async () => {
    const store = await open();
    await store.insertBatch(rawBatch([rawDetection('obs_feedstring')], {
      source: { id: 'firms', feed: 'VIIRS_NOAA20_NRT' },
    }));
    await store.insertBatch(rawBatch([rawDetection('obs_feednull', { observedAt: T(13, 1) })], {
      source: { id: 'firms', feed: null },
    }));
    await store.insertBatch(rawBatch([rawDetection('obs_feedabsent', { observedAt: T(13, 2) })], {
      source: { id: 'firms' },
    }));

    assert.equal((await store.get('obs_feedstring')).source.feed, 'VIIRS_NOAA20_NRT');
    assert.equal((await store.get('obs_feednull')).source.feed, null);
    assert.equal((await store.get('obs_feedabsent')).source.feed, null, 'absent and null are both "no feed"');
  });

  it('a non-string feed is rejected, never stringified', async () => {
    // A store that accepted `feed: 123` would hand back a number while a text
    // column handed back "123" — the same evidence, described differently.
    const store = await open();
    const rejected = [
      ['a number', 123],
      ['a boolean', true],
      ['an object', { name: 'live' }],
      ['an array', ['live']],
      ['a function', () => 'live'],
      ['a symbol', Symbol('live')],
      ['a bigint', 7n],
      ['an empty string', ''],
    ];

    for (const [what, feed] of rejected) {
      await assert.rejects(
        async () => store.insertBatch(rawBatch([rawDetection('obs_feedfixture')], { source: { id: 'firms', feed } })),
        /source\.feed/,
        `must reject ${what}`,
      );
    }
    assert.equal(await store.size(), 0);
  });

  it('the feed filter distinguishes "no filter" from "no feed"', async () => {
    const store = await open();
    await store.insertBatch(rawBatch([rawDetection('obs_withfeed')], {
      source: { id: 'firms', feed: 'VIIRS_NOAA20_NRT' },
    }));
    await store.insertBatch(rawBatch([rawDetection('obs_nofeed', { observedAt: T(13, 1) })], {
      source: { id: 'firms' },
    }));

    assert.equal((await store.observationsBetween({ sourceId: 'firms' })).length, 2, 'absent = no filter');
    assert.deepEqual(
      (await store.observationsBetween({ sourceId: 'firms', feed: null })).map((row) => row.observationId),
      ['obs_nofeed'],
      'null = only evidence from a source with no feed',
    );
    assert.deepEqual(
      (await store.observationsBetween({ sourceId: 'firms', feed: 'VIIRS_NOAA20_NRT' })).map((row) => row.observationId),
      ['obs_withfeed'],
    );
    await assert.rejects(async () => store.observationsBetween({ feed: 123 }), /feed filter/);
    await assert.rejects(async () => store.observationsBetween({ feed: '' }), /feed filter/);
  });

  it('an empty sourceRecordId is rejected, and absence keeps its meaning', async () => {
    const store = await open();
    await assert.rejects(
      async () => store.insertBatch(rawBatch([rawDetection('obs_emptyrecordid', { sourceRecordId: '' })])),
      /sourceRecordId must identify a record/,
    );
    assert.equal(await store.size(), 0);

    // Absent remains the approved unaddressable-evidence form.
    await store.insertBatch(rawBatch([rawDetection('obs_norecordid')]));
    const [row] = await store.observationsBetween({ observationType: 'environment.fire_detection' });
    assert.equal(row.recordKey, null);
    assert.equal(row.stateKey, null);

    // And a selector cannot smuggle an empty one in either.
    await assert.rejects(
      async () => store.recordHistory({
        sourceId: 'firms',
        feed: 'VIIRS_NOAA20_NRT',
        observationType: 'environment.fire_detection',
        sourceRecordId: '',
      }),
      /identifies nothing/,
    );
  });

  it('query time arguments must be whole, safe millisecond integers', async () => {
    // PANOPTIC time is integer epoch milliseconds in queries too. Rounding a
    // fractional bound would make a database answer a question the reference
    // never asked.
    const store = await open();
    const record = {
      sourceId: 'adsb', feed: 'live', observationType: 'air.position', sourceRecordId: 'abc123',
    };
    const state = { ...record, observedAt: T(14, 30) };

    for (const [what, value] of INVALID_QUERY_TIMES) {
      const reject = (fn, pattern) => assert.rejects(fn, pattern, what);
      await reject(async () => store.observationsBetween({ from: value }), /from/);
      await reject(async () => store.observationsBetween({ to: value }), /to/);
      await reject(async () => store.observationsBetween({ knowledgeTime: value }), /knowledgeTime/);
      await reject(async () => store.statesAt({ observationType: 'air.position', eventTime: value }), /eventTime/);
      await reject(
        async () => store.statesAt({ observationType: 'air.position', eventTime: T(14, 32), knowledgeTime: value }),
        /knowledgeTime/,
      );
      await reject(async () => store.recordHistory(record, { to: value }), /to/);
      await reject(async () => store.revisionsOf(state, { knowledgeTime: value }), /knowledgeTime/);
      await reject(async () => store.entityHistory({ keys: { icao24: 'abc123' }, from: value }), /from/);
      await reject(async () => store.elementSetFor({ keys: { noradId: 25544 }, eventTime: value }), /eventTime/);
    }
  });

  it('eventTime is required: neither absence nor null means "now"', async () => {
    const store = await open();
    for (const value of [undefined, null]) {
      await assert.rejects(
        async () => store.statesAt({ observationType: 'air.position', eventTime: value }),
        /eventTime is required/,
      );
      await assert.rejects(
        async () => store.elementSetFor({ keys: { noradId: 25544 }, eventTime: value }),
        /eventTime is required/,
      );
    }
  });

  it('an omitted or null window bound is unbounded', async () => {
    const store = await open();
    await store.insertBatch(batchOf({
      source: FIRMS,
      observationType: 'environment.fire_detection',
      ingestedAt: T(15, 0),
      observations: [
        detection({ observedAt: T(13, 0), lon: -121.1, lat: 38.1 }),
        detection({ observedAt: T(15, 0), lon: -121.3, lat: 38.3 }),
      ],
    }));

    const all = { observationType: 'environment.fire_detection' };
    assert.equal((await store.observationsBetween(all)).length, 2);
    assert.equal((await store.observationsBetween({ ...all, from: null, to: null })).length, 2);
    assert.equal((await store.observationsBetween({ ...all, from: T(14, 0) })).length, 1, 'unbounded above');
    assert.equal((await store.observationsBetween({ ...all, to: T(14, 0) })).length, 1, 'unbounded below');
  });

  it('from === to is a valid empty interval, and from > to is rejected', async () => {
    // Slicing a timeline at one instant legitimately yields nothing. A reversed
    // window is not an empty interval, it is a malformed question — answering []
    // would hide the caller's mistake.
    const store = await open();
    await store.insertBatch(batchOf({
      source: FIRMS,
      observationType: 'environment.fire_detection',
      ingestedAt: T(15, 0),
      observations: [detection({ observedAt: T(14, 0), lon: -121.2, lat: 38.2 })],
    }));
    const all = { observationType: 'environment.fire_detection' };

    assert.deepEqual(await store.observationsBetween({ ...all, from: T(14, 0), to: T(14, 0) }), []);
    assert.equal((await store.observationsBetween({ ...all, from: T(14, 0), to: T(14, 0, 1) })).length, 1);
    await assert.rejects(
      async () => store.observationsBetween({ ...all, from: T(15, 0), to: T(14, 0) }),
      /invalid window/,
    );
    await assert.rejects(
      async () => store.entityHistory({ keys: { icao24: 'abc123' }, from: T(15, 0), to: T(14, 0) }),
      /invalid window/,
    );
  });

  it('a state selector requires a whole, safe observedAt', async () => {
    const store = await open();
    const base = { sourceId: 'usgs', observationType: 'ground.seismic_solution', sourceRecordId: 'nc73912345' };

    await assert.rejects(async () => store.revisionsOf(base), /observedAt is required/);
    for (const [what, value] of INVALID_QUERY_TIMES) {
      await assert.rejects(async () => store.revisionsOf({ ...base, observedAt: value }), /observedAt/, what);
    }
  });

  it('the observationType filter means the same thing in every query', async () => {
    const store = await open();
    await seedAircraft(store);
    await store.insertBatch(batchOf({
      source: FIRMS,
      observationType: 'environment.fire_detection',
      ingestedAt: T(14, 0),
      observations: [detection({ observedAt: T(13, 0), lon: -121.1, lat: 38.1 })],
    }));

    assert.equal((await store.observationsBetween({})).length, 5, 'omitted = no filter');
    assert.equal((await store.observationsBetween({ observationType: 'air.position' })).length, 4);

    // null used to mean "all types" in one query and "no rows" in another. Both
    // reject it now, and so does an unregistered type: storage holds none, so
    // filtering by one could only return an empty result that looks like
    // evidence of absence.
    const unknown = (error) => error.name === 'UnknownObservationType';
    for (const bad of [null, 'not.a.type', 42]) {
      await assert.rejects(async () => store.observationsBetween({ observationType: bad }), unknown);
      await assert.rejects(
        async () => store.entityHistory({ keys: { icao24: 'abc123' }, observationType: bad }),
        unknown,
      );
    }

    // A selector's type builds a key rather than filtering, and must be
    // registered for the same reason.
    await assert.rejects(
      async () => store.recordHistory({ sourceId: 'adsb', observationType: 'not.a.type', sourceRecordId: 'abc123' }),
      unknown,
    );
  });

  // ---------------------------------------------------------------------
  // statesAt — SUCCESSIVE STATES (aircraft)
  // ---------------------------------------------------------------------

  it('statesAt returns the position in force, not the last received', async () => {
    const store = await open();
    await seedAircraft(store);

    const rows = await store.statesAt({ observationType: 'air.position', eventTime: T(14, 32) });
    const abc = rows.find((row) => row.sourceRecordId === 'abc123');

    assert.equal(abc.observedAt, T(14, 32), 'must select state C, observed at 14:32');
    assert.deepEqual(abc.observation.geometry.coordinates, [-0.12, 51.52]);
    assert.equal(rows.length, 2, 'one row per record, both aircraft');
  });

  it('statesAt hides evidence that had not arrived yet', async () => {
    // C was OBSERVED at 14:32 but did not REACH PANOPTIC until 14:40. Asked
    // what we knew at 14:35, the honest answer is B.
    const store = await open();
    await seedAircraft(store, { cIngestedAt: T(14, 40) });

    const rows = await store.statesAt({
      observationType: 'air.position',
      eventTime: T(14, 32),
      knowledgeTime: T(14, 35),
    });
    const abc = rows.find((row) => row.sourceRecordId === 'abc123');

    assert.equal(abc.observedAt, T(14, 31), 'must select state B: C was not yet known');
    assert.deepEqual(abc.observation.geometry.coordinates, [-0.11, 51.51]);
  });

  it('statesAt at an EVENT TIME before a record exists omits it', async () => {
    const store = await open();
    await seedAircraft(store);
    const rows = await store.statesAt({ observationType: 'air.position', eventTime: T(14, 29, 30) });
    assert.deepEqual(rows.map((row) => row.sourceRecordId), ['def456']);
  });

  it('statesAt boundary: an EVENT TIME exactly on a state includes it', async () => {
    const store = await open();
    await seedAircraft(store);
    const rows = await store.statesAt({ observationType: 'air.position', eventTime: T(14, 31) });
    const abc = rows.find((row) => row.sourceRecordId === 'abc123');
    assert.equal(abc.observedAt, T(14, 31));
  });

  // ---------------------------------------------------------------------
  // statesAt — REVISIONS OF ONE STATE (earthquake)
  // ---------------------------------------------------------------------

  it('statesAt returns the latest revision of one state', async () => {
    const store = await open();
    await seedEarthquake(store);
    const [row] = await store.statesAt({ observationType: 'ground.seismic_solution', eventTime: T(14, 32) });
    assert.equal(row.observation.properties.magnitude, 4.4);
  });

  it('statesAt as-known returns the belief held at that KNOWLEDGE TIME', async () => {
    const store = await open();
    await seedEarthquake(store);
    const [row] = await store.statesAt({
      observationType: 'ground.seismic_solution',
      eventTime: T(14, 32),
      knowledgeTime: T(14, 3),
    });
    assert.equal(row.observation.properties.magnitude, 4.2, 'M4.4 was not solved until 14:05');
  });

  it('a revision does not create a new state', async () => {
    const store = await open();
    await seedEarthquake(store);
    const rows = await store.statesAt({ observationType: 'ground.seismic_solution', eventTime: T(14, 32) });
    assert.equal(rows.length, 1, 'two versions of one assertion are still one state');
  });

  // ---------------------------------------------------------------------
  // statesAt — SEMANTIC BOUNDARIES
  // ---------------------------------------------------------------------

  it('statesAt THROWS for an occurrence type rather than returning []', async () => {
    // Returning an empty array would read as "nothing was burning", which is a
    // different and false claim from "that question does not apply here".
    const store = await open();
    await store.insertBatch(batchOf({
      source: FIRMS,
      observationType: 'environment.fire_detection',
      ingestedAt: T(14, 0),
      observations: [detection({ observedAt: T(13, 0), lon: -121.67046, lat: 38.99488 })],
    }));

    await assert.rejects(
      async () => store.statesAt({ observationType: 'environment.fire_detection', eventTime: T(14, 32) }),
      (error) => error.name === 'UnsupportedTemporalSemantics'
        && error.observationType === 'environment.fire_detection',
    );
  });

  it('statesAt THROWS for an unregistered type', async () => {
    const store = await open();
    await assert.rejects(
      async () => store.statesAt({ observationType: 'not.a.type', eventTime: T(14, 32) }),
      (error) => error.name === 'UnknownObservationType',
    );
  });

  it('a STATE type without sourceRecordId is evidence, but not a state', async () => {
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
    const store = await open();
    const anonymous = {
      // Supplied by the caller, since the store never mints identity.
      observationId: 'obs_lineagelesspositionfixture',
      observedAt: T(14, 30),
      entityRef: { keys: { icao24: 'abc123' } },
      geometry: { type: 'Point', coordinates: [-0.3, 51.7] },
      properties: {},
    };
    await store.insertBatch(batchOf({
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
    assert.deepEqual(await store.statesAt({ observationType: 'air.position', eventTime: T(14, 32) }), []);
    assert.deepEqual(await store.recordHistory({ sourceId: 'anon-adsb', observationType: 'air.position' }), []);

    // ...but retained in full, and retrievable as evidence.
    const window = await store.observationsBetween({ observationType: 'air.position', from: T(14, 0), to: T(15, 0) });
    assert.equal(window.length, 1);
    assert.equal(window[0].recordKey, null);
    assert.equal(window[0].stateKey, null);
    assert.equal(window[0].observationType, 'air.position', 'not reclassified as an occurrence');

    // Still reachable by candidate key, which is a query, not a lineage.
    assert.equal((await store.entityHistory({ keys: { icao24: 'abc123' } })).observations.length, 1);

    // statesAt still refuses on SEMANTICS, not on this record's shape.
    assert.equal((await store.statesAt({ observationType: 'air.position', eventTime: T(14, 32) })).length, 0);
    await assert.rejects(
      async () => store.statesAt({ observationType: 'environment.fire_detection', eventTime: T(14, 32) }),
      (error) => error.name === 'UnsupportedTemporalSemantics',
    );
  });

  // ---------------------------------------------------------------------
  // observationsBetween — [from, to) WINDOWS
  // ---------------------------------------------------------------------

  it('windows are [from, to): start inclusive, end exclusive', async () => {
    const store = await open();
    await store.insertBatch(batchOf({
      source: FIRMS,
      observationType: 'environment.fire_detection',
      ingestedAt: T(15, 0),
      observations: [
        detection({ observedAt: T(13, 0), lon: -121.1, lat: 38.1 }),
        detection({ observedAt: T(14, 0), lon: -121.2, lat: 38.2 }),
        detection({ observedAt: T(15, 0), lon: -121.3, lat: 38.3 }),
      ],
    }));

    const window = await store.observationsBetween({
      observationType: 'environment.fire_detection',
      from: T(13, 0),
      to: T(15, 0),
    });

    assert.deepEqual(window.map((row) => row.observedAt), [T(13, 0), T(14, 0)]);
  });

  it('adjacent windows tile without double-counting a boundary', async () => {
    const store = await open();
    await store.insertBatch(batchOf({
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
    const early = await query(T(13, 0), T(14, 0));
    const late = await query(T(14, 0), T(16, 0));
    const whole = await query(T(13, 0), T(16, 0));

    assert.equal(early.length + late.length, whole.length);
    const ids = new Set([...early, ...late].map((row) => row.observationId));
    assert.equal(ids.size, whole.length, 'no observation appears in both windows');
  });

  it('observationsBetween filters by KNOWLEDGE TIME and by source', async () => {
    const store = await open();
    await seedAircraft(store, { cIngestedAt: T(14, 40) });

    const asKnown = await store.observationsBetween({
      observationType: 'air.position',
      from: T(14, 0),
      to: T(15, 0),
      knowledgeTime: T(14, 35),
    });
    assert.equal(asKnown.some((row) => row.observedAt === T(14, 32)), false);

    assert.equal((await store.observationsBetween({ sourceId: 'nobody' })).length, 0);
    assert.equal((await store.observationsBetween({ sourceId: 'adsb', feed: 'live' })).length, 4);
  });

  // ---------------------------------------------------------------------
  // LINEAGE: recordHistory AND revisionsOf
  // ---------------------------------------------------------------------

  it('recordHistory returns every version of one record, oldest first', async () => {
    const store = await open();
    await seedAircraft(store);
    const history = await store.recordHistory({
      sourceId: 'adsb',
      feed: 'live',
      observationType: 'air.position',
      sourceRecordId: 'abc123',
    });
    assert.deepEqual(history.map((row) => row.observedAt), [T(14, 30), T(14, 31), T(14, 32)]);
  });

  it('recordHistory resolves revisions: one state, not two events', async () => {
    // A source changing its mind must not read as a second earthquake. The
    // versions are still there — `revisionsOf` is where they live.
    const store = await open();
    await seedEarthquake(store);
    const history = await store.recordHistory({
      sourceId: 'usgs',
      observationType: 'ground.seismic_solution',
      sourceRecordId: 'nc73912345',
    });
    assert.equal(history.length, 1, 'two versions of one instant are one state');
    assert.equal(history[0].observation.properties.magnitude, 4.4);
  });

  it('recordHistory as-known returns the belief held at that time', async () => {
    const store = await open();
    await seedEarthquake(store);
    const history = await store.recordHistory(
      { sourceId: 'usgs', observationType: 'ground.seismic_solution', sourceRecordId: 'nc73912345' },
      { knowledgeTime: T(14, 3) },
    );
    assert.deepEqual(history.map((row) => row.observation.properties.magnitude), [4.2]);
  });

  it('recordHistory honours the [from, to) window', async () => {
    const store = await open();
    await seedAircraft(store);
    const selector = {
      sourceId: 'adsb', feed: 'live', observationType: 'air.position', sourceRecordId: 'abc123',
    };
    const history = await store.recordHistory(selector, { from: T(14, 30), to: T(14, 32) });
    assert.deepEqual(history.map((row) => row.observedAt), [T(14, 30), T(14, 31)]);
  });

  it('a record key is scoped to its source and feed', async () => {
    // Two sources reporting the same aircraft are two records. Merging them
    // here would erase which source said what.
    const store = await open();
    await seedAircraft(store);
    await store.insertBatch(batchOf({
      source: { id: 'other-adsb', feed: 'live' },
      observationType: 'air.position',
      ingestedAt: T(14, 33),
      observations: [position({ icao24: 'abc123', observedAt: T(14, 33), lon: -0.13, lat: 51.53 })],
    }));

    const mine = await store.recordHistory({
      sourceId: 'adsb', feed: 'live', observationType: 'air.position', sourceRecordId: 'abc123',
    });
    assert.equal(mine.length, 3, 'the other source is a separate record');
  });

  it('revisionsOf returns versions of one instant in knowledge order', async () => {
    const store = await open();
    await seedEarthquake(store);
    const revisions = await store.revisionsOf({
      sourceId: 'usgs',
      observationType: 'ground.seismic_solution',
      sourceRecordId: 'nc73912345',
      observedAt: T(13, 58),
    });
    assert.deepEqual(revisions.map((row) => row.observation.properties.magnitude), [4.2, 4.4]);
    assert.deepEqual(revisions.map((row) => row.ingestedAt), [T(14, 0), T(14, 5)]);
  });

  it('revisionsOf as-known hides revisions not yet received', async () => {
    const store = await open();
    await seedEarthquake(store);
    const revisions = await store.revisionsOf(
      { sourceId: 'usgs', observationType: 'ground.seismic_solution', sourceRecordId: 'nc73912345', observedAt: T(13, 58) },
      { knowledgeTime: T(14, 3) },
    );
    assert.deepEqual(revisions.map((row) => row.observation.properties.magnitude), [4.2]);
  });

  it('revisionsOf a state never asserted is empty, not an error', async () => {
    const store = await open();
    await seedEarthquake(store);
    const revisions = await store.revisionsOf({
      sourceId: 'usgs', observationType: 'ground.seismic_solution', sourceRecordId: 'nc00000000', observedAt: T(13, 58),
    });
    assert.deepEqual(revisions, []);
  });

  it('equal KNOWLEDGE TIMES resolve deterministically', async () => {
    // Two revisions of one instant delivered in the same millisecond: the store
    // cannot know which the source considered later, but it must not answer
    // differently on different runs or in a different implementation. The
    // tie-break is the observation id — arbitrary, and stable everywhere.
    const store = await open();
    const both = batchOf({
      source: USGS,
      observationType: 'ground.seismic_solution',
      ingestedAt: T(14, 0),
      observations: [
        solution({ usgsId: 'nc73912345', observedAt: T(13, 58), magnitude: 4.2, depthM: 8200 }),
        solution({ usgsId: 'nc73912345', observedAt: T(13, 58), magnitude: 4.4, depthM: 8100 }),
      ],
    });
    await store.insertBatch(both);

    const revisions = await store.revisionsOf({
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
    const mirrored = await open();
    await mirrored.insertBatch({ ...both, observations: [...both.observations].reverse() });
    const [chosen] = await store.statesAt({ observationType: 'ground.seismic_solution', eventTime: T(14, 32) });
    const [mirroredChoice] = await mirrored.statesAt({ observationType: 'ground.seismic_solution', eventTime: T(14, 32) });
    assert.equal(chosen.observationId, mirroredChoice.observationId, 'insertion order must not decide');
  });

  // ---------------------------------------------------------------------
  // RECORD AND STATE KEY COMPOSITION
  // ---------------------------------------------------------------------

  it('the record key is composed of source, feed, type and record id', async () => {
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

  it('no sourceRecordId means no record key and no state key', async () => {
    const detectionRow = { observationType: 'environment.fire_detection', observedAt: T(13, 0) };
    assert.equal(recordKeyOf(detectionRow, { id: 'firms' }), null);
    assert.equal(stateKeyOf(detectionRow, { id: 'firms' }), null);
  });

  it('EVENT TIME distinguishes state keys within one record', async () => {
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

  it('a partial candidate key matches a richer key set', async () => {
    const store = await open();
    await seedAircraft(store);
    const result = await store.entityHistory({ keys: { icao24: 'abc123' } });
    assert.equal(result.candidateKeyMatch, true);
    assert.deepEqual(result.matchedOn, ['icao24=abc123']);
    assert.equal(result.observations.length, 3);
  });

  it('candidate-key results carry no resolved entity id', async () => {
    // Observation v1 holds candidate keys only. A store that added a resolved
    // id would be inventing a conclusion no subsystem is entitled to draw.
    const store = await open();
    await seedAircraft(store);
    const result = await store.entityHistory({ keys: { icao24: 'abc123' } });
    assert.equal(result.entityId, undefined);
    for (const row of result.observations) {
      assert.equal(row.entityId, undefined);
      assert.equal(row.observation.entityId, undefined);
      assert.equal(row.observation.entityRef?.resolved, undefined);
    }
  });

  it('candidate keys join ACROSS sources', async () => {
    const store = await open();
    await seedAircraft(store);
    await store.insertBatch(batchOf({
      source: { id: 'other-adsb', feed: 'live' },
      observationType: 'air.position',
      ingestedAt: T(14, 33),
      observations: [position({ icao24: 'abc123', observedAt: T(14, 33), lon: -0.13, lat: 51.53 })],
    }));

    const { observations } = await store.entityHistory({ keys: { icao24: 'abc123' } });
    assert.deepEqual([...new Set(observations.map((row) => row.source.id))].sort(), ['adsb', 'other-adsb']);
  });

  it('candidate keys are canonicalised per namespace', async () => {
    const store = await open();
    await store.insertBatch(batchOf({
      source: CELESTRAK,
      observationType: 'space.orbital_elements',
      ingestedAt: T(14, 0),
      observations: [elementSet({ noradId: 1361, intlDesignator: '65034C', observedAt: T(12, 0), elementSetNumber: 900 })],
    }));

    // A zero-padded catalogue number is the SAME object, and a lowercase
    // designator is the same designator.
    assert.equal((await store.entityHistory({ keys: { noradId: '01361' } })).observations.length, 1);
    assert.equal((await store.entityHistory({ keys: { intlDesignator: '65034c' } })).observations.length, 1);
    // Case-only difference on a hex address is likewise not a different aircraft.
    await seedAircraft(store);
    assert.equal((await store.entityHistory({ keys: { icao24: 'ABC123' } })).observations.length, 3);
  });

  it('a mismatched value does not match', async () => {
    const store = await open();
    await seedAircraft(store);
    assert.deepEqual((await store.entityHistory({ keys: { icao24: 'ffffff' } })).observations, []);
    // The same characters under a different namespace are a different
    // identifier, and must not be compared across namespaces.
    assert.deepEqual((await store.entityHistory({ keys: { mmsi: '000abc123' } })).observations, []);
  });

  it('an unrecognised namespace is not identity', async () => {
    // Otherwise any incidental field a source added could silently join
    // unrelated evidence together.
    const store = await open();
    await seedAircraft(store);
    assert.deepEqual((await store.entityHistory({ keys: { registration: 'G-PNPT' } })).observations, []);
    assert.deepEqual((await store.entityHistory({ keys: {} })).observations, []);
    assert.deepEqual((await store.entityHistory({ keys: { icao24: 'not-hex' } })).observations, []);
  });

  it('entityHistory honours window and KNOWLEDGE TIME', async () => {
    const store = await open();
    await seedAircraft(store, { cIngestedAt: T(14, 40) });
    const { observations } = await store.entityHistory({
      keys: { icao24: 'abc123' },
      from: T(14, 30),
      to: T(14, 32),
      knowledgeTime: T(14, 35),
    });
    assert.deepEqual(observations.map((row) => row.observedAt), [T(14, 30), T(14, 31)]);
  });

  it('entityHistory resolves revisions, so a re-solve is not movement', async () => {
    // A source revising one instant must not surface as the object having been
    // in two places. `revisionsOf` is where a caller goes for the versions.
    const store = await open();
    await store.insertBatch(batchOf({
      source: CELESTRAK,
      observationType: 'space.orbital_elements',
      ingestedAt: T(14, 0),
      observations: [elementSet({ noradId: 25544, intlDesignator: '98067A', observedAt: T(12, 0), elementSetNumber: 998 })],
    }));
    await store.insertBatch(batchOf({
      source: CELESTRAK,
      observationType: 'space.orbital_elements',
      ingestedAt: T(14, 10),
      observations: [elementSet({ noradId: 25544, intlDesignator: '98067A', observedAt: T(12, 0), elementSetNumber: 999 })],
    }));

    const { observations } = await store.entityHistory({ keys: { noradId: 25544 } });
    assert.equal(observations.length, 1, 'one epoch, two element-set numbers, one state');
    assert.equal(observations[0].observation.properties.elementSetNumber, 999);
    assert.equal(
      (await store.revisionsOf({
        sourceId: 'celestrak',
        feed: 'stations',
        observationType: 'space.orbital_elements',
        sourceRecordId: '25544',
        observedAt: T(12, 0),
      })).length,
      2,
      'both versions remain auditable',
    );
  });

  it('a row matching on several keys appears once', async () => {
    const store = await open();
    await store.insertBatch(batchOf({
      source: CELESTRAK,
      observationType: 'space.orbital_elements',
      ingestedAt: T(14, 0),
      observations: [elementSet({ noradId: 25544, intlDesignator: '98067A', observedAt: T(12, 0), elementSetNumber: 999 })],
    }));
    const { observations, matchedOn } = await store.entityHistory({ keys: { noradId: 25544, intlDesignator: '98067A' } });
    assert.equal(observations.length, 1);
    assert.deepEqual(observations[0].matchedOn, ['intlDesignator=98067A', 'noradId=25544']);
    assert.deepEqual(matchedOn, ['intlDesignator=98067A', 'noradId=25544']);
  });

  // ---------------------------------------------------------------------
  // ORBITAL ELEMENT SELECTION
  // ---------------------------------------------------------------------

  async function seedElementSets(store) {
    await store.insertBatch(batchOf({
      source: CELESTRAK,
      observationType: 'space.orbital_elements',
      ingestedAt: T(12, 30),
      observations: [elementSet({ noradId: 25544, intlDesignator: '98067A', observedAt: T(12, 0), elementSetNumber: 998 })],
    }));
    await store.insertBatch(batchOf({
      source: CELESTRAK,
      observationType: 'space.orbital_elements',
      ingestedAt: T(15, 30),
      observations: [elementSet({ noradId: 25544, intlDesignator: '98067A', observedAt: T(15, 0), elementSetNumber: 999 })],
    }));
  }

  it('causal mode never uses an element set from the future', async () => {
    const store = await open();
    await seedElementSets(store);
    const chosen = await store.elementSetFor({
      keys: { noradId: 25544 },
      eventTime: T(14, 0),
      mode: ELEMENT_SET_MODES.CAUSAL,
    });
    assert.equal(chosen.row.observedAt, T(12, 0));
    assert.equal(chosen.epochDeltaMs, -2 * 3600 * 1000);
    assert.equal(chosen.usesFutureEpoch, false);
  });

  it('reconstruction mode may use a LATER element set, and says so', async () => {
    // The 15:00 epoch is one hour from the moment of interest; the 12:00 epoch
    // is two. SGP4 is more accurate from the nearer one — but that answer is
    // hindsight, and the flag is what keeps it from being cited as evidence.
    const store = await open();
    await seedElementSets(store);
    const chosen = await store.elementSetFor({
      keys: { noradId: 25544 },
      eventTime: T(14, 0),
      mode: ELEMENT_SET_MODES.RECONSTRUCTION,
    });
    assert.equal(chosen.row.observedAt, T(15, 0));
    assert.equal(chosen.epochDeltaMs, 3600 * 1000);
    assert.equal(chosen.usesFutureEpoch, true);
  });

  it('EXAMPLE A: a future EPOCH does not mean future KNOWLEDGE', async () => {
    // eventTime 14:00, TLE epoch 15:00, ingestedAt 13:00.
    // The epoch is ahead of the moment asked about, so this is orbital
    // hindsight — but PANOPTIC already held the element set an hour earlier.
    // A flag that folded the two together would libel evidence we genuinely had.
    const store = await open();
    await store.insertBatch(batchOf({
      source: CELESTRAK,
      observationType: 'space.orbital_elements',
      ingestedAt: T(13, 0),
      observations: [elementSet({ noradId: 25544, intlDesignator: '98067A', observedAt: T(15, 0), elementSetNumber: 999 })],
    }));

    const chosen = await store.elementSetFor({
      keys: { noradId: 25544 },
      eventTime: T(14, 0),
      mode: ELEMENT_SET_MODES.RECONSTRUCTION,
    });
    assert.equal(chosen.usesFutureEpoch, true, 'epoch 15:00 is after eventTime 14:00');
    assert.equal(chosen.row.ingestedAt, T(13, 0));

    // And it remains available at a knowledge horizon after its ingestion.
    const asKnown = await store.elementSetFor({
      keys: { noradId: 25544 },
      eventTime: T(14, 0),
      mode: ELEMENT_SET_MODES.RECONSTRUCTION,
      knowledgeTime: T(13, 30),
    });
    assert.equal(asKnown.usesFutureEpoch, true);
    assert.equal(asKnown.row.observedAt, T(15, 0), 'known evidence, future epoch');
  });

  it('EXAMPLE B: a past EPOCH can still be unavailable knowledge', async () => {
    // eventTime 14:00, TLE epoch 12:00, ingestedAt 15:00.
    // No future epoch at all — but PANOPTIC did not hold it until 15:00, so at
    // any earlier knowledge horizon it is simply absent. Availability is the
    // knowledgeTime filter's job, never a flag's.
    const store = await open();
    await store.insertBatch(batchOf({
      source: CELESTRAK,
      observationType: 'space.orbital_elements',
      ingestedAt: T(15, 0),
      observations: [elementSet({ noradId: 25544, intlDesignator: '98067A', observedAt: T(12, 0), elementSetNumber: 998 })],
    }));

    const chosen = await store.elementSetFor({ keys: { noradId: 25544 }, eventTime: T(14, 0) });
    assert.equal(chosen.usesFutureEpoch, false, 'epoch 12:00 precedes eventTime 14:00');

    assert.equal(
      await store.elementSetFor({ keys: { noradId: 25544 }, eventTime: T(14, 0), knowledgeTime: T(14, 30) }),
      null,
      'not yet ingested at that knowledge horizon',
    );
    assert.equal(
      (await store.elementSetFor({ keys: { noradId: 25544 }, eventTime: T(14, 0), knowledgeTime: T(15, 30) })).row.observedAt,
      T(12, 0),
    );
  });

  it('neither mode may use evidence ingested after KNOWLEDGE TIME', async () => {
    const store = await open();
    await seedElementSets(store);
    for (const mode of [ELEMENT_SET_MODES.CAUSAL, ELEMENT_SET_MODES.RECONSTRUCTION]) {
      // The 15:00 epoch arrived at 15:30; at a 14:00 horizon neither mode sees it.
      const chosen = await store.elementSetFor({
        keys: { noradId: 25544 }, eventTime: T(14, 0), mode, knowledgeTime: T(14, 0),
      });
      assert.equal(chosen.row.observedAt, T(12, 0), `${mode} must not reach past the knowledge horizon`);
    }
  });

  it('causal mode also respects KNOWLEDGE TIME', async () => {
    const store = await open();
    await seedElementSets(store);
    // The 12:00 element set existed, but PANOPTIC did not hold it until 12:30.
    assert.equal(
      await store.elementSetFor({ keys: { noradId: 25544 }, eventTime: T(14, 0), knowledgeTime: T(12, 15) }),
      null,
    );
    assert.equal(
      (await store.elementSetFor({ keys: { noradId: 25544 }, eventTime: T(14, 0), knowledgeTime: T(12, 45) })).row.observedAt,
      T(12, 0),
    );
  });

  it('causal mode defaults, and an unknown mode is an error', async () => {
    const store = await open();
    await seedElementSets(store);
    assert.equal(
      (await store.elementSetFor({ keys: { noradId: 25544 }, eventTime: T(14, 0) })).mode,
      ELEMENT_SET_MODES.CAUSAL,
    );
    await assert.rejects(
      async () => store.elementSetFor({ keys: { noradId: 25544 }, eventTime: T(14, 0), mode: 'best' }),
      /unknown element set mode/,
    );
  });

  it('elementSetFor returns null for an unknown satellite', async () => {
    const store = await open();
    await seedElementSets(store);
    assert.equal(await store.elementSetFor({ keys: { noradId: 99999 }, eventTime: T(14, 0) }), null);
  });

  it('element-set selection introduces no geometry and no position', async () => {
    // The approved ruling: propagated satellite positions are NOT evidence and
    // are never persisted. Selecting a set must hand back the element set as
    // stored — if a store ever computed a point here, an SGP4 output would
    // become indistinguishable from something a source actually reported.
    const store = await open();
    await seedElementSets(store);
    const chosen = await store.elementSetFor({ keys: { noradId: 25544 }, eventTime: T(14, 0) });

    assert.equal(chosen.row.observation.geometry, undefined);
    assert.equal(chosen.row.observation.position, undefined);
    assert.equal(chosen.position, undefined);
    for (const row of await store.observationsBetween({ observationType: 'space.orbital_elements' })) {
      assert.equal(row.observation.geometry, undefined, 'no element set may acquire geometry');
    }
  });

  // ---------------------------------------------------------------------
  // ORBITAL ELEMENTS — REVISION RESOLUTION IS NOT EPOCH SELECTION
  // ---------------------------------------------------------------------
  //
  // Three selections, kept apart:
  //   CANDIDATE MATCH    which observations describe this object at all
  //   REVISION SELECTION which version of one state is in force — the ordinary
  //                      PANOPTIC rule, IDENTICAL in both modes
  //   EPOCH SELECTION    which element set to propagate from — the ONLY thing a
  //                      mode changes
  //
  // A mode is a question about orbits. It must never become a different theory
  // of what supersedes what.

  it('revision resolution precedes epoch selection, in BOTH modes', async () => {
    const store = await open();
    await store.insertBatch(batchOf({
      source: CELESTRAK,
      observationType: 'space.orbital_elements',
      ingestedAt: T(12, 30),
      observations: [elementSet({ noradId: 25544, intlDesignator: '98067A', observedAt: T(12, 0), elementSetNumber: 998 })],
    }));
    await store.insertBatch(batchOf({
      source: CELESTRAK,
      observationType: 'space.orbital_elements',
      ingestedAt: T(12, 40),
      observations: [elementSet({ noradId: 25544, intlDesignator: '98067A', observedAt: T(12, 0), elementSetNumber: 999 })],
    }));

    for (const mode of [ELEMENT_SET_MODES.CAUSAL, ELEMENT_SET_MODES.RECONSTRUCTION]) {
      const chosen = await store.elementSetFor({ keys: { noradId: 25544 }, eventTime: T(14, 0), mode });
      assert.equal(
        chosen.row.observation.properties.elementSetNumber,
        999,
        `${mode} must use the revision in force for that epoch`,
      );
      assert.equal(chosen.mode, mode, 'the mode stays explicit on the result');
      assert.equal(chosen.usesFutureEpoch, false);
    }
  });

  it('two records at the same epoch resolve identically in BOTH modes', async () => {
    // CelesTrak groups overlap: the ISS arrives in `stations` and in `active`,
    // with the same epoch. These are two RECORDS, not two revisions, so the
    // collapse never merges them — and the choice between them must still be
    // the same in both modes. Latest knowledge wins, as it does everywhere else.
    const store = await open();
    await store.insertBatch(batchOf({
      source: { id: 'celestrak', feed: 'stations' },
      observationType: 'space.orbital_elements',
      ingestedAt: T(12, 30),
      observations: [elementSet({ noradId: 25544, intlDesignator: '98067A', observedAt: T(12, 0), elementSetNumber: 998 })],
    }));
    await store.insertBatch(batchOf({
      source: { id: 'celestrak', feed: 'active' },
      observationType: 'space.orbital_elements',
      ingestedAt: T(12, 40),
      observations: [elementSet({ noradId: 25544, intlDesignator: '98067A', observedAt: T(12, 0), elementSetNumber: 999 })],
    }));

    const chosen = [];
    for (const mode of [ELEMENT_SET_MODES.CAUSAL, ELEMENT_SET_MODES.RECONSTRUCTION]) {
      chosen.push(await store.elementSetFor({ keys: { noradId: 25544 }, eventTime: T(14, 0), mode }));
    }
    assert.equal(
      chosen[0].row.observationId,
      chosen[1].row.observationId,
      'causal and reconstruction must not break a same-epoch tie in opposite directions',
    );
    assert.equal(chosen[0].row.source.feed, 'active', 'later knowledge wins, in both modes');
  });

  it('KNOWLEDGE TIME can expose an earlier revision in BOTH modes', async () => {
    const store = await open();
    await store.insertBatch(batchOf({
      source: CELESTRAK,
      observationType: 'space.orbital_elements',
      ingestedAt: T(12, 30),
      observations: [elementSet({ noradId: 25544, intlDesignator: '98067A', observedAt: T(12, 0), elementSetNumber: 998 })],
    }));
    await store.insertBatch(batchOf({
      source: CELESTRAK,
      observationType: 'space.orbital_elements',
      ingestedAt: T(12, 40),
      observations: [elementSet({ noradId: 25544, intlDesignator: '98067A', observedAt: T(12, 0), elementSetNumber: 999 })],
    }));

    for (const mode of [ELEMENT_SET_MODES.CAUSAL, ELEMENT_SET_MODES.RECONSTRUCTION]) {
      const chosen = await store.elementSetFor({
        keys: { noradId: 25544 }, eventTime: T(14, 0), mode, knowledgeTime: T(12, 35),
      });
      assert.equal(
        chosen.row.observation.properties.elementSetNumber,
        998,
        `${mode} at a 12:35 horizon held only the first solution`,
      );
    }
  });

  it('reconstruction prefers the earlier epoch when two are equidistant', async () => {
    // Deterministic, and independent of insertion order: without a rule the
    // answer would flip between runs.
    const store = await open();
    await store.insertBatch(batchOf({
      source: CELESTRAK,
      observationType: 'space.orbital_elements',
      ingestedAt: T(11, 0),
      observations: [elementSet({ noradId: 25544, intlDesignator: '98067A', observedAt: T(13, 0), elementSetNumber: 997 })],
    }));
    await store.insertBatch(batchOf({
      source: CELESTRAK,
      observationType: 'space.orbital_elements',
      ingestedAt: T(11, 0),
      observations: [elementSet({ noradId: 25544, intlDesignator: '98067A', observedAt: T(15, 0), elementSetNumber: 999 })],
    }));

    const chosen = await store.elementSetFor({
      keys: { noradId: 25544 },
      eventTime: T(14, 0),
      mode: ELEMENT_SET_MODES.RECONSTRUCTION,
    });
    assert.equal(chosen.row.observedAt, T(13, 0));
    assert.equal(chosen.epochDeltaMs, -3600 * 1000);
    assert.equal(chosen.usesFutureEpoch, false);
  });

  // ---------------------------------------------------------------------
  // QUERY ARGUMENT PARITY
  // ---------------------------------------------------------------------

  it('the sourceId filter is an exact, non-empty string or absent', async () => {
    const store = await open();
    await store.insertBatch(rawBatch([rawDetection('obs_sourcea')], { source: { id: 'firms' } }));
    await store.insertBatch(rawBatch([rawDetection('obs_sourceb', { observedAt: T(13, 1) })], {
      source: { id: 'other-firms' },
    }));

    assert.equal((await store.observationsBetween({})).length, 2, 'omitted = no source filter');
    assert.deepEqual(
      (await store.observationsBetween({ sourceId: 'firms' })).map((row) => row.observationId),
      ['obs_sourcea'],
    );

    for (const [what, sourceId] of [
      ['null', null],
      ['an empty string', ''],
      ['a number', 123],
      ['a boolean', true],
      ['an object', { id: 'firms' }],
      ['an array', ['firms']],
      ['a function', () => 'firms'],
      ['a symbol', Symbol('firms')],
      ['a bigint', 7n],
    ]) {
      await assert.rejects(async () => store.observationsBetween({ sourceId }), /sourceId/, `must reject ${what}`);
      await assert.rejects(
        async () => store.statesAt({ observationType: 'air.position', eventTime: T(14, 32), sourceId }),
        /sourceId/,
        `statesAt must reject ${what}`,
      );
    }
  });

  it('a numeric source id is never stringified into a match', async () => {
    // The source really is called "123". Asking for the number 123 is a
    // different question, and coercing it would answer one the caller never put.
    const store = await open();
    await store.insertBatch(rawBatch([rawDetection('obs_numericsource')], { source: { id: '123' } }));

    assert.equal((await store.observationsBetween({ sourceId: '123' })).length, 1);
    await assert.rejects(async () => store.observationsBetween({ sourceId: 123 }), /sourceId/);
  });

  it('get requires a non-empty string, and an unknown id returns null', async () => {
    // A Map tolerates any key; a SQL parameter would coerce one. Without a rule
    // those are two different API contracts for the same call.
    const store = await open();
    await store.insertBatch(rawBatch([rawDetection('obs_getfixture')]));

    assert.equal((await store.get('obs_getfixture')).observationId, 'obs_getfixture');
    assert.equal(await store.get('obs_neverstored'), null, 'well-formed but unknown is an answer');

    for (const [what, value] of [
      ['undefined', undefined],
      ['null', null],
      ['an empty string', ''],
      ['a number', 123],
      ['a boolean', true],
      ['an object', { observationId: 'obs_getfixture' }],
      ['an array', ['obs_getfixture']],
      ['a symbol', Symbol('obs')],
      ['a bigint', 7n],
    ]) {
      await assert.rejects(async () => store.get(value), /observationId/, `must reject ${what}`);
    }
  });

  it('element-set mode is one shared rule, with causal as the default', async () => {
    const store = await open();
    await seedElementSets(store);
    const ask = (mode) => store.elementSetFor({ keys: { noradId: 25544 }, eventTime: T(14, 0), mode });

    assert.equal((await ask(undefined)).mode, ELEMENT_SET_MODES.CAUSAL, 'the committed default is preserved');
    assert.equal((await ask(ELEMENT_SET_MODES.CAUSAL)).mode, ELEMENT_SET_MODES.CAUSAL);
    assert.equal((await ask(ELEMENT_SET_MODES.RECONSTRUCTION)).mode, ELEMENT_SET_MODES.RECONSTRUCTION);

    for (const mode of ['best', '', 'CAUSAL', null, 42, true, Symbol('mode')]) {
      await assert.rejects(async () => ask(mode), /unknown element set mode/);
    }
  });

  it('raw canonical key selectors are opaque: never parsed, never validated', async () => {
    // There is exactly one key encoder, in contract.js. A decoder here would be
    // a second implementation of the format, and the two would eventually
    // disagree about some record.
    const store = await open();
    await seedAircraft(store);
    const parts = {
      sourceId: 'adsb', feed: 'live', observationType: 'air.position', sourceRecordId: 'abc123',
    };
    const [first] = await store.recordHistory(parts);

    // A key the store itself handed back round-trips as a selector.
    assert.equal((await store.recordHistory(first.recordKey)).length, 3);
    assert.equal((await store.revisionsOf(first.stateKey)).length, 1);
    assert.equal((await store.recordHistory({ recordKey: first.recordKey })).length, 3);
    assert.equal((await store.revisionsOf({ stateKey: first.stateKey })).length, 1);

    // A string that is not a canonical key is not an error — it simply matches
    // nothing, in both the raw and the object form.
    assert.deepEqual(await store.recordHistory('not-a-canonical-key'), []);
    assert.deepEqual(await store.revisionsOf('not-a-canonical-key'), []);
    assert.deepEqual(await store.recordHistory({ recordKey: 'still-not-a-key' }), []);
    assert.deepEqual(await store.revisionsOf({ stateKey: 'still-not-a-key' }), []);
  });

  // ---------------------------------------------------------------------
  // IMMUTABILITY
  // ---------------------------------------------------------------------

  it('stored evidence is frozen and complete', async () => {
    const store = await open();
    await seedAircraft(store);
    const [row] = await store.statesAt({ observationType: 'air.position', eventTime: T(14, 32) });

    assert.equal(Object.isFrozen(row), true);
    assert.equal(Object.isFrozen(row.observation), true);
    // RULING: observations are stored whole. Nothing is thinned on the way in.
    assert.equal(row.observation.properties.callsign, 'PAN123');
    assert.deepEqual(row.observation.entityRef.keys, { icao24: 'abc123', registration: 'G-PNPT' });
    // The batch derivation prefix is composed onto the record, not referenced.
    assert.deepEqual(row.observation.derivation.map((step) => step.method), ['source_reported', 'ingested']);
  });

  it('insertion does not mutate the caller batch', async () => {
    // A collector must be able to hand its batch to the store and still hold
    // exactly what it built — a store that stamped ids or normalised fields in
    // place would make the collector's own output depend on having stored it.
    const store = await open();
    const batch = batchOf({
      source: AIR,
      observationType: 'air.position',
      ingestedAt: T(14, 30),
      observations: [position({ icao24: 'abc123', observedAt: T(14, 30), lon: -0.1, lat: 51.5 })],
    });
    const before = structuredClone(batch);
    await store.insertBatch(batch);
    assert.deepEqual(batch, before);
  });

  it('mutating a caller batch after insert cannot alter stored evidence', async () => {
    const store = await open();
    const observations = [position({ icao24: 'abc123', observedAt: T(14, 30), lon: -0.1, lat: 51.5 })];
    const batch = batchOf({ source: AIR, observationType: 'air.position', ingestedAt: T(14, 30), observations });
    const { observationIds: [id] } = await store.insertBatch(batch);

    observations[0].properties.callsign = 'TAMPERED';
    observations[0].observedAt = T(23, 0);

    const stored = await store.get(id);
    assert.equal(stored.observedAt, T(14, 30));
    assert.notEqual(stored.observation.properties.callsign, 'TAMPERED');
  });
}
