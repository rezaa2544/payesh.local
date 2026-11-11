'use strict';
/* ═══════════════════════════════════════════════════════════════════
   Row 80 — opt-in error reports / telemetry WITHOUT PII (web client).
   Contract: docs/cloud/contracts/telemetry-v1.schema.json
   Server:   payesh_direct.telemetry_ingest (db/migrations/direct/0007)
   Doc:      docs/security/80-telemetry.md · Test: tests/telemetry-80.js

   Rules (the same three layers as the server):
     1) CONSENT FIRST. Nothing is collected or sent unless the user opted in
        (`payesh.telemetry.consent` = "1"; default OFF). Revoking consent drops
        the queue immediately.
     2) FIELD ALLOWLIST. An event is REBUILT from the allowlisted fields only
        (ALLOWED below); any other property of the input — message, stack,
        name, national_id, phone, user/student ids… — is never copied.
        Values must match the contract patterns or the field is dropped; an
        event without a valid type/code is dropped entirely.
     3) PII GUARD. A string with 7+ consecutive digits, an '@' or whitespace is
        dropped (a national id / phone / e-mail smuggled into `code`).
   Transport: ONLY the direct path (row 110) — provider.rpc('telemetry_ingest',
   [events, true]). There is no Gateway route; with no direct provider the
   reporter does nothing. Rate limit: the client batches ≤ 20 and keeps ≤ 60
   per hour per device (the server enforces the same and more).
   Dependency-free; Node ≥ 18 and browsers.
   ═══════════════════════════════════════════════════════════════════ */

const ALLOWED = Object.freeze(['v', 'type', 'code', 'where', 'platform', 'app_version', 'count', 'duration_ms']);
const TYPES = Object.freeze(['error', 'crash', 'sync_failure', 'perf']);
const PLATFORMS = Object.freeze(['android', 'windows', 'web']);
const PATTERNS = Object.freeze({
  code: /^[a-z][a-z0-9_.]{0,63}$/,
  where: /^[a-z][a-z0-9_./-]{0,63}$/,
  app_version: /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,4}([+-][0-9A-Za-z.]{1,20})?$/,
});
const LIMITS = Object.freeze({ max_batch: 20, per_device_per_hour: 60, max_queue: 100 });
const CONSENT_KEY = 'payesh.telemetry.consent';

function looksLikePII(v) {
  return typeof v === 'string' && (/[0-9]{7,}/.test(v) || v.includes('@') || /\s/.test(v));
}

/** Rebuild one event from allowlisted fields only. Returns null when it cannot be valid. */
function toEvent(input, defaults = {}) {
  const src = Object.assign({}, defaults || {}, input || {});
  const out = { v: 1 };
  if (!TYPES.includes(src.type)) return null;
  out.type = src.type;
  if (typeof src.code !== 'string' || looksLikePII(src.code) || !PATTERNS.code.test(src.code)) return null;
  out.code = src.code;
  if (!PLATFORMS.includes(src.platform)) return null;
  out.platform = src.platform;
  if (typeof src.where === 'string' && !looksLikePII(src.where) && PATTERNS.where.test(src.where)) out.where = src.where;
  if (typeof src.app_version === 'string' && !looksLikePII(src.app_version) && PATTERNS.app_version.test(src.app_version)) out.app_version = src.app_version;
  if (Number.isInteger(src.count) && src.count >= 0 && src.count <= 999999) out.count = src.count;
  if (Number.isInteger(src.duration_ms) && src.duration_ms >= 0 && src.duration_ms <= 99999999) out.duration_ms = src.duration_ms;
  for (const k of Object.keys(out)) if (!ALLOWED.includes(k)) delete out[k];   /* belt and braces */
  return out;
}

/** An Error / DirectError → event. Only the machine code survives — never the message or stack. */
function fromError(err, { where, platform = 'web', app_version } = {}) {
  const raw = String((err && (err.code || err.name)) || 'unknown').toLowerCase().replace(/[^a-z0-9_.]/g, '_');
  const code = /^[a-z]/.test(raw) ? raw.slice(0, 64) : 'e_' + raw.slice(0, 62);
  return toEvent({ type: 'error', code, where, platform, app_version });
}

class TelemetryReporter {
  /** @param {{ provider?: {rpc: Function}, storage?: {getItem, setItem, removeItem}, now?: () => number, defaults?: object }} o */
  constructor({ provider = null, storage = null, now = () => Date.now(), defaults = {} } = {}) {
    this.provider = provider;
    this.storage = storage;
    this.now = now;
    this.defaults = Object.assign({ platform: 'web' }, defaults);
    this.queue = [];
    this.sent = [];   /* timestamps of events sent in the last hour (client-side limit) */
  }
  consented() {
    try { return !!this.storage && this.storage.getItem(CONSENT_KEY) === '1'; } catch (e) { return false; }
  }
  setConsent(on) {
    if (!this.storage) return;
    if (on) this.storage.setItem(CONSENT_KEY, '1');
    else { this.storage.removeItem(CONSENT_KEY); this.queue = []; }
  }
  /** Queue an event (object or Error). Returns the sanitized event or null (dropped). */
  record(input) {
    if (!this.consented()) return null;
    const ev = input instanceof Error ? fromError(input, this.defaults) : toEvent(input, this.defaults);
    if (!ev) return null;
    if (this.queue.length >= LIMITS.max_queue) this.queue.shift();
    this.queue.push(ev);
    return ev;
  }
  /** Send up to max_batch queued events through the DIRECT provider. */
  async flush() {
    if (!this.consented()) { this.queue = []; return { sent: 0, reason: 'no_consent' }; }
    if (!this.provider || typeof this.provider.rpc !== 'function') return { sent: 0, reason: 'no_direct_transport' };
    const hourAgo = this.now() - 3600000;
    this.sent = this.sent.filter(t => t > hourAgo);
    const room = Math.min(LIMITS.max_batch, LIMITS.per_device_per_hour - this.sent.length);
    if (room <= 0 || !this.queue.length) return { sent: 0, reason: room <= 0 ? 'rate_limited' : 'empty' };
    const batch = this.queue.slice(0, room);
    await this.provider.rpc('telemetry_ingest', [JSON.stringify(batch), true]);
    this.queue.splice(0, batch.length);
    for (let i = 0; i < batch.length; i++) this.sent.push(this.now());
    return { sent: batch.length };
  }
}

const api = { ALLOWED, TYPES, PLATFORMS, PATTERNS, LIMITS, CONSENT_KEY, looksLikePII, toEvent, fromError, TelemetryReporter };
if (typeof module === 'object' && module.exports) module.exports = api;
if (typeof globalThis !== 'undefined') globalThis.PayeshTelemetry = api;
