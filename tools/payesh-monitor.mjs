// Payesh free-tier scheduled monitor (GitHub Actions "serverless server").
// Checks the public endpoints, validates the rendezvous JSON, optionally
// reports to Telegram, and writes a machine-readable report artifact.
// No secrets or school data are ever read or printed.
import { writeFile } from 'node:fs/promises';

const TIMEOUT_MS = 15000;
const TARGETS = [
  { name: 'site', url: 'https://payeshschool.ir/', expect: 'http200' },
  { name: 'web-app', url: 'https://app.payeshschool.ir/', expect: 'http200' },
  { name: 'school-servers', url: 'https://payeshschool.ir/payesh/pub/school-servers.json', expect: 'servers-json' },
];

async function check(t) {
  const started = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch(t.url, { signal: ctrl.signal, redirect: 'follow' });
    clearTimeout(timer);
    const ms = Date.now() - started;
    let detail = '';
    let ok = res.status === 200;
    if (ok && t.expect === 'servers-json') {
      const data = await res.json();
      ok = data && data.kind === 'payesh-school-servers' && Array.isArray(data.servers);
      detail = ok ? `servers=${data.servers.length} updated=${data.at ?? '?'}` : 'invalid rendezvous JSON';
    }
    return { name: t.name, url: t.url, ok, status: res.status, ms, detail };
  } catch (e) {
    return { name: t.name, url: t.url, ok: false, status: 0, ms: Date.now() - started, detail: String(e.name || e) };
  }
}

const results = [];
for (const t of TARGETS) results.push(await check(t));
const allOk = results.every(r => r.ok);
const report = { at: new Date().toISOString(), allOk, results };
await writeFile(process.env.PAYESH_REPORT_PATH || 'payesh-monitor-report.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
if (token && chatId && process.env.PAYESH_SEND_TELEGRAM !== 'false') {
  const lines = results.map(r => `${r.ok ? '✅' : '❌'} ${r.name}: ${r.status || 'خطا'} (${r.ms}ms)${r.detail ? ' — ' + r.detail : ''}`);
  const text = `${allOk ? '✅ پایش پایش: همه سرویس‌ها سالم‌اند' : '⚠️ پایش پایش: مشکل شناسایی شد'}\n${lines.join('\n')}\n🕐 ${report.at}`;
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  console.log('telegram:', r.status);
} else {
  console.log('telegram: skipped (secrets not set)');
}
process.exit(allOk ? 0 : 1);
