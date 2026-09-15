// PANOPTIC Evidence Store — memory reference implementation.
//
// The behaviour lives in the shared conformance suite next door, not here. This
// file exists to bind that suite to one implementation, so that when a backing
// store is added later it can be bound the same way and MUST answer every
// question identically. Assertions written directly against the memory store
// would be assertions about the memory store; assertions in the suite are
// assertions about PANOPTIC.
//
// Run with: npm test   (node --test)
import { createMemoryObservationStore } from '../../server/storage/memory.js';
import { runObservationStoreConformance } from './observationStoreConformance.mjs';

runObservationStoreConformance({
  makeStore: createMemoryObservationStore,
  label: 'memory store',
});
