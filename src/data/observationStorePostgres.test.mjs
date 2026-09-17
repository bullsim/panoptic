// PANOPTIC Evidence Store — PostgreSQL adapter.
//
// Runs the EXACT SAME conformance suite as the memory reference store. The
// semantic tests are not forked, duplicated or adapted: if PostgreSQL answered
// any question differently, that is the point at which this file fails.
//
// WITHOUT A DATABASE this file SKIPS, so `npm test` stays green on a machine
// with no Docker and no PostgreSQL. Run explicitly with:
//
//     npm run db:up
//     npm run test:postgres
//     npm run db:down
//
// Under `npm run test:postgres` a missing, unreachable or unsafe database is a
// HARD FAILURE — an integration command that silently skips is worse than no
// command at all, because it reports success for work it never did.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import { createPostgresObservationStore } from '../../server/storage/postgres/store.js';
import {
  createEvidencePool,
  databaseNameOf,
  describeConnection,
  isInfrastructureError,
} from '../../server/storage/postgres/connect.js';
import {
  assertSchemaName,
  dropEvidenceSchema,
  ensureEvidenceSchema,
} from '../../server/storage/postgres/schema.js';
import { runObservationStoreConformance } from './observationStoreConformance.mjs';

/** Integration tests use their OWN variable and never fall back to a real one. */
const DATABASE_URL = process.env.PANOPTIC_TEST_DATABASE_URL;

/**
 * Whether the explicit integration command was used.
 *
 * `npm_lifecycle_event` is the script name npm is running. It works identically
 * on Windows and POSIX, which inline `VAR=1` env assignments in a script do not.
 */
const REQUIRED = process.env.npm_lifecycle_event === 'test:postgres';

/**
 * A database this suite is allowed to create and DROP schemas in.
 *
 * The name must end in `_test`. The whole harness drops schemas CASCADE, so
 * pointing it at a real Evidence Store would destroy evidence — a naming rule is
 * a cheap, unmissable guard against that mistake.
 */
function safetyProblem() {
  if (!DATABASE_URL) return 'PANOPTIC_TEST_DATABASE_URL is not set';
  const database = databaseNameOf(DATABASE_URL);
  if (!database) return 'PANOPTIC_TEST_DATABASE_URL names no database';
  if (!database.endsWith('_test')) {
    // The database NAME is not a secret; the connection string is.
    return `refusing to run: database "${database}" does not end in _test`;
  }
  return null;
}

const problem = safetyProblem();

if (problem && REQUIRED) {
  // Explicit integration run: fail loudly rather than skip.
  throw new Error(
    `npm run test:postgres cannot run — ${problem}. `
    + 'Start the disposable database with `npm run db:up` and set '
    + 'PANOPTIC_TEST_DATABASE_URL in .env (see .env.example).',
  );
}

const skip = problem
  ? `${problem} — run \`npm run db:up && npm run test:postgres\``
  : false;

// One pool for the whole file; many stores, each in its own schema.
const pool = problem ? null : createEvidencePool(DATABASE_URL);
let schemaCounter = 0;

/** A unique, validated schema name for one store instance. */
function nextSchemaName() {
  schemaCounter += 1;
  return assertSchemaName(`panoptic_t_${process.pid}_${schemaCounter}`);
}

async function makeStore() {
  const schema = nextSchemaName();
  await ensureEvidenceSchema(pool, { schema });
  return createPostgresObservationStore({ pool, schema });
}

async function destroyStore(store) {
  const schema = store.schema.split('"')[1];
  await dropEvidenceSchema(pool, { schema });
}

after(async () => {
  if (pool) await pool.end();
});

// ---------------------------------------------------------------------------
// THE SHARED SUITE — identical to the memory binding
// ---------------------------------------------------------------------------

runObservationStoreConformance({
  makeStore,
  destroyStore,
  label: 'postgres store',
  skip,
});

// ---------------------------------------------------------------------------
// POSTGRES-ONLY: things the reference store cannot express
// ---------------------------------------------------------------------------

const pgTest = (title, fn) => test(`postgres store: ${title}`, { skip }, fn);

/** Open a store and guarantee its schema is dropped. */
async function withStore(fn) {
  const store = await makeStore();
  try {
    return await fn(store);
  } finally {
    await destroyStore(store);
  }
}

const T = (hour, minute, second = 0, ms = 0) => Date.UTC(2026, 6, 16, hour, minute, second, ms);

const detection = (observationId, observedAt) => ({
  observationId,
  observedAt,
  geometry: { type: 'Point', coordinates: [-121.1, 38.1] },
  properties: { satellite: 'N20', instrument: 'VIIRS' },
});

const batchOf = (observations, ingestedAt = T(14, 0)) => ({
  schema: 'panoptic.observationBatch.v1',
  source: { id: 'firms', feed: 'VIIRS_NOAA20_NRT' },
  observationType: 'environment.fire_detection',
  ingestedAt,
  observations,
});

pgTest('UPDATE on evidence is rejected by the database', async () => {
  await withStore(async (store) => {
    await store.insertBatch(batchOf([detection('obs_appendonlyupdate', T(13, 0))]));
    await assert.rejects(
      async () => pool.query(`UPDATE ${store.schema} SET source_id = 'tampered'`),
      /append-only/,
    );
    assert.equal((await store.get('obs_appendonlyupdate')).source.id, 'firms');
  });
});

pgTest('DELETE on evidence is rejected by the database', async () => {
  await withStore(async (store) => {
    await store.insertBatch(batchOf([detection('obs_appendonlydelete', T(13, 0))]));
    await assert.rejects(async () => pool.query(`DELETE FROM ${store.schema}`), /append-only/);
    assert.equal(await store.size(), 1);
  });
});

pgTest('TRUNCATE on evidence is rejected by the database', async () => {
  await withStore(async (store) => {
    await store.insertBatch(batchOf([detection('obs_appendonlytruncate', T(13, 0))]));
    await assert.rejects(async () => pool.query(`TRUNCATE ${store.schema}`), /append-only/);
    assert.equal(await store.size(), 1);
  });
});

pgTest('a batch larger than one chunk stays atomic and counts correctly', async () => {
  // 5,001 rows crosses the insert chunk boundary, so the batch spans two
  // statements inside one transaction.
  await withStore(async (store) => {
    const many = Array.from({ length: 5_001 }, (_, i) => detection(`obs_chunk_${i}`, T(13, 0) + i));
    const first = await store.insertBatch(batchOf(many));
    assert.equal(first.inserted, 5_001);
    assert.equal(first.duplicates, 0);
    assert.equal(await store.size(), 5_001);

    // Re-delivered whole: every row a duplicate, nothing inserted, and the
    // KNOWLEDGE TIME of the first delivery survives.
    const again = await store.insertBatch(batchOf(many, T(20, 0)));
    assert.equal(again.inserted, 0);
    assert.equal(again.duplicates, 5_001);
    assert.equal((await store.get('obs_chunk_0')).ingestedAt, T(14, 0));
    assert.equal((await store.get('obs_chunk_5000')).ingestedAt, T(14, 0));
  });
});

pgTest('a batch rejected mid-way across chunks stores nothing', async () => {
  await withStore(async (store) => {
    const many = Array.from({ length: 5_001 }, (_, i) => detection(`obs_atomic_${i}`, T(13, 0) + i));
    // The last observation is unacceptable, so preparation fails before SQL.
    many[5_000] = { ...many[5_000], observedAt: Number.NaN };

    await assert.rejects(async () => store.insertBatch(batchOf(many)), /observedAt/);
    assert.equal(await store.size(), 0, 'no chunk may land when the batch is rejected');
  });
});

pgTest('EVENT TIME and KNOWLEDGE TIME survive to the millisecond', async () => {
  await withStore(async (store) => {
    const observedAt = T(13, 45, 12, 987);
    const ingestedAt = T(14, 2, 3, 4);
    await store.insertBatch(batchOf([detection('obs_msexact', observedAt)], ingestedAt));

    const row = await store.get('obs_msexact');
    assert.equal(row.observedAt, observedAt);
    assert.equal(row.ingestedAt, ingestedAt);
    assert.equal(Number.isSafeInteger(row.ingestedAt), true);

    // And the column agrees with the document, so filters and output cannot drift.
    const [window] = await store.observationsBetween({ from: observedAt, to: observedAt + 1 });
    assert.equal(window.observationId, 'obs_msexact');
    assert.equal((await store.observationsBetween({ from: observedAt + 1 })).length, 0);
  });
});

pgTest('an invalid schema name is refused before it reaches SQL', async () => {
  for (const name of ['public;drop', 'Panoptic', '1schema', '', 'a'.repeat(64), 'sch ema', null]) {
    assert.throws(() => assertSchemaName(name), /invalid schema name/);
  }
  assert.equal(assertSchemaName('panoptic_t_1_2'), 'panoptic_t_1_2');
});

pgTest('the database-name safety guard only accepts a _test database', async () => {
  assert.equal(databaseNameOf('postgres://u:p@127.0.0.1:54329/panoptic_test'), 'panoptic_test');
  assert.equal(databaseNameOf('postgres://u:p@127.0.0.1:54329/panoptic'), 'panoptic');
  assert.equal(databaseNameOf('not a url'), null);
  // This suite refused to run at import time unless the name ended in _test.
  assert.equal(databaseNameOf(DATABASE_URL).endsWith('_test'), true);
});

pgTest('connection descriptions carry no credentials', async () => {
  const described = describeConnection('postgres://panoptic:sup3rsecret@127.0.0.1:54329/panoptic_test');
  assert.equal(described, 'postgres://127.0.0.1:54329/panoptic_test');
  assert.equal(described.includes('sup3rsecret'), false);
  assert.equal(described.includes('panoptic:'), false);

  // And the live connection string never appears in what this store would log.
  assert.equal(describeConnection(DATABASE_URL).includes('@'), false);
});

pgTest('infrastructure failures are classified apart from query bugs', async () => {
  assert.equal(isInfrastructureError({ code: 'ECONNREFUSED' }), true);
  assert.equal(isInfrastructureError({ code: '08006' }), true);
  assert.equal(isInfrastructureError({ code: '57P01' }), true);
  // A constraint violation or a missing table is a bug, not an outage.
  assert.equal(isInfrastructureError({ code: '23514' }), false);
  assert.equal(isInfrastructureError({ code: '42P01' }), false);
  assert.equal(isInfrastructureError(new Error('no code')), false);
});

pgTest('two stores coexist without seeing each other', async () => {
  const a = await makeStore();
  const b = await makeStore();
  try {
    await a.insertBatch(batchOf([detection('obs_isolation_a', T(13, 0))]));
    assert.equal(await a.size(), 1);
    assert.equal(await b.size(), 0, 'each store has its own schema');
    assert.equal(await b.get('obs_isolation_a'), null);
  } finally {
    await destroyStore(a);
    await destroyStore(b);
  }
});
