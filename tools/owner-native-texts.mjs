#!/usr/bin/env node
// Row 126 — parity source for the NATIVE owner app: prints the texts/permissions of the
// retired WebView panel (apps/owner-panel/web/app.js) as JSON, so the Dart tests
// (apps/payesh/packages/payesh_owner_api/test/parity_test.dart) fail on any drift.
// Read-only; loads app.js without a DOM (OWNER_PANEL_NO_AUTOBOOT).
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
globalThis.OWNER_PANEL_NO_AUTOBOOT = 1;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = require(path.join(root, 'apps/owner-panel/web/app.js'));
const caps = {};
for (const [role, c] of Object.entries(P.CAPS)) caps[role] = Object.keys(c).filter((k) => c[k]).sort();
process.stdout.write(JSON.stringify({
  errors: P.ERRORS,
  pages: P.PAGES.map((p) => ({ id: p.id, title: p.title })),
  roles: P.ROLE_LABEL,
  caps,
  api: P.API,
}) + '\n');
