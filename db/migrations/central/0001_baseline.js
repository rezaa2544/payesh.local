'use strict';
/* Row 86 — baseline of the versioned central-DB migrations.
   It adopts the existing idempotent schema (server/tenancy.js SCHEMA_SQL:
   CREATE … IF NOT EXISTS, RLS policies, grants). On a database built by an
   older release it changes nothing and loses nothing. From here on, every
   schema change is a new numbered file in this directory, linted by
   server/migrator.js (expand → migrate → contract).
   No down(): rolling back the baseline would mean dropping the product
   tables, which is never a migration; the migrator refuses (missing_down). */
const tenancy = require('../../../server/tenancy');

module.exports = {
  phase: 'expand',
  /* SCHEMA_SQL contains a DO $$ … $$ block and CREATE ROLE; run in one tx */
  transaction: true,
  async up(client) { await tenancy.migrate(client); },
};
