/* ═══════════════════════════════════════════════════════════════════
   Payesh Cloud Hub — Cloudflare Worker + D1
   نقش: وقتی سیستم مدرسه خاموش است، اولیا/دانش‌آموزان دادهٔ «نمای خانواده»
   را از این‌جا می‌بینند و در‌خواست‌ها را در صف می‌گذارند تا مدرسه‌ی روشن
   آن‌ها را بکشد. هیچ دادهٔ خامی از مدرسه این‌جا نمی‌آید؛ فقط خلاصهٔ هر
   دانش‌آموز.

   استقرار:
     wrangler d1 create payesh_hub
     wrangler d1 execute payesh_hub --file=schema.sql
     wrangler secret put SCHOOL_KEY
     wrangler deploy
   ─────────────────────────────────────────────────────────────────── */

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: Object.assign({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization, content-type',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
    }, extra),
  });

const sha256 = async (text) => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
};

const bearer = (req) => {
  const h = String(req.headers.get('authorization') || '');
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
};

const isSchool = (req, env) => !!env.SCHOOL_KEY && bearer(req) === env.SCHOOL_KEY;

async function body(req, limit = 512 * 1024) {
  const text = await req.text();
  if (text.length > limit) throw new Error('too_large');
  try { return text ? JSON.parse(text) : {}; } catch (e) { throw new Error('bad_json'); }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return json({ ok: true });

    try {
      if (url.pathname === '/v1/health') {
        const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM projection').first();
        const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM outbox WHERE drained_at IS NULL").first();
        return json({ ok: true, students: (rows && rows.n) || 0, outbox_pending: (pending && pending.n) || 0 });
      }

      /* ── مدرسه: فرستادن نمای خانواده ── */
      if (url.pathname === '/v1/push' && request.method === 'POST') {
        if (!isSchool(request, env)) return json({ ok: false, error: 'forbidden' }, 403);
        const { rows = [] } = await body(request);
        if (!Array.isArray(rows)) return json({ ok: false, error: 'bad_rows' }, 400);
        let saved = 0;
        for (const r of rows.slice(0, 2000)) {
          if (!r || !r.family_key || !r.student_id) continue;
          await env.DB.prepare(
            `INSERT INTO projection(student_id, family_key, payload, updated_at, version)
             VALUES(?,?,?,?,1)
             ON CONFLICT(student_id) DO UPDATE SET
               family_key=excluded.family_key, payload=excluded.payload,
               updated_at=excluded.updated_at, version=projection.version+1`
          ).bind(Number(r.student_id), String(r.family_key), JSON.stringify(r.payload || {}), String(r.updated_at || new Date().toISOString())).run();
          saved++;
        }
        return json({ ok: true, saved });
      }

      /* ── خانواده: خواندن ── */
      if (url.pathname === '/v1/family' && request.method === 'GET') {
        const token = bearer(request);
        if (!token) return json({ ok: false, error: 'unauthorized' }, 401);
        const fk = await sha256(token);
        const row = await env.DB.prepare('SELECT student_id, payload, updated_at FROM projection WHERE family_key=?').bind(fk).first();
        if (!row) return json({ ok: false, error: 'not_found' }, 404);
        return json({ ok: true, student_id: row.student_id, updated_at: row.updated_at, payload: JSON.parse(row.payload) });
      }

      /* ── خانواده: ثبت درخواست در صف ── */
      if (url.pathname === '/v1/outbox' && request.method === 'POST') {
        const token = bearer(request);
        if (!token) return json({ ok: false, error: 'unauthorized' }, 401);
        const fk = await sha256(token);
        const row = await env.DB.prepare('SELECT student_id FROM projection WHERE family_key=?').bind(fk).first();
        if (!row) return json({ ok: false, error: 'not_found' }, 404);
        const b = await body(request);
        const uid = String(b.uid || '').slice(0, 64) || crypto.randomUUID();
        await env.DB.prepare(
          `INSERT INTO outbox(uid, student_id, kind, payload, created_at)
           VALUES(?,?,?,?,?) ON CONFLICT(uid) DO NOTHING`
        ).bind(uid, row.student_id, String(b.kind || 'leave').slice(0, 24), JSON.stringify(b.payload || {}), new Date().toISOString()).run();
        return json({ ok: true, uid, queued: true });
      }

      /* ── مدرسه: کشیدن صف ── */
      if (url.pathname === '/v1/outbox' && request.method === 'GET') {
        if (!isSchool(request, env)) return json({ ok: false, error: 'forbidden' }, 403);
        const limit = Math.min(Number(url.searchParams.get('limit') || 100), 500);
        const { results } = await env.DB.prepare(
          'SELECT id, uid, student_id, kind, payload, created_at FROM outbox WHERE drained_at IS NULL ORDER BY id LIMIT ?'
        ).bind(limit).all();
        return json({ ok: true, rows: (results || []).map((r) => Object.assign({}, r, { payload: JSON.parse(r.payload) })) });
      }

      if (url.pathname === '/v1/outbox/ack' && request.method === 'POST') {
        if (!isSchool(request, env)) return json({ ok: false, error: 'forbidden' }, 403);
        const { ids = [] } = await body(request);
        for (const id of ids.slice(0, 500)) {
          await env.DB.prepare('UPDATE outbox SET drained_at=? WHERE id=?').bind(new Date().toISOString(), Number(id)).run();
        }
        return json({ ok: true, acked: ids.length });
      }

      return json({ ok: false, error: 'not_found' }, 404);
    } catch (e) {
      const msg = String((e && e.message) || e);
      return json({ ok: false, error: msg === 'too_large' || msg === 'bad_json' ? msg : 'server_error' }, 400);
    }
  },
};
