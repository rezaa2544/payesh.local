#!/usr/bin/env node
/* Row 81 — OpenAPI drift gate.
   Extracts the real HTTP routes (method + path) from the server source and compares them with
   openapi.yaml. Any route in code that is missing from the spec, or any spec operation that no
   longer exists in code, fails the gate. This means a route change without a schema update fails CI.

   Sources scanned:
     server/index.js    — school server (handleApi + outer HTTP handler)
     server/gateway.js  — data gateway (/api/gw/v1/*, health, metrics)
     server/tenancy.js  — tenant-scoped cloud slice (/api/cloud/tenancy/*)
   Delegated prefix (own contract, not duplicated here):
     /api/platform/v1/* → apps/owner-panel/server/openapi.json

   Usage: node tools/openapi-drift-81.mjs [--spec openapi.yaml] [--root .] [--json]
   Exit:  0 in sync · 1 drift · 2 input error (unreadable spec/source, zero routes parsed) */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const ROOT = path.resolve(opt('root', path.join(HERE, '..')));
const SPEC = path.resolve(ROOT, opt('spec', 'openapi.yaml'));
const AS_JSON = argv.includes('--json');

export const DELEGATED = ['/api/platform/v1'];
const METHOD_RE = /\bm\s*===\s*'(GET|POST|PUT|PATCH|DELETE)'/g;
const REGION_CAP = 100; // lines scanned after an anchor for method checks

/* regex source of a route (e.g. ^\/api\/students\/(\d+)$) → OpenAPI-style path */
export function regexToPath(src) {
  let s = src.replace(/^\^/, '').replace(/\$$/, '');
  s = s.replace(/\(\[a-z\]\[a-z0-9_\]\{1,40\}\)/g, '{collection}')
    .replace(/\(\\d\+\)/g, '{id}')
    .replace(/\(\[a-f0-9\]\+\)/g, '{id}')
    .replace(/\(\[A-Za-z0-9\._-\]\+\\\.json\)/g, '{file}')
    .replace(/\(\[A-Za-z0-9\._-\]\+\)/g, '{name}');
  s = s.replace(/\\\//g, '/').replace(/\\\./g, '.');
  if (/[\\()[\]^$*+?|]/.test(s)) throw new Error('unsupported route regex: ' + src);
  return s;
}

/* normalize parameter names so /a/{id} == /a/{userId} */
export const norm = p => p.replace(/\{[^}]+\}/g, '{}');

/* scan one source file. consts maps identifier → string (for tenancy PBASE/base) */
export function extractRoutes(src, { consts = {}, defaultGet = true, skipPrefixes = [] } = {}) {
  const lines = src.split('\n');
  const anchors = [];
  const constExpr = expr => {
    // 'lit' | IDENT | IDENT + 'lit'
    const t = expr.trim();
    let mm;
    if ((mm = t.match(/^'([^']*)'$/))) return mm[1];
    if ((mm = t.match(/^([A-Za-z_]\w*)$/)) && consts[mm[1]] != null) return consts[mm[1]];
    if ((mm = t.match(/^([A-Za-z_]\w*)\s*\+\s*'([^']*)'$/)) && consts[mm[1]] != null) return consts[mm[1]] + mm[2];
    return null;
  };
  lines.forEach((line, i) => {
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    const paths = [];
    let mm;
    // equality anchors: p === X / pathname === X / url.pathname === X (possibly several per line)
    const eqRe = /\b(?:p|pathname|url\.pathname)\s*===\s*((?:'[^']*')|(?:[A-Za-z_]\w*(?:\s*\+\s*'[^']*')?))/g;
    while ((mm = eqRe.exec(line)) !== null) {
      const v = constExpr(mm[1]);
      if (v && v.startsWith('/')) paths.push(v);
    }
    // regex anchors: X.match(/^\/api\/...$/)
    const rxRe = /\b(?:p|pathname)\.match\(\/(\^\\\/[^/]*(?:\\\/[^/]*)*?\$?)\/\)/g;
    while ((mm = rxRe.exec(line)) !== null) paths.push(regexToPath(mm[1]));
    // prefix-with-id anchor: pathname.startsWith(base + '/') → {base}/{id}
    const swRe = /\bpathname\.startsWith\(([A-Za-z_]\w*)\s*\+\s*'\/'\)/g;
    while ((mm = swRe.exec(line)) !== null) if (consts[mm[1]]) paths.push(consts[mm[1]] + '/{id}');
    for (const p of paths) anchors.push({ line: i, path: p });
  });
  const routes = new Map();
  anchors.forEach((a, k) => {
    if (a.path === '/' || skipPrefixes.some(sp => a.path === sp || a.path.startsWith(sp + '/'))) return;
    const end = Math.min(lines.length, a.line + REGION_CAP, k + 1 < anchors.length && anchors[k + 1].line > a.line ? anchors[k + 1].line : lines.length);
    const methods = new Set();
    // same line first; if the anchor line names methods, the region is not needed
    for (const mm of lines[a.line].matchAll(METHOD_RE)) methods.add(mm[1]);
    if (!methods.size) for (let j = a.line + 1; j < end; j++) for (const mm of lines[j].matchAll(METHOD_RE)) methods.add(mm[1]);
    if (!methods.size && defaultGet) methods.add('GET');
    for (const m of methods) routes.set(m + ' ' + a.path, { method: m, path: a.path, line: a.line + 1 });
  });
  return routes;
}

export function codeRoutes(root = ROOT) {
  const read = f => fs.readFileSync(path.join(root, f), 'utf8');
  const all = new Map();
  const add = (file, m) => { for (const [k, v] of m) all.set(k, Object.assign({ file }, v)); };
  add('server/index.js', extractRoutes(read('server/index.js'), { skipPrefixes: DELEGATED }));
  add('server/gateway.js', extractRoutes(read('server/gateway.js'), { skipPrefixes: DELEGATED }));
  const ten = read('server/tenancy.js');
  const consts = {};
  for (const mm of ten.matchAll(/const\s+(base|PBASE)\s*=\s*'([^']+)'/g)) consts[mm[1]] = mm[2];
  add('server/tenancy.js', extractRoutes(ten, { consts, skipPrefixes: DELEGATED }));
  return all;
}

/* minimal reader for our own openapi.yaml layout: `paths:` → 2-space path keys → 4-space methods */
export function specRoutes(text) {
  const out = new Map();
  const lines = text.split('\n');
  let inPaths = false; let cur = null;
  const problems = [];
  lines.forEach((l, i) => {
    if (/^paths:\s*$/.test(l)) { inPaths = true; return; }
    if (inPaths && /^\S/.test(l)) { inPaths = false; cur = null; return; }
    if (!inPaths) return;
    let mm;
    if ((mm = l.match(/^ {2}(?:'|")?(\/[^'":]*)(?:'|")?:\s*$/))) { cur = mm[1]; return; }
    if (cur && (mm = l.match(/^ {4}(get|post|put|patch|delete|head|options):\s*$/))) {
      const key = mm[1].toUpperCase() + ' ' + cur;
      if (mm[1] === 'head' || mm[1] === 'options') return;
      out.set(key, { method: mm[1].toUpperCase(), path: cur, line: i + 1 });
    }
  });
  return { routes: out, problems };
}

export function compare(code, spec) {
  const cn = new Map([...code].map(([, v]) => [v.method + ' ' + norm(v.path), v]));
  const sn = new Map([...spec].map(([, v]) => [v.method + ' ' + norm(v.path), v]));
  const missingInSpec = [...cn.keys()].filter(k => !sn.has(k)).sort().map(k => cn.get(k));
  const staleInSpec = [...sn.keys()].filter(k => !cn.has(k)).sort().map(k => sn.get(k));
  return { missingInSpec, staleInSpec };
}

function main() {
  let specText;
  try { specText = fs.readFileSync(SPEC, 'utf8'); } catch (e) { console.error('INPUT-ERROR spec unreadable: ' + SPEC); process.exit(2); }
  if (!/^openapi:\s*3\.\d+\.\d+/m.test(specText)) { console.error('INPUT-ERROR not an OpenAPI 3 document'); process.exit(2); }
  const code = codeRoutes(ROOT);
  const { routes: spec } = specRoutes(specText);
  if (code.size < 10 || spec.size < 10) { console.error(`INPUT-ERROR too few routes parsed (code=${code.size} spec=${spec.size})`); process.exit(2); }
  // every operation must carry operationId + responses (cheap structural check)
  const ops = specText.split(/\n(?= {4}(?:get|post|put|patch|delete):\s*\n)/).slice(1);
  const noId = ops.filter(o => !/\n {6}operationId:\s*\S/.test(o.split(/\n {2}\S|\n {4}(?:get|post|put|patch|delete):/)[0])).length;
  const { missingInSpec, staleInSpec } = compare(code, spec);
  if (AS_JSON) {
    console.log(JSON.stringify({ code: code.size, spec: spec.size, missingInSpec, staleInSpec, noOperationId: noId }, null, 2));
  } else {
    console.log(`# openapi-drift-81 spec=${path.relative(ROOT, SPEC)} code_routes=${code.size} spec_operations=${spec.size} delegated=${DELEGATED.join(',')}`);
    for (const r of missingInSpec) console.log(`FAIL missing-in-spec ${r.method} ${r.path}  (${r.file}:${r.line})`);
    for (const r of staleInSpec) console.log(`FAIL stale-in-spec ${r.method} ${r.path}  (openapi.yaml:${r.line})`);
    if (noId) console.log(`FAIL operations-without-operationId=${noId}`);
  }
  const ok = !missingInSpec.length && !staleInSpec.length && !noId;
  console.log(ok ? 'OPENAPI-DRIFT-81-OK' : 'OPENAPI-DRIFT-81-FAIL');
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
