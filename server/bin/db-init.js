#!/usr/bin/env node
/**
 * Create the PANOPTIC evidence schema — `npm run db:init`.
 *
 * DELIBERATE, EXPLICIT AND SEPARATE FROM STARTUP. The server verifies the schema
 * and never creates it: silently running `CREATE TABLE` and `CREATE TRIGGER`
 * against a production database on every boot is exactly the kind of implicit
 * mutation an evidence system should not perform, and it would force the runtime
 * role to hold DDL privileges it otherwise never needs.
 *
 * The DDL itself is `ensureEvidenceSchema`, unchanged and idempotent — the same
 * statements the conformance suite has already verified. This file adds nothing
 * to it but a deliberate act.
 *
 * LEAST PRIVILEGE: run this with an administrative role (DDL), then run PANOPTIC
 * with a restricted role that may only SELECT and INSERT. Both read
 * PANOPTIC_DATABASE_URL, so no second configuration variable exists.
 *
 * @module server/bin/db-init
 */

import { pathToFileURL } from 'node:url';
import { PanopticConfigError, loadPanopticConfig } from '../config/index.js';
import { createEvidencePool, describeConnection } from '../storage/postgres/connect.js';
import { ensureEvidenceSchema } from '../storage/postgres/schema.js';
import { EVIDENCE_SCHEMA } from '../persistence/runtime.js';

// NOTE: `dropEvidenceSchema` lives beside `ensureEvidenceSchema` and drops
// CASCADE. It is deliberately NOT imported here. This command creates; nothing
// in it can destroy evidence.

/** Create the evidence schema, or explain why it could not. */
export async function main({ log = console } = {}) {
  const config = loadPanopticConfig();

  if (!config.persistence.configured) {
    log.error('[panoptic] PANOPTIC_DATABASE_URL is not set — nothing to initialise.');
    log.error('[panoptic] Set it in .env (see .env.example), then run `npm run db:init`.');
    return 1;
  }

  const connectionString = config.persistence.databaseUrl.reveal();
  // Host, port and database only — never the user, never the password.
  log.log(`[panoptic] initialising schema "${EVIDENCE_SCHEMA}" in ${describeConnection(connectionString)}`);

  const pool = createEvidencePool(connectionString, { max: 1 });
  try {
    await ensureEvidenceSchema(pool, { schema: EVIDENCE_SCHEMA });
    log.log(`[panoptic] evidence schema "${EVIDENCE_SCHEMA}" is ready.`);
    return 0;
  } catch (err) {
    // The error may name a role or a database; the message is kept to what an
    // operator needs, and the connection string never appears.
    log.error(`[panoptic] could not initialise the evidence schema: ${err?.message || err}`);
    return 1;
  } finally {
    await pool.end().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((err) => {
      if (err instanceof PanopticConfigError) console.error(`[panoptic] ${err.message}`);
      else console.error(`[panoptic] db:init failed: ${err?.message || err}`);
      process.exitCode = 1;
    });
}
