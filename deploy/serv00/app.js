'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 171 — the project's always-on CENTRAL server on serv00.com (free, FreeBSD, Passenger).

   setup.sh copies this file to  ~/domains/<DOMAIN>/public_nodejs/app.js . serv00 runs a
   "nodejs" website through Phusion Passenger: Passenger starts this file on the first request
   and hands its own socket to the first listen() call (the port in server/index.js is ignored).

   What runs: the SAME school server as every school PC (server/index.js of the release named
   in releases/manifest.json, unpacked to ~/payesh-app by setup.sh), with:
     • PAYESH_CENTRAL=1      — it is the meeting point: answers /payesh/pub/school-servers.json
                               (merged list of every school server) and takes signed announces;
     • hosting (row 167)     — each school of the owner panel without a server of its own gets
                               one here, so its users sign in from any network;
     • HOST=127.0.0.1        — no public tunnel ingress, no cloudflared (Passenger is the door);
     • PAYESH_HEADLESS=1     — API only (the apps are the interface);
     • PAYESH_NO_RESTART=1   — no self-restart: an update is a new setup.sh run (CI deploy).

   Keys never live in code: ~/.payesh.env (KEY=VALUE lines, chmod 600) written by setup.sh from
   the GitHub secrets of the deploy workflow (PAYESH_S3_ACCESS_KEY, PAYESH_S3_SECRET, …).
   ═══════════════════════════════════════════════════════════════════ */
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();

/** KEY=VALUE lines (no export, # comments, optional quotes) → process.env, unless already set. */
function loadEnv(file, env = process.env) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return 0; }
  let n = 0;
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (env[m[1]] === undefined) { env[m[1]] = v; n++; }
  }
  return n;
}

function defaults(env = process.env, home = HOME) {
  const d = {
    PAYESH_APP_ROOT: path.join(home, 'payesh-app'),
    PAYESH_DATA: path.join(home, 'payesh-data'),
    PAYESH_CENTRAL: '1',
    PAYESH_HEADLESS: '1',
    PAYESH_NO_RESTART: '1',
    PAYESH_CLOUDFLARE: '0',
    HOST: '127.0.0.1',
    /* a central server never asks itself; it tells the list who the central is */
    PAYESH_NO_DEFAULT_CENTRAL: '1',
  };
  for (const [k, v] of Object.entries(d)) if (env[k] === undefined || env[k] === '') env[k] = v;
  return env;
}

function sqliteReady() {
  try { require('node:sqlite'); return true; } catch (e) { return false; }
}

/* Passenger loads this file through its own loader (require.main is not this file) ⇒ always
   start, except when a test only wants the helpers. */
if (process.env.PAYESH_SERV00_TEST !== '1') {
  loadEnv(path.join(HOME, '.payesh.env'));
  defaults();
  if (!sqliteReady()) {
    /* node:sqlite without a flag: Node ≥ 22.13 / 23.4. Passenger cannot pass node flags. */
    const msg = 'payesh: Node ' + process.versions.node + ' has no node:sqlite without a flag — ' +
      'choose node24 (or node22 ≥ 22.13): devil www del DOMAIN; devil www add DOMAIN nodejs /usr/local/bin/node24';
    console.error(msg);
    require('http').createServer((req, res) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'node_without_sqlite', node: process.versions.node }));
    }).listen(Number(process.env.PORT || 8080));
  } else {
    fs.mkdirSync(process.env.PAYESH_DATA, { recursive: true });
    process.chdir(process.env.PAYESH_APP_ROOT);
    require(path.join(process.env.PAYESH_APP_ROOT, 'server', 'index.js'));
  }
}

module.exports = { loadEnv, defaults, sqliteReady };
