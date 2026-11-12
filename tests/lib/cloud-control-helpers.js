'use strict';
/* ابزار آزمون پیروی سرور از پنل مالک (server/cloud-control.js) — پایگاهِ متای درون‌حافظه */
function memStore() {
  const meta = new Map();
  const audits = [];
  return {
    meta, audits,
    getMeta(k, fb = null) { return meta.has(k) ? meta.get(k) : fb; },
    setMeta(k, v) { meta.set(k, String(v)); },
    audit(e) { audits.push(e); },
  };
}

/* همان کاری که پنل مالک می‌کند: فرمان مهرشده با Secret Key صندوقچهٔ مقصد */
async function publish(cc, s3mem, where, target, rev) {
  const env = cc.seal(where.secret, rev, Object.assign({ prefix: 'payesh/' }, target));
  await s3mem.put(s3mem.normalize(where), 'payesh/' + cc.CONTROL_KEY, JSON.stringify(env));
  return env;
}

module.exports = { memStore, publish };
