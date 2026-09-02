/**
 * PANOPTIC Observation v1 — the canonical intelligence contract.
 *
 * An OBSERVATION is something a source reported, or PANOPTIC derived, about the
 * world at a particular time. It is raw evidence. It carries no analytical
 * conclusion, no significance, no anomaly score, and no resolved entity id —
 * those belong to subsystems that do not exist yet, and putting placeholders
 * here would invite them to be filled in with fiction.
 *
 * Scope note: this contract is INTERNAL and server-side. It is not a wire
 * format. A global FIRMS batch is ~311k detections; see the size analysis in
 * the milestone report before considering sending observations to a browser.
 *
 * The envelope is deliberately small. A field earns a place in it only when
 * several domains use it with the SAME meaning; everything else lives in the
 * per-domain `properties` bag. That rule is what stops this becoming a
 * hundred-nullable-field universal object.
 *
 * @module server/contracts/observation/v1
 */

/** Schema identifiers. The version lives in the NAME; v2 is a sibling module. */
export const OBSERVATION_SCHEMA = 'panoptic.observation.v1';
export const BATCH_SCHEMA = 'panoptic.observationBatch.v1';

/**
 * Geometry policy per observation type — three states, not a boolean.
 *
 * `prohibited` is the one that matters: an orbital element set is not AT a
 * place, and emitting `[0, 0]` for it would put Null Island into every future
 * spatial query. The validator rejects geometry on such types outright.
 */
export const GEOMETRY_POLICY = Object.freeze({
  REQUIRED: 'required',
  OPTIONAL: 'optional',
  PROHIBITED: 'prohibited',
});

/**
 * Derivation methods — how a value came to be.
 *
 * `direct_observation` is present for completeness but is expected to stay
 * unused: PANOPTIC operates no sensors. Saying so honestly is worth more than a
 * flattering default.
 */
export const DERIVATION_METHODS = Object.freeze([
  'direct_observation',
  'source_reported',
  'ingested',
  'calculated',
  'interpolated',
  'extrapolated',
  'reconstructed',
  'simulated',
  'manual',
  'ai_derived',
]);

/**
 * The observation-type registry.
 *
 * Each entry declares:
 *   geometry     — GEOMETRY_POLICY state
 *   revisionKey  — ORDERED allowlist of identity-bearing fields. An EMPTY list
 *                  means the type is immutable: a source never revises such a
 *                  record, so identity reduces to source + record + time.
 *   contentKey   — ORDERED allowlist used INSTEAD of sourceRecordId when the
 *                  source issues no identifier of its own (FIRMS).
 *
 * `decimals` fixes numeric formatting so 4.2 and 4.20 cannot yield different
 * ids, and so float noise never ripples into identity. Never hash arbitrary
 * JSON: property order and incidental metadata would destabilise every id.
 *
 * @type {Readonly<Record<string, {geometry: string, revisionKey: readonly object[], contentKey?: readonly object[]}>>}
 */
export const OBSERVATION_TYPES = Object.freeze({
  'air.position': Object.freeze({
    geometry: GEOMETRY_POLICY.REQUIRED,
    // A position report is a point-in-time statement; sources do not revise it.
    revisionKey: Object.freeze([]),
  }),

  'sea.position': Object.freeze({
    geometry: GEOMETRY_POLICY.REQUIRED,
    revisionKey: Object.freeze([]),
  }),

  'environment.fire_detection': Object.freeze({
    geometry: GEOMETRY_POLICY.REQUIRED,
    // FIRMS never revises a detection — it is an immutable sensor event.
    revisionKey: Object.freeze([]),
    // FIRMS issues no record id. This formalises the identity the browser layer
    // already synthesises as `firms:{lat}:{lon}:{acqMs}:{satellite}`.
    contentKey: Object.freeze([
      Object.freeze({ path: 'geometry.coordinates.0', decimals: 5 }),
      Object.freeze({ path: 'geometry.coordinates.1', decimals: 5 }),
      Object.freeze({ path: 'observedAt', decimals: 0 }),
      Object.freeze({ path: 'properties.satellite' }),
      Object.freeze({ path: 'properties.instrument' }),
    ]),
  }),

  'ground.seismic_solution': Object.freeze({
    geometry: GEOMETRY_POLICY.REQUIRED,
    // A seismic SOLUTION is an estimate, and USGS revises magnitude and depth
    // in the hours after an event. Same event id, same event time, new numbers
    // => a new observation version of the same record lineage.
    revisionKey: Object.freeze([
      Object.freeze({ path: 'properties.magnitude', decimals: 1 }),
      Object.freeze({ path: 'properties.depthM', decimals: 0 }),
      Object.freeze({ path: 'geometry.coordinates.0', decimals: 4 }),
      Object.freeze({ path: 'geometry.coordinates.1', decimals: 4 }),
    ]),
  }),

  'space.orbital_elements': Object.freeze({
    // PROHIBITED: an element set describes an orbit, not a place. A position
    // only exists once a caller supplies `calculatedFor` and propagates.
    geometry: GEOMETRY_POLICY.PROHIBITED,
    // CelesTrak issues a new element set for the same catalogue object as the
    // orbit is refined; the element-set number and the mean elements are what
    // make one version distinct from another.
    revisionKey: Object.freeze([
      Object.freeze({ path: 'properties.elementSetNumber', decimals: 0 }),
      Object.freeze({ path: 'properties.meanMotion', decimals: 8 }),
      Object.freeze({ path: 'properties.eccentricity', decimals: 7 }),
      Object.freeze({ path: 'properties.inclinationDeg', decimals: 4 }),
      Object.freeze({ path: 'properties.raanDeg', decimals: 4 }),
      Object.freeze({ path: 'properties.argPerigeeDeg', decimals: 4 }),
      Object.freeze({ path: 'properties.meanAnomalyDeg', decimals: 4 }),
      Object.freeze({ path: 'properties.bstar', decimals: 12 }),
    ]),
  }),
});

/** Whether a type is registered. */
export function isKnownObservationType(type) {
  return Object.prototype.hasOwnProperty.call(OBSERVATION_TYPES, type);
}

/** Geometry policy for a type, or `null` when the type is unknown. */
export function geometryPolicy(type) {
  return OBSERVATION_TYPES[type]?.geometry ?? null;
}

/**
 * Compose the full derivation chain for one observation.
 *
 * COMPOSITION, NOT OVERRIDE. The batch holds the prefix that is true of every
 * record — source evidence, then PANOPTIC ingestion. A record APPENDS its own
 * steps (an SGP4 projection, a USGS solve). A record may extend the chain; it
 * may never rewrite it, because doing so would discard where its evidence came
 * from.
 *
 * @param {object|null} batch - Batch carrying the common prefix.
 * @param {object|null} observation - Observation with optional extra steps.
 * @returns {readonly object[]} Ordered chain, oldest first.
 */
export function effectiveDerivation(batch, observation) {
  const prefix = Array.isArray(batch?.derivation) ? batch.derivation : [];
  const suffix = Array.isArray(observation?.derivation) ? observation.derivation : [];
  return Object.freeze([...prefix, ...suffix]);
}

/**
 * Time a version takes effect, used to order a record lineage.
 *
 * The last derivation step's `at` is when this version was produced (USGS solve
 * time); absent that, the observation time itself.
 *
 * @param {object|null} batch - Batch.
 * @param {object|null} observation - Observation.
 * @returns {number} Epoch ms.
 */
export function supersedesAt(batch, observation) {
  const chain = effectiveDerivation(batch, observation);
  for (let i = chain.length - 1; i >= 0; i -= 1) {
    if (Number.isFinite(chain[i]?.at)) return chain[i].at;
  }
  return observation?.observedAt;
}
