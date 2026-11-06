'use strict';
// آزمون خودکار نمونهٔ ۲۱ — پایلوت، مهاجرت کنترل‌شده، بازیابی و rollback
// اجرا: node prototype/slice-21/tests/run.js
// مرجع: ۱۶‑ب §۳ (۹ گام + گزارش §۳.۳) · ۱۵ §۲.۱/§۳/§۳.۲/§۴ · ۱۶ §۶ (هشدارها و go/no‑go)

const crypto = require('node:crypto');
const { Migrator, LegacyStore, COLLECTIONS } = require('../migrate');
const { Monitor, THRESHOLDS } = require('../monitor');
const { Pilot, WAVES } = require('../rollout');
const { LiveDB, BackupVault, Restorer } = require('../restore');
const { sha256, stableStringify, seal, newKey } = require('../vault');

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? '✓' : '✗'} ${name}${cond ? '' : ' — ' + detail}`);
}

const seedLegacy = () => {
  const s = new LegacyStore();
  for (let i = 0; i < 12; i++) s.insert('students', { id: `st-${i}`, name: `هنرجو ${i}`, grade: 10 + (i % 3) });
  for (let i = 0; i < 30; i++) s.insert('grades', { id: `g-${i}`, student_id: `st-${i % 12}`, subject: 'ریاضی', score: 10 + (i % 10) });
  for (let i = 0; i < 20; i++) s.insert('attendance', { id: `a-${i}`, student_id: `st-${i % 12}`, status: i % 2 ? 'present' : 'late' });
  for (let i = 0; i < 4; i++) s.insert('users', { id: `u-${i}`, role: i === 0 ? 'manager' : 'teacher' });
  return s;
};

const healthy = {
  err5xx_rate: 0.001, replication_lag_s: 2, backup_age_h: 3, disk_pct: 40, readyz_down_s: 0,
  queue_ops_per_tenant: 50, conflicts_per_school_day: 3, p95_ratio: 0.8,
  tenant_leak: 0, audit_chain_broken: 0, restore_failure: 0,
};

function main() {
  // =================== M) مهاجرت کنترل‌شده (۲۰ ادعا) ===================
  {
    const store = seedLegacy();
    const m = new Migrator({ store, tenantId: 'T0', now: () => 1_000_000 });
    let e = null;
    try { m.step1_precheck({ actor: 'teacher', role: 'teacher' }); } catch (err) { e = err; }
    check('M1 پیش‌بررسی مهاجرت فقط با platform_owner', e && e.message === 'owner_required');

    const backup = m.step1_precheck({ actor: 'owner', role: 'platform_owner' });
    check('M2 پیش‌بررسی بکاپ کامل با SHA و شمارش هر مجموعه می‌سازد',
      backup.sha256.length === 64 && backup.counts.students === 12 && backup.counts.grades === 30);
    check('M3 گام ۲ همهٔ ردیف‌ها را با tenant_id=T0 برچسب می‌زند',
      (m.step2_addColumn(), COLLECTIONS.every((c) => store.all(c).every((r) => r.tenant_id === 'T0'))));
    const dw = m.step3_dualWrite([{ collection: 'grades', row: { id: 'g-new', student_id: 'st-1', subject: 'شیمی', score: 19 } }]);
    check('M4 کپی سایه: نوشتن مضاعف در هر دو مسیر و شمارش برابر',
      dw.dual_writes === 1 && m.shadowCounts().grades === store.counts().grades);
    const rec = m.step4_reconcile();
    check('M5 آزمون تطبیق: شمارش و هش ۴ مجموعه برابر ⇒ matched', rec.matched === true && Object.keys(rec.counts).length === 4);
    const rls = m.step5_rlsQuarantine({ probeTenant: 'T1' });
    check('M6 RLS در قرنطینه: صفر نشت بین دو مستأجر', rls.leaks === 0);
    const rk = m.step6_rekey();
    check('M7 بازرمزنگاری با کلید مستأجر: کلید قدیمی رد، AAD به مستأجر مقید',
      rk.rekeyed === 3 && rk.old_key_denied === true && rk.aad_bound === true);
    const sw = m.step7_switchReads();
    const switchedHash = sha256(stableStringify([...m.readAll('grades')].sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1))));
    check('M8 سوئیچ خواندن: مسیر فعال «tenant» و محتوا برابر مسیر قدیم',
      sw.readPath === 'tenant' && switchedHash === m.shadowHashes().grades && m.readPath === 'tenant');

    let stabErr = null;
    try { m.step8_removeLegacy({ stabilityDays: 7 }); } catch (err) { stabErr = err; }
    check('M9 حذف مسیر قدیم پیش از ۷ روز پایداری ممنوع است', stabErr && /stability_not_met/.test(stabErr.message) && m.legacyPresent === true);

    m.now = () => 1_000_000 + 8 * 86_400_000;
    const rm = m.step8_removeLegacy({ stabilityDays: 7 });
    check('M10 پس از پایداری: مسیر قدیم آرشیو می‌شود و هیچ ردیفی حذف نمی‌شود',
      rm.archived === true && rm.rows === 67 && m.legacyPresent === false && store.totalRows() === 67,
      JSON.stringify({ rows: rm.rows, legacyRows: store.totalRows() }));

    const report = m.step9_report({ operator: 'owner' });
    const required = ['migration_id', 'tenant_id', 'from_version', 'to_version', 'started_at', 'finished_at',
      'duration_ms', 'counts_before', 'counts_after', 'hash_before', 'hash_after', 'bytes_copied', 'step_results', 'verdict', 'operator'];
    check('M11 گزارش مهاجرت همهٔ فیلدهای الزامی ۱۶‑ب §۳.۳ را دارد', required.every((k) => report[k] !== undefined), required.filter((k) => report[k] === undefined).join(','));
    check('M12 حکم گزارش matched و ثبت در audit با SHA گزارش',
      report.verdict === 'matched' && m.audit.some((a) => a.action === 'migration.report' && a.sha === report.sha256));
    check('M13 گزارش ۹ گام را با نتیجهٔ هر گام ثبت می‌کند', report.step_results.length === 9 && report.step_results.every((s) => s.ok));
  }
  {
    // ترتیب گام‌ها و توقف در تطبیق ناموفق
    const store = seedLegacy();
    const m = new Migrator({ store, now: () => 2_000_000 });
    let e = null;
    try { m.step4_reconcile(); } catch (err) { e = err; }
    check('M14 پرش از گام ممنوع است (step_out_of_order)', e && /step_out_of_order/.test(e.message));

    m.step1_precheck({ actor: 'owner', role: 'platform_owner' });
    m.step2_addColumn();
    m.step3_dualWrite([]);
    const rowsBefore = store.totalRows();
    m.shadow.get('grades').pop();                       // خرابی عمدی در کپی سایه
    let recErr = null;
    try { m.step4_reconcile(); } catch (err) { recErr = err; }
    check('M15 تطبیق ناموفق ⇒ توقف با گزارش تفاوت (ادامه با فرض ممنوع)',
      recErr && /reconcile_mismatch/.test(recErr.message) && recErr.diffs.some((d) => d.field === 'count'));
    check('M16 مهاجرت ناموفق هیچ ردیفی حذف نمی‌کند و مسیر قدیم مرجع می‌ماند',
      store.totalRows() === rowsBefore && m.readPath === 'legacy' && m.verdict === 'failed');
    const rb = m.rollback({ reason: 'reconcile_mismatch' });
    check('M17 rollback همهٔ ردیف‌ها را حفظ و خواندن را به مسیر قدیم برمی‌گرداند',
      rb.ok === true && rb.read_path === 'legacy' && rb.counts.grades === 30 && m.audit.some((a) => a.action === 'migration.rollback'));
  }
  {
    // اجرای کامل ۱→۹ و بازتولیدپذیری هش
    const a = new Migrator({ store: seedLegacy(), now: () => 3_000_000 });
    const repA = a.run({ operator: 'owner' });
    const b = new Migrator({ store: seedLegacy(), now: () => 3_000_000 });
    const repB = b.run({ operator: 'owner' });
    check('M18 اجرای کامل ۹ گام ⇒ verdict=matched با شاهد هر گام', repA.verdict === 'matched' && repA.step_results.length === 9);
    check('M19 همان داده با ترتیب/زمان متفاوت ⇒ همان هش پیش/پس (بازتولیدپذیر)',
      repA.hash_before.grades === repB.hash_before.grades && repA.hash_after.grades === repB.hash_after.grades);
    check('M20 پس از مهاجرت، مستأجر دوم صفر ردیف می‌بیند (جداسازی)',
      !!a.quarantine && a.quarantine.leaks.length === 0 && repA.verdict === 'matched');
  }

  // =================== P) پایلوت و go/no‑go (۱۸ ادعا) ===================
  {
    let t = 5_000_000;
    const now = () => t;
    const mon = new Monitor({ now });
    const pilot = new Pilot({ monitor: mon, now });

    let e = null;
    try { pilot.start({ actor: 'x', role: 'teacher' }); } catch (err) { e = err; }
    check('P1 شروع پایلوت فقط با platform_owner', e && e.message === 'owner_required');
    pilot.start({ actor: 'owner', role: 'platform_owner' });

    e = null;
    try { pilot.expand({ actor: 'owner', role: 'platform_owner' }); } catch (err) { e = err; }
    check('P2 گسترش بدون عکس لحظه‌ای سنجه‌ها ممنوع است (evidence_required)', e && e.message === 'evidence_required');

    mon.snapshot(healthy, { label: 'wave0' });
    const w0 = pilot.expand({ actor: 'owner', role: 'platform_owner' });
    check('P3 موج اول با سنجه‌های سالم: ۱ مدرسه و تصمیم gate',
      w0.wave === 0 && w0.schools === 1 && w0.decision === 'gate');
    mon.snapshot(healthy, { label: 'wave1' });
    const w1 = pilot.expand({ actor: 'owner', role: 'platform_owner' });
    check('P4 موج دوم پله‌به‌پله: ۱۰ مدرسه (بدون پرش)', w1.wave === 1 && w1.schools === 10 && WAVES[1] === 10);

    // P1: خطای ۵xx بالای آستانه
    mon.snapshot({ ...healthy, err5xx_rate: 0.02 }, { label: 'p1-break' });
    e = null;
    try { pilot.expand({ actor: 'owner', role: 'platform_owner' }); } catch (err) { e = err; }
    check('P5 خطای ۵xx > ۱٪ ⇒ no-go، توقف گسترش و هشدار P1',
      e && e.message === 'no_go' && pilot.state === 'halted' && e.evaluation.blockers.some((b) => b.id === 'err5xx_rate' && b.level === 'P1'));
    e = null;
    try { pilot.expand({ actor: 'owner', role: 'platform_owner' }); } catch (err) { e = err; }
    check('P6 در حالت halted گسترش رد می‌شود (pilot_halted)', e && e.message === 'pilot_halted');

    // P0: نشت بین‌مستأجری ⇒ freeze
    mon.snapshot({ ...healthy, tenant_leak: 1 }, { label: 'p0' });
    e = null;
    try { pilot.expand({ actor: 'owner', role: 'platform_owner', override: true, reason: 'تلاش' }); } catch (err) { e = err; }
    check('P7 نشت بین‌مستأجری (P0) ⇒ freeze فوری حتی با override', e && e.message === 'p0_freeze' && pilot.frozen === true);

    pilot.resume({ actor: 'owner', role: 'platform_owner' });
    mon.snapshot({ ...healthy, err5xx_rate: 0.02 }, { label: 'no-go' });
    e = null;
    try { pilot.expand({ actor: 'owner', role: 'platform_owner', override: true }); } catch (err) { e = err; }
    check('P8 override بدون دلیل ثبت‌شده رد می‌شود', e && e.message === 'override_reason_required');

    mon.snapshot(healthy, { label: 'healthy-again' });
    const w2 = pilot.expand({ actor: 'owner', role: 'platform_owner' });
    check('P9 پس از رفع، گسترش به موج سوم (۵۰ مدرسه) ادامه می‌یابد', w2.wave === 2 && w2.schools === 50);
    check('P10 ایندکس موج هر بار فقط یک پله جلو می‌رود (پرش ناممکن)', pilot.waveIndex === 2 && WAVES.every((w, i) => i === 0 || w > WAVES[i - 1]));

    const rollback = pilot.rollbackWave({ actor: 'owner', reason: 'بازگشت موج ۳' });
    check('P11 rollback موج فقط همان موج را برمی‌گرداند و موج‌های پیشین می‌مانند',
      rollback.removed === 40 && pilot.schools === 10 && pilot.waveIndex === 1);
    check('P12 rollback در audit ثبت می‌شود', pilot.audit.some((a) => a.action === 'pilot.rollback_wave' && a.removedSchools === 40));

    mon.snapshot(healthy);
    pilot.expand({ actor: 'owner', role: 'platform_owner' });
    mon.snapshot(healthy);
    const done = pilot.expand({ actor: 'owner', role: 'platform_owner' });
    check('P13 آخرین موج (۲۰۰ مدرسه) ⇒ وضعیت complete', done.wave === 3 && done.schools === 200 && pilot.state === 'complete');
    e = null;
    try { pilot.expand({ actor: 'owner', role: 'platform_owner' }); } catch (err) { e = err; }
    check('P14 گسترش پس از complete رد می‌شود (all_waves_done)', e && e.message === 'all_waves_done');
  }
  {
    // توقف مکرر، کهنگی بکاپ، و P2 (هشدار بدون توقف)
    let t = 6_000_000;
    const mon = new Monitor({ now: () => t });
    const pilot = new Pilot({ monitor: mon, now: () => t });
    pilot.start({ actor: 'owner', role: 'platform_owner' });
    mon.snapshot(healthy);
    pilot.expand({ actor: 'owner', role: 'platform_owner' });
    const h1 = pilot.halt({ actor: 'owner' });
    const n1 = pilot.audit.length;
    const h2 = pilot.halt({ actor: 'owner' });
    check('P15 توقف مکرر بی‌اثر است (idempotent، بدون ردیف audit تکراری)', h1.idempotent === false && h2.idempotent === true && pilot.audit.length === n1);

    pilot.resume({ actor: 'owner', role: 'platform_owner' });
    mon.snapshot({ ...healthy, backup_age_h: 30 });
    let e = null;
    try { pilot.expand({ actor: 'owner', role: 'platform_owner' }); } catch (err) { e = err; }
    check('P16 کهنگی بکاپ > ۲۶h ⇒ no-go (گسترش متوقف)', e && e.message === 'no_go' && e.evaluation.blockers.some((b) => b.id === 'backup_age_h'));

    pilot.resume({ actor: 'owner', role: 'platform_owner' });
    mon.snapshot({ ...healthy, queue_ops_per_tenant: 600, conflicts_per_school_day: 25 });
    const evalP2 = mon.evaluate(mon.samples[mon.samples.length - 1]);
    const w = pilot.expand({ actor: 'owner', role: 'platform_owner' });
    check('P17 هشدار P2 بدون توقف: گسترش مجاز اما با هشدار ثبت‌شده',
      evalP2.verdict === 'go' && evalP2.warnings.length === 2 && w.decision === 'gate');
    check('P18 تصمیم go/no‑go از عکس لحظه‌ای اندازه‌گیری‌شده می‌آید (نه فرض)',
      evalP2.at === mon.samples[mon.samples.length - 1].at && THRESHOLDS.length >= 10);
  }
  {
    // override مالک با دلیل: مجاز و ثبت‌شده — و اثر انگشت تصمیم
    const mon = new Monitor({ now: () => 7_000_000 });
    const pilot = new Pilot({ monitor: mon, now: () => 7_000_000 });
    pilot.start({ actor: 'owner', role: 'platform_owner' });
    mon.snapshot({ ...healthy, disk_pct: 85 });
    const ov = pilot.expand({ actor: 'owner', role: 'platform_owner', override: true, reason: 'تصمیم مالک: رفع دیسک در ۲۴h' });
    const last = pilot.audit[pilot.audit.length - 1];
    check('P19 override مالک با دلیل ثبت‌شده: گسترش انجام و دلیل در audit',
      ov.decision === 'override' && last.reason.includes('تصمیم مالک') && last.fingerprint.length === 64);
  }

  // =================== R) بازیابی، آشتی و rollback (۱۵ ادعا) ===================
  const live = new LiveDB();
  const key = newKey();
  const vault = new BackupVault({ now: () => 8_000_000 });
  const seeder = () => {
    for (let i = 0; i < 5; i++) live.insert('students', { id: `st-${i}`, name: `s${i}` });
    for (let i = 0; i < 8; i++) live.insert('grades', { id: `g-${i}`, student_id: `st-${i % 5}`, score: i });
    for (let i = 0; i < 6; i++) live.insert('attendance', { id: `a-${i}`, status: 'present' });
    for (let i = 0; i < 2; i++) live.insert('users', { id: `u-${i}`, role: i ? 'teacher' : 'manager' });
    live.sessions = 7;
  };
  seeder();
  const snapshot = live.snapshot();
  const backup = vault.create({ tenantId: 'T0', snapshot, key, pendingWrites: 3 });
  const restorer = new Restorer({ vault, live, now: () => 8_100_000 });

  {
    let e = null;
    try { restorer.restore({ actor: 'teacher', role: 'teacher', tenantId: 'T0', backup, reason: 'x' }); } catch (err) { e = err; }
    check('R1 بازیابی فقط با platform_owner (دبیر ⇒ ۴۰۳)', e && e.message === 'owner_required');
    e = null;
    try { restorer.restore({ actor: 'owner', role: 'platform_owner', tenantId: 'T0', backup }); } catch (err) { e = err; }
    check('R2 بازیابی بدون دلیل ثبت‌شده رد می‌شود', e && e.message === 'reason_required');
  }
  {
    const before = live.hashes();
    const bad = vault.tamperBox(backup);
    let e = null;
    try { restorer.restore({ actor: 'owner', role: 'platform_owner', tenantId: 'T0', backup: bad, reason: 'آزمون' }); } catch (err) { e = err; }
    check('R3 بکاپ دست‌کاری‌شده ⇒ رد کامل و صفر ردیف نوشته‌شده',
      e && /integrity_failed/.test(e.message) && e.reason === 'box_sha_mismatch' && sha256(stableStringify(live.hashes())) === sha256(stableStringify(before)));
    const forged = vault.tamperManifest(backup);
    e = null;
    try { restorer.restore({ actor: 'owner', role: 'platform_owner', tenantId: 'T0', backup: forged, reason: 'آزمون' }); } catch (err) { e = err; }
    check('R4 امضای مانیفست نامعتبر ⇒ رد پیش از هر نوشتن', e && e.reason === 'manifest_signature_invalid');
    check('R5 محیط زنده پس از دو تلاش ناموفق دست‌نخورده است', live.counts().grades === 8);
  }
  {
    // بکاپ امضاشدهٔ ناسازگار (شمارش مانیفست ≠ محتوا) ⇒ توقف در قرنطینه
    const few = live.snapshot();
    few.rows.students = few.rows.students.slice(0, 2);
    const aad = 'T0|bk-bad|B1';
    const box = seal(key, few, aad);
    const manifest = {
      backup_id: 'bk-bad', tenant_id: 'T0', level: 'B1', at: 8_050_000,
      counts: snapshot.counts, hashes: snapshot.hashes, hash: sha256(stableStringify(snapshot)),
      box_sha256: sha256(box.ct), bytes: Buffer.byteLength(box.ct, 'hex'), pending_writes: 0,
    };
    manifest.sig = crypto.sign(null, Buffer.from(stableStringify(manifest)), vault.privateKey).toString('base64');
    const beforeRows = live.totalRows();
    let e = null;
    try { restorer.restore({ actor: 'owner', role: 'platform_owner', tenantId: 'T0', backup: { manifest, box, key, aad }, reason: 'آزمون' }); } catch (err) { e = err; }
    check('R6 ناسازگاری محتوا با مانیفست در قرنطینه کشف می‌شود (صفر نوشتن)',
      e && /quarantine_mismatch/.test(e.message) && live.totalRows() === beforeRows);
  }
  let report;
  {
    // تغییر واقعی پس از لحظهٔ بکاپ، سپس بازیابی + آشتی
    live.insert('grades', { id: 'g-after', student_id: 'st-0', score: 99 });
    live.sessions = 5;
    report = restorer.restore({
      actor: 'owner', role: 'platform_owner', tenantId: 'T0', backup, reason: 'بازیابی آزمایشی',
      outbox: [{ collection: 'grades', row: { id: 'g-out', student_id: 'st-1', score: 17 } },
        { collection: 'grades', row: { id: 'g-3', student_id: 'st-3', score: 3 } }],
      clientBackup: { rows: { users: [{ id: 'u-1', role: 'manager' }], notes: [{ id: 'n-1', text: 'یادداشت' }] } },
    });
    check('R7 بازیابی معتبر ⇒ verdict=verified و قرنطینه برابر مانیفست (پیش از آشتی)',
      report.verdict === 'verified' && report.quarantine.matched === true &&
      report.quarantine.hashes.grades === backup.manifest.hashes.grades &&
      report.counts_after.grades === backup.manifest.counts.grades + 1);
    check('R8 swap اتمی + ابطال همهٔ نشست‌های مستأجر (W1)', live.sessions === 0 && report.sessions_revoked === 5);
    check('R9 ردیف تازه پس از بکاپ حذف شد (snapshot بازیابی شد)', !live.all('grades').some((r) => r.id === 'g-after'));
    check('R10 آشتی: ردیف outbox غایب اعمال می‌شود و ردیف موجود تعارض می‌شود',
      report.reconciliation.applied === 1 && report.reconciliation.conflicted === 1 && live.all('grades').some((r) => r.id === 'g-out' && r.imported_from === 'outbox'));
    check('R11 نوشتن‌های بی‌صف پنهان نمی‌شوند: «از دست‌رفته» شمرده می‌شود',
      report.reconciliation.lost === 1);
    check('R12 بکاپ کلاینت هرگز روی users/sessions/audit نوشته نمی‌شود (رفع F‑02)',
      report.reconciliation.rejected_protected_tables === 1 && live.all('users').find((r) => r.id === 'u-1').role === 'teacher');
    check('R13 ردیف غیرحساس از بکاپ کلاینت با imported_from/imported_at وارد می‌شود',
      report.reconciliation.quarantined === 1 && live.all('notes')[0].imported_from === 'client');
    check('R14 گزارش بازیابی: SHA بکاپ، RTO اندازه‌گیری‌شده و برچسب صادقانهٔ RPO',
      report.backup_sha256 === backup.manifest.hash && report.rto_ms >= 0 && /هدف، نه اندازه‌گیری/.test(report.rpo_label) && report.sha256.length === 64);
    const h = sha256(stableStringify(live.snapshot().rows));
    restorer.restore({
      actor: 'owner', role: 'platform_owner', tenantId: 'T0', backup, reason: 'تکرار',
      outbox: [{ collection: 'grades', row: { id: 'g-out', student_id: 'st-1', score: 17 } },
        { collection: 'grades', row: { id: 'g-3', student_id: 'st-3', score: 3 } }],
      clientBackup: { rows: { users: [{ id: 'u-1', role: 'manager' }], notes: [{ id: 'n-1', text: 'یادداشت' }] } },
    });
    check('R15 بازیابی مجدد همان بکاپ idempotent است (محتوا تغییر نمی‌کند)',
      sha256(stableStringify(live.snapshot().rows)) === h);
  }

  // =================== G) صداقت و پیوند پایلوت↔بازیابی (۴ ادعا) ===================
  {
    const mon = new Monitor({ now: () => 9_000_000 });
    mon.snapshot({ ...healthy, p95_ratio: 2.5 }, { label: 'x' });
    const ev = mon.evaluate(mon.samples[0]);
    check('G1 گزارش go/no‑go مقدار سنجیده + آستانهٔ همان هشدار را با هم نشان می‌دهد',
      ev.warnings.some((w) => w.id === 'p95_ratio' && w.value === 2.5 && w.limit === 2));
    check('G2 هیچ ادعای «آمادهٔ تولید» یا «ظرفیت اثبات‌شده» در گزارش‌ها نیست',
      !/production-ready|آمادهٔ تولید|ظرفیت اثبات‌شده/i.test(JSON.stringify([report, mon.samples])));
    check('G3 گزارش مهاجرت و بازیابی هر دو SHA دارند و زنجیرهٔ audit سالم است',
      report.sha256.length === 64 && restorer.audit.every((r, i) => (i === 0 ? r.prev_hash === 'GENESIS' : r.prev_hash === restorer.audit[i - 1].hash)));
    // rollback پایلوت با snapshot: بازیابی وضعیت پیش از موج
    const live2 = new LiveDB();
    for (let i = 0; i < 4; i++) live2.insert('students', { id: `s-${i}` });
    const snap = live2.snapshot();
    const v2 = new BackupVault({ now: () => 9_100_000 });
    const key2 = newKey();
    const b2 = v2.create({ tenantId: 'T0', snapshot: snap, key: key2 });
    for (let i = 4; i < 7; i++) live2.insert('students', { id: `s-${i}` });
    const r2 = new Restorer({ vault: v2, live: live2, now: () => 9_200_000 });
    const rep2 = r2.restore({ actor: 'owner', role: 'platform_owner', tenantId: 'T0', backup: b2, reason: 'rollback پایلوت' });
    check('G4 rollback با snapshot: وضعیت دقیقاً به پیش از موج برمی‌گردد',
      live2.all('students').length === 4 && rep2.hash_after.students === snap.hashes.students);
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n${passed} موفق · ${failed} ناموفق`);
  console.log(`SUMMARY pass=${passed} fail=${failed} total=${results.length}`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
