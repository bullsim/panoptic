// PANOPTIC Observation v1 contract.
//
// The load-bearing tests here are the GOLDEN ID VECTORS. An observation id is a
// content address: ingestion idempotency, replay, and deduplication all rest on
// identical input producing an identical id, forever. A refactor that quietly
// changed the canonical encoding would silently orphan every previously derived
// id, and nothing else in the suite would notice. So the exact
// canonicalIdentityString AND the exact resulting id are pinned byte-for-byte.
//
// Fixtures are committed real source-format records under src/data/fixtures/.
// NOTHING HERE READS .gev-cache — a unit test must not depend on a local
// runtime cache that may be absent, stale, or machine-specific.
//
// Run with: npm test   (node --test)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BATCH_SCHEMA,
  DERIVATION_METHODS,
  GEOMETRY_POLICY,
  OBSERVATION_TYPES,
  effectiveDerivation,
  geometryPolicy,
  supersedesAt,
} from '../../server/contracts/observation/v1.js';
import {
  canonicalIdentityString,
  canonicalJoin,
  canonicalValue,
  deriveObservationId,
  lineageKey,
} from '../../server/contracts/observation/identity.js';
import { validateBatch, validateObservation } from '../../server/contracts/observation/validate.js';
import { toObservations as firmsToObservations } from '../../server/collectors/firms.js';
import {
  decodeTleEpoch,
  decodeTleExponent,
  parseTleBody,
  toObservations as celestrakToObservations,
} from '../../server/collectors/celestrak.js';
import { parseFirmsCsv } from './firmsCsv.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const readFixture = (name) => readFileSync(path.join(FIXTURES, name), 'utf8');

/** A seismic solution, shaped as a USGS-derived normaliser would emit it. */
function seismic({ magnitude = 4.2, depthM = 8200, lon = -122.8, lat = 38.8, extra = {} } = {}) {
  return {
    observationType: 'ground.seismic_solution',
    observedAt: 1788370000000,
    sourceRecordId: 'nc73912345',
    geometry: { type: 'Point', coordinates: [lon, lat] },
    properties: { magnitude, depthM, place: '5km NW of The Geysers, CA', ...extra },
  };
}

// ---------------------------------------------------------------------------
// Registry and geometry policy
// ---------------------------------------------------------------------------

test('every registered type declares one of the three geometry policies', () => {
  const states = new Set(Object.values(GEOMETRY_POLICY));
  assert.deepEqual([...states].sort(), ['optional', 'prohibited', 'required']);
  for (const [type, spec] of Object.entries(OBSERVATION_TYPES)) {
    assert.ok(states.has(spec.geometry), `${type} has an unknown geometry policy`);
    assert.ok(Array.isArray(spec.revisionKey), `${type} must declare a revisionKey`);
  }
});

test('geometry policies match the approved ruling', () => {
  assert.equal(geometryPolicy('air.position'), 'required');
  assert.equal(geometryPolicy('sea.position'), 'required');
  assert.equal(geometryPolicy('environment.fire_detection'), 'required');
  assert.equal(geometryPolicy('ground.seismic_solution'), 'required');
  assert.equal(geometryPolicy('space.orbital_elements'), 'prohibited');
});

test('geometry on an orbital element set is REJECTED, never faked as [0,0]', () => {
  const base = {
    observationId: 'obs_x', observationType: 'space.orbital_elements',
    observedAt: 1788263871490, sourceRecordId: '25544', properties: {},
  };
  assert.equal(validateObservation(base).ok, true, 'no geometry is correct');

  const withNullIsland = { ...base, geometry: { type: 'Point', coordinates: [0, 0] } };
  const result = validateObservation(withNullIsland);
  assert.equal(result.ok, false);
  assert.match(result.problems[0].message, /prohibits geometry/);
});

test('a required-geometry type is rejected without geometry, and rejects a 3rd coordinate', () => {
  const base = {
    observationId: 'obs_x', observationType: 'environment.fire_detection',
    observedAt: 1788369420000, properties: {},
  };
  assert.equal(validateObservation(base).ok, false, 'missing geometry must fail');

  // Altitude belongs in `vertical` with a datum, never in coordinates[2].
  const threeD = { ...base, geometry: { type: 'Point', coordinates: [-122.8, 61.95, 1200] } };
  assert.equal(validateObservation(threeD).ok, false, 'a 3rd coordinate has no datum and must fail');
});

test('a resolved entity id is rejected — v1 carries candidate keys only', () => {
  const base = {
    observationId: 'obs_x', observationType: 'space.orbital_elements',
    observedAt: 1, sourceRecordId: '25544', properties: {},
  };
  assert.equal(validateObservation({ ...base, entityRef: { keys: { noradId: 25544 } } }).ok, true);

  // REGRESSION: a bare `entityId` with NO entityRef is the smuggling route. The
  // check once lived inside the entityRef block and let this straight through.
  const bare = validateObservation({ ...base, entityId: 'sat-1' });
  assert.equal(bare.ok, false, 'a resolved entityId must be rejected even when entityRef is absent');
  assert.match(bare.problems.at(-1).message, /must not carry a resolved entity id/);

  // ...and nested under entityRef.
  assert.equal(
    validateObservation({ ...base, entityRef: { keys: { noradId: 1 }, resolved: 'sat-1' } }).ok,
    false,
  );

  // Rejected through the batch path too, not only the single-observation path.
  const batch = {
    schema: BATCH_SCHEMA, source: { id: 'celestrak' }, ingestedAt: 1,
    observations: [{ ...base, entityId: 'sat-1' }],
  };
  assert.equal(validateBatch(batch).ok, false, 'a batch must not smuggle a resolved entity id either');
});

test('a revised element set changes the id even when elementSetNumber stays 999', () => {
  // CelesTrak pins elementSetNumber to 999 for every object it serves, so that
  // field alone can never discriminate revisions. The mean elements and the
  // epoch must carry it — otherwise a re-issued element set would collide with
  // its predecessor and the revision would be silently swallowed.
  const source = { id: 'celestrak', feed: 'stations' };
  const base = {
    observationType: 'space.orbital_elements',
    observedAt: 1788263871490,
    sourceRecordId: '25544',
    properties: {
      elementSetNumber: 999, meanMotion: 15.48958602, eccentricity: 0.0005055,
      inclinationDeg: 51.6312, raanDeg: 282.3953, argPerigeeDeg: 96.474,
      meanAnomalyDeg: 263.6825, bstar: 0.000079223,
    },
  };
  const baseId = deriveObservationId(base, source);

  const revisions = {
    meanMotion: 15.48958700,
    eccentricity: 0.0005061,
    inclinationDeg: 51.6315,
    raanDeg: 282.3960,
    argPerigeeDeg: 96.4750,
    meanAnomalyDeg: 263.6830,
    bstar: 0.000079300,
  };
  for (const [field, value] of Object.entries(revisions)) {
    const revised = { ...base, properties: { ...base.properties, [field]: value } };
    assert.equal(revised.properties.elementSetNumber, 999, 'elementSetNumber deliberately unchanged');
    assert.notEqual(
      deriveObservationId(revised, source), baseId,
      `a changed ${field} must produce a new observation id`,
    );
    assert.equal(
      lineageKey(revised, source), lineageKey(base, source),
      `a changed ${field} must stay in the same record lineage`,
    );
  }

  // elementSetNumber is still real source data and still identity-bearing when
  // it does move — it simply is not load-bearing on its own.
  assert.notEqual(
    deriveObservationId({ ...base, properties: { ...base.properties, elementSetNumber: 1000 } }, source),
    baseId,
  );
});

test('zero-padded and unpadded catalogue numbers canonicalise to one identity', () => {
  // TLE columns 3–7 right-justify the catalogue number; both zero- and
  // space-padding occur. Without canonicalisation the same object would split
  // into two lineages.
  const padded = [
    'LCS 1',
    '1 01361U 65034C   26243.70311190  .00000004  00000+0 -60455-3 0  9995',
    '2 01361  32.1466 357.7243 0011520  29.1390 330.9749  9.89310587217363',
  ].join('\n');
  const spacePadded = padded.replaceAll('01361', ' 1361');

  const entry = (body) => celestrakToObservations({ at: 1788376504185, body }, { feed: 'stations' });
  const a = entry(padded).observations[0];
  const b = entry(spacePadded).observations[0];

  assert.equal(a.sourceRecordId, '1361', 'zero padding is stripped from a numeric catalogue id');
  assert.equal(b.sourceRecordId, '1361', 'space padding is stripped too');
  assert.equal(a.entityRef.keys.noradId, 1361);
  assert.deepEqual(a.entityRef.keys, b.entityRef.keys);
  assert.equal(a.observationId, b.observationId, 'the same object must not split into two lineages');
  assert.equal(lineageKey(a, { id: 'celestrak', feed: 'stations' }), lineageKey(b, { id: 'celestrak', feed: 'stations' }));

  // Canonicalisation is confined to the numeric catalogue id. A non-numeric
  // source record id must be preserved verbatim, leading zeros and all.
  const seismicPadded = { ...seismic(), sourceRecordId: 'nc0073912345' };
  assert.equal(
    canonicalIdentityString(seismicPadded, { id: 'usgs' }).includes('nc0073912345'), true,
    'generic leading-zero stripping must NOT be applied to non-numeric identifiers',
  );
});

test('an explicit null sourceRecordId is rejected — omit it instead', () => {
  const base = {
    observationId: 'obs_x', observationType: 'environment.fire_detection',
    observedAt: 1, geometry: { type: 'Point', coordinates: [0, 1] }, properties: {},
  };
  assert.equal(validateObservation(base).ok, true, 'omitted is correct');
  const result = validateObservation({ ...base, sourceRecordId: null });
  assert.equal(result.ok, false);
  assert.match(result.problems[0].message, /omitted, not null/);
});

// ---------------------------------------------------------------------------
// Canonical encoding
// ---------------------------------------------------------------------------

test('canonical numeric formatting is deterministic', () => {
  assert.equal(canonicalValue(4.2, 1), '4.2');
  assert.equal(canonicalValue(4.20, 1), '4.2', '4.2 and 4.20 must not differ');
  assert.equal(canonicalValue('4.2', 1), '4.2', 'string and number inputs agree');
  assert.equal(canonicalValue(4.24, 1), '4.2');
  assert.equal(canonicalValue(0.1 + 0.2, 4), '0.3000', 'float noise must not reach identity');
  assert.equal(canonicalValue(-0, 2), '0.00', 'negative zero is normalised');
  assert.equal(canonicalValue(-0.0001, 2), '0.00', 'a small negative must not become "-0.00"');
  assert.equal(canonicalValue(undefined, 2), '');
  assert.equal(canonicalValue(null), '');
  assert.throws(() => canonicalValue(Number.NaN, 2), /finite/);
  assert.throws(() => canonicalValue(Infinity, 2), /finite/);
});

test('the join is injective — separator ambiguity cannot forge a sequence', () => {
  assert.notEqual(canonicalJoin(['a', 'bc']), canonicalJoin(['a|2:bc']));
  assert.notEqual(canonicalJoin(['ab', 'c']), canonicalJoin(['a', 'bc']));
  assert.notEqual(canonicalJoin(['a', 'b', 'c']), canonicalJoin(['a', 'b|1:c']));
  assert.notEqual(canonicalJoin(['', 'a']), canonicalJoin(['a', '']));
  // A value containing the separator characters is still unambiguous.
  assert.notEqual(canonicalJoin(['1:x']), canonicalJoin(['1', 'x']));
});

test('property insertion order cannot affect an id', () => {
  const source = { id: 'usgs' };
  const a = seismic();
  const b = {
    properties: { place: '5km NW of The Geysers, CA', depthM: 8200, magnitude: 4.2 },
    geometry: { type: 'Point', coordinates: [-122.8, 38.8] },
    sourceRecordId: 'nc73912345',
    observedAt: 1788370000000,
    observationType: 'ground.seismic_solution',
  };
  assert.notEqual(JSON.stringify(a), JSON.stringify(b), 'the two objects really are ordered differently');
  assert.equal(deriveObservationId(a, source), deriveObservationId(b, source));
});

// ---------------------------------------------------------------------------
// GOLDEN ID VECTORS — canonical string and id pinned byte-for-byte
// ---------------------------------------------------------------------------

test('GOLDEN: FIRMS immutable detection', () => {
  const source = { id: 'firms', feed: 'VIIRS_NOAA20_NRT' };
  const observation = {
    observationType: 'environment.fire_detection',
    observedAt: 1784197560000,
    geometry: { type: 'Point', coordinates: [-121.67046, 38.99488] },
    properties: { satellite: 'N20', instrument: 'VIIRS', confidence: 'n', frp: 0.53 },
  };

  assert.equal(
    canonicalIdentityString(observation, source),
    '5:firms|16:VIIRS_NOAA20_NRT|26:environment.fire_detection|'
    + '55:10:-121.67046|8:38.99488|13:1784197560000|3:N20|5:VIIRS'
    + '|13:1784197560000|0:',
  );
  assert.equal(deriveObservationId(observation, source), 'obs_pawqzddhghxxxa7n4libqtng4m');
});

test('GOLDEN: CelesTrak orbital element set', () => {
  const source = { id: 'celestrak', feed: 'stations' };
  const observation = {
    observationType: 'space.orbital_elements',
    observedAt: 1788263871490,
    sourceRecordId: '25544',
    properties: {
      elementSetNumber: 999, meanMotion: 15.48958602, eccentricity: 0.0005055,
      inclinationDeg: 51.6312, raanDeg: 282.3953, argPerigeeDeg: 96.474,
      meanAnomalyDeg: 263.6825, bstar: 0.000079223,
    },
  };

  assert.equal(
    canonicalIdentityString(observation, source),
    '9:celestrak|8:stations|22:space.orbital_elements|7:5:25544|13:1788263871490|'
    + '92:3:999|11:15.48958602|9:0.0005055|7:51.6312|8:282.3953|7:96.4740|8:263.6825|14:0.000079223000',
  );
  assert.equal(deriveObservationId(observation, source), 'obs_gdcxojbqsbb3c2xeqkevex6l4a');
});

test('GOLDEN: revisable USGS-style seismic solution', () => {
  const source = { id: 'usgs' };

  assert.equal(
    canonicalIdentityString(seismic(), source),
    '4:usgs|0:|23:ground.seismic_solution|13:10:nc73912345|13:1788370000000|'
    + '34:3:4.2|4:8200|9:-122.8000|7:38.8000',
  );
  assert.equal(deriveObservationId(seismic(), source), 'obs_66s6syh5jkivqu3rdztwqoqlnu');
});

// ---------------------------------------------------------------------------
// Idempotency, revision, supersession
// ---------------------------------------------------------------------------

test('identical input gives an identical id, and duplicate delivery is a no-op', () => {
  const source = { id: 'usgs' };
  const first = deriveObservationId(seismic(), source);
  const redelivered = deriveObservationId(seismic(), source);
  assert.equal(first, redelivered, 're-ingesting the same record must be idempotent');
});

test('a materially revised seismic solution gets a DIFFERENT id, same lineage', () => {
  const source = { id: 'usgs' };
  const original = seismic({ magnitude: 4.2 });
  const revised = seismic({ magnitude: 4.4 });         // USGS re-solves the same event
  const deeper = seismic({ depthM: 9100 });
  const moved = seismic({ lon: -122.81 });

  const baseId = deriveObservationId(original, source);
  for (const [label, next] of [['magnitude', revised], ['depth', deeper], ['epicentre', moved]]) {
    assert.notEqual(deriveObservationId(next, source), baseId, `${label} revision must change the id`);
    assert.equal(
      lineageKey(next, source), lineageKey(original, source),
      `${label} revision must stay in the same record lineage`,
    );
  }
});

test('a change outside the revision-key allowlist does NOT change the id', () => {
  const source = { id: 'usgs' };
  const baseId = deriveObservationId(seismic(), source);

  // `place` is descriptive prose, not identity. Neither is an added field.
  assert.equal(deriveObservationId(seismic({ extra: { place: 'somewhere else' } }), source), baseId);
  assert.equal(deriveObservationId(seismic({ extra: { felt: 12, tsunami: 0 } }), source), baseId);
  // A magnitude change below the declared precision is not a material revision.
  assert.equal(deriveObservationId(seismic({ magnitude: 4.201 }), source), baseId);
});

test('an immutable type ignores payload changes entirely', () => {
  const source = { id: 'firms', feed: 'VIIRS_NOAA20_NRT' };
  const base = {
    observationType: 'environment.fire_detection',
    observedAt: 1784197560000,
    geometry: { type: 'Point', coordinates: [-121.67046, 38.99488] },
    properties: { satellite: 'N20', instrument: 'VIIRS', frp: 0.53 },
  };
  const withDifferentFrp = { ...base, properties: { ...base.properties, frp: 99 } };
  assert.equal(
    deriveObservationId(withDifferentFrp, source), deriveObservationId(base, source),
    'FIRMS never revises a detection — frp is not identity',
  );
  // ...but a different location, time, or sensor is a different detection.
  for (const changed of [
    { ...base, observedAt: base.observedAt + 60000 },
    { ...base, geometry: { type: 'Point', coordinates: [-121.67047, 38.99488] } },
    { ...base, properties: { ...base.properties, satellite: 'N21' } },
  ]) {
    assert.notEqual(deriveObservationId(changed, source), deriveObservationId(base, source));
  }
});

test('the same record under a different source or feed is a different observation', () => {
  const observation = seismic();
  const a = deriveObservationId(observation, { id: 'usgs' });
  assert.notEqual(deriveObservationId(observation, { id: 'emsc' }), a);
  assert.notEqual(deriveObservationId(observation, { id: 'usgs', feed: 'all_day' }), a);
});

test('a content-addressed record has no lineage key', () => {
  const firms = {
    observationType: 'environment.fire_detection', observedAt: 1,
    geometry: { type: 'Point', coordinates: [0, 0] },
    properties: { satellite: 'N20', instrument: 'VIIRS' },
  };
  assert.equal(lineageKey(firms, { id: 'firms' }), null, 'no record id means no lineage subject');
  assert.ok(lineageKey(seismic(), { id: 'usgs' }));
});

test('an unknown observation type cannot produce an id', () => {
  assert.throws(
    () => deriveObservationId({ observationType: 'nope.nothing', observedAt: 1 }, { id: 'x' }),
    /unknown observationType/,
  );
});

// ---------------------------------------------------------------------------
// Derivation composition and supersession ordering
// ---------------------------------------------------------------------------

test('record derivation EXTENDS the batch prefix and never replaces it', () => {
  const batch = {
    derivation: [
      { method: 'source_reported', by: 'celestrak' },
      { method: 'ingested', by: 'panoptic.collector.celestrak', at: 1788376504185 },
    ],
  };
  const observation = {
    derivation: [{ method: 'calculated', by: 'panoptic.sgp4', calculatedFor: 1788376500000 }],
  };

  const chain = effectiveDerivation(batch, observation);
  assert.equal(chain.length, 3, 'prefix is preserved, not overridden');
  assert.deepEqual(chain.map((s) => s.method), ['source_reported', 'ingested', 'calculated']);
  assert.equal(chain[0].by, 'celestrak', 'source evidence survives at the head of the chain');

  // A record with no steps of its own simply inherits the prefix.
  assert.deepEqual(effectiveDerivation(batch, {}), batch.derivation);
  assert.deepEqual(effectiveDerivation(null, observation), observation.derivation);
});

test('supersedesAt takes the newest derivation time, falling back to observedAt', () => {
  const batch = { derivation: [{ method: 'source_reported', by: 'usgs' }] };
  assert.equal(supersedesAt(batch, { observedAt: 500 }), 500, 'no timed step → the observation time');
  assert.equal(
    supersedesAt(batch, { observedAt: 500, derivation: [{ method: 'calculated', by: 'usgs', at: 900 }] }),
    900,
    'a solve time orders the version',
  );
});

test('every declared derivation method is accepted by the validator', () => {
  for (const method of DERIVATION_METHODS) {
    const result = validateObservation({
      observationId: 'obs_x', observationType: 'space.orbital_elements',
      observedAt: 1, sourceRecordId: '1', properties: {},
      derivation: [{ method, by: 'test' }],
    });
    assert.equal(result.ok, true, `${method} must be accepted`);
  }
  const bad = validateObservation({
    observationId: 'obs_x', observationType: 'space.orbital_elements',
    observedAt: 1, sourceRecordId: '1', properties: {},
    derivation: [{ method: 'guessed', by: 'test' }],
  });
  assert.equal(bad.ok, false);
});

// ---------------------------------------------------------------------------
// TLE parsing — verified against committed real records
// ---------------------------------------------------------------------------

test('TLE implied-decimal exponent fields decode, including the edge shapes', () => {
  assert.equal(decodeTleExponent(' 79223-4'), 0.79223e-4);
  assert.equal(decodeTleExponent('-60455-3'), -0.60455e-3);
  assert.equal(decodeTleExponent(' 00000+0'), 0);
  assert.equal(decodeTleExponent('-20781+0'), -0.20781);
  assert.equal(decodeTleExponent(''), 0);
  assert.ok(Number.isNaN(decodeTleExponent('garbage')));
});

test('TLE epoch decodes with the NORAD two-digit-year convention', () => {
  assert.equal(decodeTleEpoch('26', '244.49851261'), Date.parse('2026-09-01T11:57:51.490Z'));
  // Day 1.0 is the very start of the year, not the second day.
  assert.equal(decodeTleEpoch('26', '1.0'), Date.UTC(2026, 0, 1));
  // 57–99 are 20th century (Sputnik onward); 00–56 are 21st.
  assert.equal(decodeTleEpoch('57', '1.0'), Date.UTC(1957, 0, 1));
  assert.equal(decodeTleEpoch('56', '1.0'), Date.UTC(2056, 0, 1));
  assert.ok(Number.isNaN(decodeTleEpoch('xx', '1.0')));
});

test('the real TLE fixture parses every field correctly', () => {
  const records = parseTleBody(readFixture('celestrak-gp-sample.tle'));
  assert.equal(records.length, 4);

  const iss = records[0];
  assert.equal(iss.name, 'ISS (ZARYA)');
  assert.equal(iss.catalogNumber, '25544');
  assert.equal(iss.classification, 'U');
  assert.equal(iss.intlDesignator, '98067A');
  assert.equal(iss.observedAt, Date.parse('2026-09-01T11:57:51.490Z'));
  assert.equal(iss.elementSetNumber, 999);
  assert.equal(iss.inclinationDeg, 51.6312);
  assert.equal(iss.raanDeg, 282.3953);
  assert.equal(iss.eccentricity, 0.0005055, 'implied leading decimal point');
  assert.equal(iss.argPerigeeDeg, 96.4740);
  assert.equal(iss.meanAnomalyDeg, 263.6825);
  assert.equal(iss.meanMotion, 15.48958602);
  assert.equal(iss.meanMotionDot, 0.00003910);
  assert.equal(iss.bstar, 0.79223e-4);
  assert.equal(iss.revAtEpoch, 58358);

  const byName = Object.fromEntries(records.map((r) => [r.name, r]));
  assert.equal(byName['LCS 1'].bstar, -0.60455e-3, 'negative BSTAR');
  assert.equal(byName['LES-5'].bstar, 0, 'zero BSTAR');
  assert.equal(byName['LES-5'].meanMotionDot, -0.00000052, 'negative first derivative');
  assert.equal(byName['STARLINK-5823'].bstar, -0.20781, 'negative mantissa, positive exponent');
  assert.equal(byName['STARLINK-5823'].intlDesignator, '23028AX', 'eight-character designator');
});

// ---------------------------------------------------------------------------
// Normalisers over committed fixtures
// ---------------------------------------------------------------------------

test('the CelesTrak normaliser emits a valid orbital-element batch', () => {
  const entry = { at: 1788376504185, body: readFixture('celestrak-gp-sample.tle') };
  const batch = celestrakToObservations(entry, { feed: 'stations' });

  assert.equal(batch.schema, BATCH_SCHEMA);
  assert.deepEqual(batch.source, { id: 'celestrak', feed: 'stations' });
  assert.equal(batch.observationType, 'space.orbital_elements');
  assert.deepEqual(batch.derivation.map((s) => s.method), ['source_reported', 'ingested']);
  assert.equal(validateBatch(batch).ok, true, JSON.stringify(validateBatch(batch).problems));

  const iss = batch.observations[0];
  assert.equal(iss.observedAt, Date.parse('2026-09-01T11:57:51.490Z'), 'observedAt is the TLE EPOCH');
  assert.notEqual(iss.observedAt, entry.at, 'observedAt is NOT ingest time');
  assert.equal(iss.geometry, undefined, 'an element set is not at a place');
  assert.deepEqual(iss.entityRef.keys, { noradId: 25544, intlDesignator: '98067A' });

  // Zero-padded catalogue numbers are canonicalised so a lineage cannot split.
  assert.deepEqual(batch.observations.map((o) => o.sourceRecordId), ['25544', '1361', '2866', '55786']);
});

test('the FIRMS normaliser emits a valid detection batch from the real CSV fixture', () => {
  const fires = parseFirmsCsv(readFixture('firms-viirs-noaa20-sample.csv'));
  const batch = firmsToObservations({ at: 1788376504185, fires }, { feed: 'VIIRS_NOAA20_NRT' });

  assert.equal(batch.schema, BATCH_SCHEMA);
  assert.equal(batch.observationType, 'environment.fire_detection');
  assert.equal(batch.observations.length, fires.length);
  assert.equal(validateBatch(batch).ok, true, JSON.stringify(validateBatch(batch).problems));

  const first = batch.observations[0];
  assert.deepEqual(first.geometry, { type: 'Point', coordinates: [-121.67046, 38.99488] });
  assert.equal(first.observedAt, Date.parse('2026-07-16T10:06:00.000Z'), 'acq_date + unpadded acq_time');
  assert.equal('sourceRecordId' in first, false, 'FIRMS issues no record id — the field is OMITTED');
  assert.equal('entityRef' in first, false, 'a detection is not a thing');

  // Detection confidence stays domain-specific, verbatim.
  assert.equal(first.properties.confidence, 'n');
  assert.equal(first.properties.satellite, 'N20');
  assert.equal(first.properties.instrument, 'VIIRS');
});

test('normalising is pure — the cache entry is not mutated', () => {
  const fires = parseFirmsCsv(readFixture('firms-viirs-noaa20-sample.csv'));
  const entry = { at: 1788376504185, fires };
  const before = JSON.stringify(entry);
  firmsToObservations(entry, { feed: 'VIIRS_NOAA20_NRT' });
  assert.equal(JSON.stringify(entry), before, 'the collector cache entry must be untouched');

  const tleEntry = { at: 1788376504185, body: readFixture('celestrak-gp-sample.tle') };
  const tleBefore = JSON.stringify(tleEntry);
  celestrakToObservations(tleEntry, { feed: 'stations' });
  assert.equal(JSON.stringify(tleEntry), tleBefore);
});

test('re-normalising the same fixture yields byte-identical ids', () => {
  const entry = { at: 1788376504185, body: readFixture('celestrak-gp-sample.tle') };
  const a = celestrakToObservations(entry, { feed: 'stations' }).observations.map((o) => o.observationId);
  const b = celestrakToObservations(entry, { feed: 'stations' }).observations.map((o) => o.observationId);
  assert.deepEqual(a, b, 'replaying a cache file must reproduce the same ids');
  assert.equal(new Set(a).size, a.length, 'ids within a batch are distinct');
});

// ---------------------------------------------------------------------------
// The contract stays server-side and unwired
// ---------------------------------------------------------------------------

test('no browser-built module imports the Observation contract', () => {
  // src/ is the browser build. The contract is server-side only; an import from
  // src/ would pull node:crypto into the bundle and break the boundary test.
  const roots = [path.join(FIXTURES, '..')];
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile() && entry.name.endsWith('.js')) {
        if (/contracts\/observation/.test(readFileSync(absolute, 'utf8'))) offenders.push(absolute);
      }
    }
  };
  for (const root of roots) walk(root);
  assert.deepEqual(offenders, [], 'the Observation contract must not reach the browser build');
});

test('the collector request paths never call toObservations', () => {
  const collectorRoot = path.join(FIXTURES, '..', '..', '..', 'server', 'collectors');
  for (const name of ['celestrak.js', 'firms.js']) {
    const source = readFileSync(path.join(collectorRoot, name), 'utf8');
    // The handler is everything before the normaliser section.
    const marker = source.indexOf('// Observation v1 normaliser');
    assert.ok(marker > 0, `${name} must keep the normaliser in its own clearly marked section`);
    const handlerRegion = source.slice(0, marker);
    assert.equal(
      /toObservations\s*\(/.test(handlerRegion), false,
      `${name}: the request path must never normalise — a global FIRMS batch is ~311k records`,
    );
  }
});
