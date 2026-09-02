/**
 * Observation v1 validation — dependency-free, and NOT for the request path.
 *
 * A global FIRMS batch is ~311,217 detections. Validating each of those on a
 * live request would add work to a path that currently serves cached responses
 * in 0.65 s. This exists for tests and for a deliberate development check; it
 * must never be wired into a collector's handler.
 *
 * The validator collects every problem rather than throwing on the first, so a
 * malformed normaliser is fixable in one pass.
 *
 * @module server/contracts/observation/validate
 */

import {
  BATCH_SCHEMA,
  DERIVATION_METHODS,
  GEOMETRY_POLICY,
  OBSERVATION_TYPES,
  geometryPolicy,
  isKnownObservationType,
} from './v1.js';

const METHODS = new Set(DERIVATION_METHODS);

/** A validation problem, located by index and field. */
function problem(where, message) {
  return { where, message };
}

/** Whether a value is a plain finite epoch-ms timestamp. */
function isEpochMs(value) {
  return Number.isFinite(value) && Number.isInteger(value);
}

/**
 * Validate a GeoJSON Point.
 *
 * Longitude first, then latitude — the ordering mistake this catches is the one
 * that silently puts everything in the wrong hemisphere. A third element is
 * REJECTED: GeoJSON's optional elevation carries no datum, and altitude belongs
 * in `vertical` where its datum can be stated.
 */
function validateGeometry(geometry, where, problems) {
  if (geometry?.type !== 'Point') {
    problems.push(problem(where, 'geometry must be a GeoJSON Point'));
    return;
  }
  const coords = geometry.coordinates;
  if (!Array.isArray(coords) || coords.length !== 2) {
    problems.push(problem(where, 'geometry.coordinates must be [lon, lat]'));
    return;
  }
  const [lon, lat] = coords;
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    problems.push(problem(where, `longitude out of range: ${JSON.stringify(lon)}`));
  }
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    problems.push(problem(where, `latitude out of range: ${JSON.stringify(lat)}`));
  }
}

/** Validate one derivation step. */
function validateDerivation(chain, where, problems) {
  if (chain === undefined) return;
  if (!Array.isArray(chain)) {
    problems.push(problem(where, 'derivation must be an array'));
    return;
  }
  chain.forEach((step, i) => {
    if (!METHODS.has(step?.method)) {
      problems.push(problem(`${where}.derivation[${i}]`, `unknown method: ${JSON.stringify(step?.method)}`));
    }
    if (!step?.by) {
      problems.push(problem(`${where}.derivation[${i}]`, 'step requires `by`'));
    }
    for (const field of ['at', 'calculatedFor']) {
      if (step?.[field] !== undefined && !isEpochMs(step[field])) {
        problems.push(problem(`${where}.derivation[${i}]`, `${field} must be epoch ms`));
      }
    }
  });
}

/**
 * Validate one observation.
 *
 * @param {object} observation - Observation to check.
 * @param {string} [where] - Location label for problem messages.
 * @returns {{ok: boolean, problems: {where: string, message: string}[]}} Result.
 */
export function validateObservation(observation, where = 'observation') {
  const problems = [];

  if (!observation || typeof observation !== 'object') {
    return { ok: false, problems: [problem(where, 'observation must be an object')] };
  }

  const type = observation.observationType;
  if (!isKnownObservationType(type)) {
    problems.push(problem(where, `unknown observationType: ${JSON.stringify(type)}`));
  }

  if (typeof observation.observationId !== 'string' || !observation.observationId) {
    problems.push(problem(where, 'observationId is required'));
  }
  if (!isEpochMs(observation.observedAt)) {
    problems.push(problem(where, 'observedAt must be epoch ms'));
  }
  if (!observation.properties || typeof observation.properties !== 'object') {
    problems.push(problem(where, 'properties is required (may be {})'));
  }

  // `sourceRecordId` is OPTIONAL and omitted when the source issues none. An
  // explicit null is rejected: at FIRMS scale a null placeholder is ~6.8 MB of
  // nothing, and "absent" already says what null would say.
  if (observation.sourceRecordId === null) {
    problems.push(problem(where, 'sourceRecordId must be omitted, not null, when the source issues none'));
  }

  // Geometry policy — three states, and `prohibited` is enforced.
  const policy = geometryPolicy(type);
  const hasGeometry = observation.geometry !== undefined;
  if (policy === GEOMETRY_POLICY.REQUIRED) {
    if (!hasGeometry) problems.push(problem(where, `${type} requires geometry`));
    else validateGeometry(observation.geometry, where, problems);
  } else if (policy === GEOMETRY_POLICY.PROHIBITED) {
    if (hasGeometry) {
      problems.push(problem(where, `${type} prohibits geometry — an element set is not at a place`));
    }
  } else if (policy === GEOMETRY_POLICY.OPTIONAL && hasGeometry) {
    validateGeometry(observation.geometry, where, problems);
  }

  if (observation.vertical !== undefined) {
    const { value, unit, datum } = observation.vertical;
    if (!Number.isFinite(value)) problems.push(problem(where, 'vertical.value must be finite'));
    if (!unit) problems.push(problem(where, 'vertical.unit is required'));
    if (!datum) problems.push(problem(where, 'vertical.datum is required'));
  }

  if (observation.entityRef !== undefined) {
    const keys = observation.entityRef?.keys;
    if (!keys || typeof keys !== 'object' || Object.keys(keys).length === 0) {
      problems.push(problem(where, 'entityRef.keys must be a non-empty object'));
    }
  }

  // Observation v1 carries CANDIDATE KEYS ONLY. A resolved id would be a
  // conclusion, and entity resolution does not exist yet. Checked unconditionally
  // — a bare `entityId` with no entityRef is exactly the smuggling route.
  if (observation.entityId !== undefined || observation.entityRef?.resolved !== undefined) {
    problems.push(problem(where, 'Observation v1 must not carry a resolved entity id'));
  }

  validateDerivation(observation.derivation, where, problems);

  return { ok: problems.length === 0, problems };
}

/**
 * Validate a batch and every observation in it.
 *
 * @param {object} batch - Batch to check.
 * @returns {{ok: boolean, problems: {where: string, message: string}[]}} Result.
 */
export function validateBatch(batch) {
  const problems = [];

  if (!batch || typeof batch !== 'object') {
    return { ok: false, problems: [problem('batch', 'batch must be an object')] };
  }
  if (batch.schema !== BATCH_SCHEMA) {
    problems.push(problem('batch', `schema must be ${BATCH_SCHEMA}`));
  }
  if (!batch.source?.id) {
    problems.push(problem('batch', 'source.id is required'));
  }
  if (!isEpochMs(batch.ingestedAt)) {
    problems.push(problem('batch', 'ingestedAt must be epoch ms'));
  }
  if (batch.observationType !== undefined && !isKnownObservationType(batch.observationType)) {
    problems.push(problem('batch', `unknown observationType: ${JSON.stringify(batch.observationType)}`));
  }
  validateDerivation(batch.derivation, 'batch', problems);

  if (!Array.isArray(batch.observations)) {
    problems.push(problem('batch', 'observations must be an array'));
    return { ok: false, problems };
  }

  batch.observations.forEach((observation, i) => {
    // A batch hoists its type; a record inherits it unless it says otherwise.
    const merged = observation.observationType === undefined && batch.observationType !== undefined
      ? { ...observation, observationType: batch.observationType }
      : observation;
    problems.push(...validateObservation(merged, `observations[${i}]`).problems);
  });

  return { ok: problems.length === 0, problems };
}

/** Registered types, for tests and diagnostics. */
export const REGISTERED_TYPES = Object.freeze(Object.keys(OBSERVATION_TYPES));
