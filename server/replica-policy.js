'use strict';
/* ═══════════════════════════════════════════════════════════════════
   سیاست خواندن: replica فقط‌خواندنی در برابر read-your-writes — ردیف ۵۲
                                                    (READ-POLICY-52)

   تصمیم این ردیف **داده‌محور** است: replica فقط اگر آزمون بار نشان دهد
   خواندن گلوگاه است ساخته می‌شود. شاهد ردیف ۴۶ نشان داد گلوگاه، اندازهٔ
   pool و ظرفیت DB است نه خواندن؛ پس پیش‌فرض = بدون replica.

   اما مستقل از آن تصمیم، یک ناوردا همیشه باید برقرار باشد:
     «دستگاه نوشته‌های خودش را همیشه می‌بیند.»
   یعنی اگر روزی replica اضافه شد و تأخیر آن از سقف رد شد یا کلاینت
   نوشته‌ای دارد که replica هنوز ندیده، خواندن باید به primary برگردد.

   این ماژول تنها جایی است که این تصمیم گرفته می‌شود؛ Gateway جای دیگری
   «حدس» نمی‌زند.
   ═══════════════════════════════════════════════════════════════════ */

/* سقف تأخیر مجاز replica برای سرو کردن pull (میلی‌ثانیه). بالاتر از این،
   خواندن به primary می‌رود: تأخیر بیشتر = احتمال دیدن دادهٔ کهنه. */
const MAX_REPLICA_LAG_MS = 2000;

/* انتخاب مقصد خواندن.
   ورودی:
     replica_url      آدرس replica (اگر خالی/نبود ⇒ primary)
     lag_ms           تأخیر اندازه‌گیری‌شدهٔ replica (null = نامعلوم)
     own_write_seq    بزرگ‌ترین seq نوشته‌شده توسط همین دستگاه (0 = ندارد)
     replica_seq      بزرگ‌ترین seq قابل مشاهده روی replica (null = نامعلوم)
   خروجی: { target, reason, fallback }
     target   'primary' | 'replica'
     reason   کد کوتاه و پایدار برای لاگ/متریک
     fallback آیا به‌خاطر ناوردا از replica صرف‌نظر شد
*/
function chooseReadTarget({ replica_url, lag_ms = null, own_write_seq = 0, replica_seq = null } = {}) {
  const ownSeq = Number.isFinite(Number(own_write_seq)) ? Number(own_write_seq) : 0;
  if (ownSeq > 0 && replica_seq !== null && replica_seq !== undefined) {
    const rSeq = Number(replica_seq);
    if (Number.isFinite(rSeq) && rSeq < ownSeq) {
      /* ناوردای read-your-writes: replica هنوز نوشتهٔ خودِ دستگاه را ندارد */
      return { target: 'primary', reason: 'read_your_writes', fallback: true };
    }
  }
  if (!replica_url) return { target: 'primary', reason: 'no_replica_configured', fallback: false };
  if (lag_ms === null || lag_ms === undefined) return { target: 'primary', reason: 'lag_unknown', fallback: true };
  const lag = Number(lag_ms);
  if (!Number.isFinite(lag)) return { target: 'primary', reason: 'lag_unknown', fallback: true };
  if (lag > MAX_REPLICA_LAG_MS) return { target: 'primary', reason: 'lag_over_budget', fallback: true };
  return { target: 'replica', reason: 'replica_fresh', fallback: false };
}

/* تأخیر واقعی replica: فاصلهٔ LSN دریافت‌شده (primary) و بازپخش‌شده (replica).
   اگر replica در دسترس نباشد یا پاسخ ندهد ⇒ null («نامعلوم»، نه «صفر»). */
async function measureLagMs({ primaryQuery, replicaQuery, now = () => Date.now() }) {
  try {
    const p = await primaryQuery("select extract(epoch from now()) * 1000 as ms, pg_current_wal_lsn()::text as lsn");
    const r = await replicaQuery("select extract(epoch from now()) * 1000 as ms, pg_last_wal_replay_lsn()::text as lsn, pg_last_xact_replay_timestamp() is null as none");
    const replayNull = r.rows && r.rows[0] && r.rows[0].none;
    if (replayNull) return null;
    const rTs = await replicaQuery("select extract(epoch from pg_last_xact_replay_timestamp()) * 1000 as ms");
    const primaryMs = Number(p.rows[0].ms);
    const replicaReplayAgo = primaryMs - Number(rTs.rows[0].ms);
    return Number.isFinite(replicaReplayAgo) && replicaReplayAgo >= 0 ? Math.round(replicaReplayAgo) : null;
  } catch (e) {
    return null;
  }
}

const POLICY = {
  max_replica_lag_ms: MAX_REPLICA_LAG_MS,
  /* شرط بازبینی تصمیم «بدون replica»: اگر در بار سالم، p99 خواندن از
     p99 نوشتن پیشی بگیرد یا سهم CPU خواندن از سقف رد شود. */
  revisit_when: {
    pull_p99_over_push_p99_ratio: 1.3,
    primary_read_cpu_pct: 60,
    sustained_clients: 300,
  },
};

module.exports = { chooseReadTarget, measureLagMs, MAX_REPLICA_LAG_MS, POLICY };
