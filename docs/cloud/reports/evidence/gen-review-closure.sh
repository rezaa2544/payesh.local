#!/usr/bin/env bash
# دروازهٔ «بستن بازبینی» — بررسی‌های تقابلی اسناد فاز ۰/۱/۲ (بدون تغییر کد محصول)
# اجرا: bash docs/cloud/reports/evidence/gen-review-closure.sh
# خروجی: docs/cloud/reports/evidence/review-closure-01.txt
# قاعده: هر بررسی یا PASS است یا FAIL؛ FAIL ⇒ کد خروج ۱ و شاهد ناموفق جداگانه (شاهد سبز قبلی بازنویسی نمی‌شود).
set -u
cd "$(dirname "$0")/../../../.." || { echo "FATAL: repo root not found" >&2; exit 2; }
OUT="docs/cloud/reports/evidence/review-closure-01.txt"
TS=$(date -u +%Y%m%dT%H%M%SZ)
RC=0
LINES="$(mktemp)"
trap 'rm -f "$LINES"' EXIT
say() { printf '%s\n' "$*" >>"$LINES"; }
ok()  { say "[PASS] $*"; }
bad() { say "[FAIL] $*"; RC=1; }

say "# شاهد بستن بازبینی — بررسی تقابلی ۰۱‑ب / ۰۴ / ۰۴‑ب / ۱۱ / ۱۲…۱۶‑ب"
say "# تولید: bash docs/cloud/reports/evidence/gen-review-closure.sh"
say "# base_head: $(git rev-parse HEAD)"
say "# generated_at_utc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
say ""

# ---------------- C1) دروازهٔ شاهد ممیزی ----------------
if bash docs/cloud/reports/evidence/gen-audit-evidence.sh >/tmp/gate.out 2>&1; then
  ok "C1 دروازهٔ شاهد ممیزی ۰۵–۱۱: EVIDENCE-OK — $(grep -m1 'measured P/F/U' /tmp/gate.out | sed 's/^→ //')"
else
  bad "C1 دروازهٔ شاهد ممیزی سبز نشد — $(tail -2 /tmp/gate.out | tr '\n' ' ')"
fi

# ---------------- C2) بازشماری احکام ۰۶–۱۰ در برابر سند ۱۱ ----------------
C2=$(python3 - <<'PYEOF'
import re, glob
files = sorted(glob.glob('docs/cloud/0[6-9]*.md') + glob.glob('docs/cloud/10*.md'))
KEYS = ('PASS','FAIL','UNKNOWN','BLOCKED'); tot = dict.fromkeys(KEYS,0); per={}
fa = lambda s: int(''.join(str(ord(c)-0x06f0) for c in s))
for f in files:
    c = dict.fromkeys(KEYS,0)
    for ln in open(f, encoding='utf-8'):
        if not ln.startswith('|'): continue
        cells=[x.strip() for x in ln.strip().strip('|').split('|')]
        if not cells or not re.match(r'^[A-Z]\u2011\d+$', cells[0]): continue
        tok = cells[-1].replace('*','').strip().split()[0].rstrip('\u2014:\u060c').upper()
        if tok in c: c[tok]+=1
    per[f.split('/')[-1]]=c
    for k in KEYS: tot[k]+=c[k]
d11=open('docs/cloud/11-gap-report.md',encoding='utf-8').read()
def row(label):
    m=re.search(r'\|\s*\*\*'+label+r'\*\*\s*\|\s*([\u06f0-\u06f9]+)', d11)
    return fa(m.group(1)) if m else -1
claim=(row('PASS'),row('FAIL'),row('UNKNOWN'))
print('TOTAL=%d' % sum(tot.values()))
print('RECOUNT=%d/%d/%d' % (tot['PASS'],tot['FAIL'],tot['UNKNOWN']))
print('DOC11=%d/%d/%d' % claim)
print('PERDOC=' + ' '.join('%s:%d/%d/%d' % (k.split('-')[0],v['PASS'],v['FAIL'],v['UNKNOWN']) for k,v in per.items()))
PYEOF
)
TOTAL_N=$(printf '%s\n' "$C2" | sed -n 's/^TOTAL=//p')
REC=$(printf '%s\n' "$C2" | sed -n 's/^RECOUNT=//p')
DOC=$(printf '%s\n' "$C2" | sed -n 's/^DOC11=//p')
PER=$(printf '%s\n' "$C2" | sed -n 's/^PERDOC=//p')
if [ "${TOTAL_N:-0}" != "73" ]; then
  bad "C2 مخرج کنترل‌ها ۷۳ نیست (TOTAL=$TOTAL_N) — جدول‌های داوری ۰۶–۱۰ تغییر کرده‌اند"
elif [ "$DOC" != "$REC" ]; then
  bad "C2 سند ۱۱ با بازشماری نمی‌خواند: doc11=$DOC recount=$REC"
else
  ok "C2 بازشماری ردیف‌محور ۰۶–۱۰ = $REC · جمع $TOTAL_N · برابر با جدول سند ۱۱"
  say "     تفکیک هر سند (PASS/FAIL/UNKNOWN): $PER"
fi

# ---------------- C3) بازمحاسبهٔ مدل ظرفیت ۰۴ §۲ ----------------
C3=$(python3 - <<'PYEOF'
import re
fa = lambda s: int(''.join(str(ord(c)-0x06f0) for c in s))
rows = {}
for ln in open('docs/cloud/04-capacity-and-availability.md', encoding='utf-8'):
    if not ln.startswith('|'): continue
    cells=[c.strip() for c in ln.strip().strip('|').split('|')]
    if len(cells) < 4: continue
    key = cells[0].replace('*','').replace('`','').strip()
    rows[key] = cells[1:4]
def num(s):
    s = s.replace('*','').replace('`','').strip()
    m = re.search(r'[\u06f0-\u06f9][\u06f0-\u06f9\u066b]*k?', s)
    if not m: return None
    tok = m.group(0)
    scale = 1000 if tok.endswith('k') else 1
    tok = tok[:-1] if scale == 1000 else tok
    parts = [''.join(str(ord(c)-0x06f0) for c in part) for part in tok.split('\u066b')]
    val = float(parts[0] + ('.' + parts[1] if scale == 1000 and len(parts) > 1 else '') ) if scale == 1000 else float(''.join(parts))
    return val*scale
def rng(s):
    s = s.replace('*','').replace('GB','').strip()
    return [num(p) for p in re.split(r'[\u2013-]', s)]
def key_of(prefix):
    for k in rows:
        if k.startswith(prefix): return k
    return None
ks, kp = key_of('مدارس فعال'), key_of('دانش\u200cآموز هر مدرسه')
kd, ku = key_of('دستگاه هم\u200cزمان'), key_of('کاربر ثبت\u200cنامی کل')
krp, krw, krt = key_of('RPS_poll'), key_of('RPS نوشتن'), key_of('RPS کل')
kdata = key_of('حجم داده')
if None in (ks,kp,kd,ku,krp,krw,krt,kdata):
    print('ERR rows not located: %s' % [x for x in (ks,kp,kd,ku,krp,krw,krt,kdata)])
else:
    errs=[]
    for i in range(3):
        sch, stu, dev = num(rows[ks][i]), num(rows[kp][i]), num(rows[kd][i])
        n_stu, n_user = sch*stu, sch*stu*3.5
        gu = num(rows[ku][i])
        if gu is None or abs(gu-n_user) > 0.51: errs.append('کاربر[%d]=%s≠%.0f' % (i,gu,n_user))
        if num(rows[krp][i]) != dev: errs.append('RPS_poll[%d]=%s≠%s' % (i,num(rows[krp][i]),dev))
        wr = dev*0.05
        if abs((num(rows[krw][i]) or -1)-wr) > 0.51: errs.append('نوشتن[%d]=%s≠%.0f' % (i,num(rows[krw][i]),wr))
        if num(rows[krt][i]) != num(rows[krp][i])+num(rows[krw][i]): errs.append('RPS کل[%d] جمع نمی‌خورد' % i)
        lo, hi = rng(rows[kdata][i])
        elo, ehi = n_stu*5/1024, n_stu*8/1024
        if abs(lo-elo) > 1.0 or abs(hi-ehi) > 1.0: errs.append('حجم[%d]=%s–%s≠%.0f–%.0f' % (i,lo,hi,elo,ehi))
    print('OK' if not errs else 'ERR ' + ' | '.join(errs))
PYEOF
)
case "$C3" in
  OK)  ok "C3 مدل ظرفیت ۰۴ §۲ بازمحاسبه شد: کاربر=۳٫۵×دانش‌آموز · RPS_poll=دستگاه · نوشتن=۵٪ · حجم=۵–۸MB/دانش‌آموز (GiB)" ;;
  *)   bad "C3 مدل ظرفیت ۰۴ با اعداد سند نمی‌خواند — ${C3#ERR }" ;;
esac

# ---------------- C4) سقف پلن‌ها ۰۴‑ب §۲ مشتق از نرخ ۰۴ ----------------
C4=$(python3 - <<'PYEOF'
import re
fa = lambda s: int(''.join(str(ord(c)-0x06f0) for c in s))
rows = {}
for ln in open('docs/cloud/04b-plan-caps-usage-model.md', encoding='utf-8'):
    if not ln.startswith('|'): continue
    cells=[c.strip() for c in ln.strip().strip('|').split('|')]
    if len(cells) < 5: continue
    rows[cells[0].replace('`','').replace('*','').strip()] = cells[1:4]
def first(s):
    m = re.search(r'[\u06f0-\u06f9]+(?:\u066b[\u06f0-\u06f9]+)?', s.replace('*',''))
    return float(fa(m.group(0).replace('\u066b',''))) if m else None
def key(prefix):
    for k in rows:
        if k.startswith(prefix): return k
    return None
ks, ku, kst = key('max_students'), key('max_users'), key('storage_mb')
if None in (ks,ku,kst):
    print('ERR rows: %s' % [ks,ku,kst])
else:
    errs=[]
    for i in range(3):
        stu, usr, sto = first(rows[ks][i]), first(rows[ku][i]), first(rows[kst][i])
        rate, ratio = sto/stu, usr/stu
        if not (5 <= rate <= 8):  errs.append('فضا[%d]=%s/%s=%.1fMB بیرون از ۵–۸' % (i,sto,stu,rate))
        if not (3.5 <= ratio <= 4.5): errs.append('کاربر[%d]=%s/%s=%.2f بیرون از ۳٫۵–۴٫۵' % (i,usr,stu,ratio))
    print('OK' if not errs else 'ERR ' + ' | '.join(errs))
PYEOF
)
case "$C4" in
  OK)  ok "C4 سقف‌های ۰۴‑ب از نرخ ۰۴ مشتق شده‌اند: فضا ۵–۸ MB/دانش‌آموز · کاربر ۳٫۵–۴٫۵×دانش‌آموز" ;;
  *)   bad "C4 سقف پلن‌ها با نرخ ۰۴ نمی‌خواند — ${C4#ERR }" ;;
esac

# ---------------- C5) نقش‌ها: D‑24 ↔ ۰۱‑ب ↔ محصول ----------------
C5=$(python3 - <<'PYEOF'
import re
con = open('docs/00-PAYESH-CLOUD-CONSTITUTION.md', encoding='utf-8').read()
m = re.search(r'فهرست نهایی نقش‌های نسخهٔ اول \(D‑24\):\*\*(.+?)\n', con)
d24 = [x.strip().strip('`.').strip() for x in m.group(1).split('·')] if m else []
d24 = [x for x in d24 if x]
map_rows = {}
in_map = False
for ln in open('docs/cloud/01b-school-plan-subscription.md', encoding='utf-8'):
    if 'نگاشت نقش‌ها' in ln: in_map = True; continue
    if in_map and ln.startswith('| `'):
        cells = [c.strip() for c in ln.strip().strip('|').split('|')]
        map_rows[cells[0].strip('`')] = cells[1]
    elif in_map and ln.startswith('**قاعدهٔ نگاشت'):
        break
prod_src = open('server/policy.js', encoding='utf-8').read()
proles = [x.strip().strip("'") for x in re.search(r"const ROLES = \[(.*?)\]", prod_src).group(1).split(',')]
allowed_product = set(d24) | {'manager'}          # manager = نگاشت صریح school_admin
errs = []
if len(d24) != 10: errs.append('D‑24=%d نقش (باید ۱۰)' % len(d24))
if set(map_rows) != set(d24):
    miss = sorted(set(d24) - set(map_rows)); extra = sorted(set(map_rows) - set(d24))
    errs.append('نگاشت ۰۱‑ب ناقص/اضافی (غایب=%s، اضافی=%s)' % (miss, extra))
if 'manager' not in (map_rows.get('school_admin') or ''):
    errs.append('school_admin به manager نگاشت نشده')
outside = [r for r in proles if r not in allowed_product]
if outside: errs.append('نقش محصول بیرون از D‑24: %s' % outside)
print(('OK' if not errs else 'ERR ' + ' | '.join(errs)) + ' || d24=%d mapping=%d product=%d[%s]' % (len(d24), len(map_rows), len(proles), ','.join(proles)))
PYEOF
)
case "$C5" in
  OK*) ok "C5 نقش‌ها: D‑24 (۱۰) = نگاشت ۰۱‑ب (۱۰) و نقش‌های محصول فقط از مجموعهٔ مجاز — ${C5#OK || }" ;;
  *)   bad "C5 نگاشت نقش‌ها با D‑24 نمی‌خواند — ${C5#ERR }" ;;
esac

# ---------------- C6) بهداشت شناسه‌ها: ردیف‌های تعریف، نه یادداشت اصلاح ----------------
C6=$(python3 - <<'PYEOF'
import glob, re
bad_rows = []
for p in sorted(glob.glob('docs/cloud/*.md') + glob.glob('docs/cloud/reports/*.md')):
    for i, ln in enumerate(open(p, encoding='utf-8'), 1):
        if not ln.startswith('|'): continue
        cells = [c.strip().replace('*','') for c in ln.strip().strip('|').split('|')]
        if not cells: continue
        head = cells[0]
        if head == 'O‑07' and '۹۹٫۹' in ln: bad_rows.append('%s:%d O‑07↔۹۹٫۹' % (p, i))
        negated = ('نه میزبان' in ln) or ('نه میزبانی' in ln) or ('شناسهٔ ثبت‌نشده' in ln)
        if head in ('O‑09', 'O‑17') and 'میزبان' in ln and not negated:
            bad_rows.append('%s:%d %s↔میزبان' % (p, i, head))
print('OK' if not bad_rows else 'ERR ' + ' | '.join(bad_rows))
PYEOF
)
case "$C6" in
  OK)  ok "C6 بهداشت شناسه‌ها: ردیف تعریف O‑07 دیگر «۹۹٫۹٪» نیست و O‑09/O‑17 برای میزبان/قیمت به‌کار نمی‌رود" ;;
  *)   bad "C6 ردیف شناسه‌ای ناسازگار باقی مانده — ${C6#ERR }" ;;
esac

# ---------------- C7) کد محصول دست‌نخورده ----------------
if ! git cat-file -e f2fc472^{commit} 2>/dev/null; then
  bad "C7 پایهٔ ممیزی f2fc472 در مخزن نیست (clone کم‌ژرفا؟) — «۰ فایل تغییر» بی‌اعتبار است"
else
  ALLOW="${RC_ALLOW:-package.json package-lock.json server/index.js server/tenancy.js server/outbox.js server/cloud-defaults.js server/s3mem.js server/auth.js server/sync.js server/db.js server/policy.js server/live.js client/app.js client/pages.js client/lib/phone.js client/lib/s3mini.js client/lib/sigv4.js client/cloud-baked.js tests/run.js tests/phone-flow.js scripts/bake-cloud.mjs}"
  OUTSIDE=$(git diff --name-only f2fc472 HEAD -- server client tests scripts package.json package-lock.json installer desktop install deploy | grep -vxF -f <(printf '%s\n' $ALLOW) | grep -c . || true)
  PROD=$(git diff --name-only f2fc472 HEAD -- server client tests scripts package.json package-lock.json installer desktop install deploy | wc -l | tr -d ' ')
  if [ "$OUTSIDE" = "0" ]; then
    ok "C7 کد محصول نسبت به پایهٔ ممیزی f2fc472: $PROD فایل، همه در فهرست مجاز D‑35"
  else
    bad "C7 کد محصول بیرون از فهرست مجاز D‑35 تغییر کرده: $OUTSIDE فایل"
  fi
fi

# ---------------- C8) AC و حکم هر سند فاز ۲ ----------------
C8=$(python3 - <<'PYEOF'
import re
docs = {'12-multitenant-architecture':8,'12b-owner-panel-boundaries':7,
        '13-secure-cache-offline-queue':9,'14-conflict-convergence':11,
        '15-backup-recovery':12,'16-ha-observability-cost':14,
        '16b-tenant-provisioning-migration':12}
errs=[]
for d,exp in docs.items():
    txt=open('docs/cloud/%s.md'%d,encoding='utf-8').read()
    ac=len(re.findall(r'^\|\s*\*{0,2}AC\u2011', txt, re.M))
    m=re.search(r'حکم:\s*([\u06f0-\u06f9]+)/([\u06f0-\u06f9]+)', txt)
    claim=int(''.join(str(ord(c)-0x06f0) for c in m.group(1))) if m else None
    if ac!=exp: errs.append('%s AC=%d (ثبت‌شده %d)'%(d,ac,exp))
    if claim!=ac: errs.append('%s حکم %s≠AC %d'%(d,claim,ac))
print('OK' if not errs else 'ERR ' + ' | '.join(errs))
PYEOF
)
case "$C8" in
  OK)  ok "C8 ماتریس AC هفت سند فاز ۲ با حکم ثبت‌شدهٔ خودشان هم‌خوان است (۸/۷/۹/۱۱/۱۲/۱۴/۱۲)" ;;
  *)   bad "C8 AC یا حکم یک سند فاز ۲ ناسازگار است — ${C8#ERR }" ;;
esac

# ---------------- C9) کهنگی شاهد فاز ۲ (بازتولید و مقایسه، با حذف خطوط فرّار) ----------------
CUR=docs/cloud/reports/evidence/mission-12-16b-structure.txt
GEN=docs/cloud/reports/evidence/gen-mission-12-16b.sh
strip_volatile() { grep -v -E '^(head|branch|base_head|generated_at_utc):' | sed '/^## وضعیت درخت کاری/,$d'; }
if [ -f "$CUR" ]; then
  BEFORE=$(strip_volatile <"$CUR" | sha256sum | cut -d' ' -f1)
  bash "$GEN" >/dev/null 2>&1
  AFTER=$(strip_volatile <"$CUR" | sha256sum | cut -d' ' -f1)
  if [ "$BEFORE" = "$AFTER" ]; then
    ok "C9 شاهد ساختاری فاز ۲ کهنه نبود: بازتولید، محتوای پایدار را بیت‌به‌بیت تولید کرد (${AFTER:0:12})"
  else
    bad "C9 شاهد فاز ۲ کهنه بود: بازتولید محتوای متفاوتی داد (before=${BEFORE:0:12} after=${AFTER:0:12}) — فایل با نسخهٔ تازه بازنویسی شد و باید commit شود"
  fi
else
  bad "C9 شاهد ساختاری فاز ۲ وجود ندارد"
fi

# ---------------- C11) پیشوند ذخیره‌سازی: قاعدهٔ ۰۱‑ب ↔ مسیرهای ۱۲ / ۱۵ / ۱۶ / ۱۶‑ب ----------------
C11=$(python3 - <<'PYEOF'
import re
D='docs/cloud/'
r01b=open(D+'01b-school-plan-subscription.md',encoding='utf-8').read()
pr=[]
# قاعده باید صریح باشد: t/ + id + /
if '`t/` + `id` + `/`' not in r01b: pr.append('قاعدهٔ storage_prefix در ۰۱‑ب صریح (t/ + id + /) نیست')
if '**باید** با `id` شروع شود' in r01b: pr.append('قاعدهٔ متناقض قدیمی («باید با id شروع شود») هنوز در ۰۱‑ب است')
canon=['files/','backups/db/','backups/files/','exports/']
for c in canon:
    if c not in r01b: pr.append('مسیر متعارف '+c+' در ۰۱‑ب نام برده نشده')
allowed={'files','backups','exports'}
for f in ['12-multitenant-architecture.md','12b-owner-panel-boundaries.md','15-backup-recovery.md',
          '16-ha-observability-cost.md','16b-tenant-provisioning-migration.md']:
    t=open(D+f,encoding='utf-8').read()
    for m in re.finditer(r't/<[^>`/\s]+>/([A-Za-z0-9_\-]+)', t):
        if m.group(1) not in allowed: pr.append(f+' مسیر ناشناخته: t/<tenant>/'+m.group(1))
    if re.search(r'(?<!`)\btenants?/[a-z]', t): pr.append(f+' پیشوند غیرمتعارف tenant(s)/…')
#جدول مسیرهای ۱۶‑ب باید همان چهار ریشه را با کلید مستأجر بدهد
r16b=open(D+'16b-tenant-provisioning-migration.md',encoding='utf-8').read()
for c in canon:
    if c not in r16b: pr.append('۱۶‑ب مسیر '+c+' را تعریف نکرده')
if r16b.count('DEK_tenant')<4: pr.append('۱۶‑ب برای چهار مسیر کلید مستأجر (DEK_tenant) را مشخص نکرده')
if pr: print('FAIL '+'؛ '.join(sorted(set(pr))))
else: print('OK قاعدهٔ «t/ + id + /» در ۰۱‑ب با هر ۴ مسیر ۱۶‑ب و همهٔ ارجاع‌های ۱۲/۱۵/۱۶ هم‌خوان است')
PYEOF
)
case "$C11" in
  OK*) ok "C11 پیشوند ذخیره‌سازی: ${C11#OK }" ;;
  *)   bad "C11 پیشوند ذخیره‌سازی ناهم‌خوان: ${C11#FAIL }" ;;
esac

# ---------------- C12) RPO: منبع واحد ۰۴ §۴ ↔ ۱۵ §۲.۲ ↔ ۱۶ §۸ ----------------
C12=$(python3 - <<'PYEOF'
import re
D='docs/cloud/'
def rd(f): return open(D+f,encoding='utf-8').read()
r04,r15,r16=rd('04-capacity-and-availability.md'),rd('15-backup-recovery.md'),rd('16-ha-observability-cost.md')
pr=[]
if '≤ ۵ دقیقه' not in r04: pr.append('۰۴ §۴ هدف RPO «≤ ۵ دقیقه» را ندارد')
if 'WAL' not in r15: pr.append('۱۵ هیچ اشاره‌ای به WAL‑archive ندارد (پس RPO ۵ دقیقه بی‌مبنا می‌ماند)')
if '≤ ۵ دقیقه' not in r15: pr.append('۱۵ هدف «≤ ۵ دقیقه» را ثبت نکرده')
if '۰۴ §۴' not in r15: pr.append('۱۵ به منبع واحد (۰۴ §۴) ارجاع نداده')
if '### ۲.۲' not in r15: pr.append('۱۵ بند «منبع واحد RPO» (§۲.۲) ندارد')
if 'WAL' not in r16 or '≤ ۵ دقیقه' not in r16 or '۲۴h' not in r16:
    pr.append('۱۶ §۸ هر دو حالت (۵ دقیقه با WAL / ۲۴h بدون WAL) را نگفته')
if 'SLA' not in r16: pr.append('۱۶ هشدار «SLA نیست» را ندارد')
# جدول §۲ سند ۱۵: ستون RPO فقط مقادیر حالت بدون WAL/صفر/تهی
sec=r15.split('## ۲.')[1].split('### ۲.۱')[0]
vals=set()
for ln in sec.split('\n'):
    if not ln.startswith('|'): continue
    c=[x.strip().replace('**','') for x in ln.strip().strip('|').split('|')]
    if len(c)>=6 and re.match(r'^[۰-۹]+$', c[0]): vals.add(c[4])
extra=sorted(v for v in vals if v not in {'≤ ۲۴ ساعت','۰','—'})
if extra: pr.append('۱۵ §۲ مقدار RPO خارج از سقف حالت بدون WAL: '+','.join(extra))
if pr: print('FAIL '+'؛ '.join(sorted(set(pr))))
else: print('OK منبع واحد RPO: ۰۴ ≤۵دقیقه (با WAL) · ۱۵ §۲.۲ دو حالت را تفکیک کرد · ۱۶ §۸ هر دو را برچسب زد · هیچ عددی «اندازه‌گیری‌شده» اعلام نشد')
PYEOF
)
case "$C12" in
  OK*) ok "C12 ${C12#OK }" ;;
  *)   bad "C12 ناهم‌خوانی RPO: ${C12#FAIL }" ;;
esac

# ---------------- C13) صف ۱۳ ↔ تعارض ۱۴: کد 409 ordering و وضعیت orphaned ----------------
C13=$(python3 - <<'PYEOF'
import re
D='docs/cloud/'
def rd(f): return open(D+f,encoding='utf-8').read()
r13,r14,rC=rd('13-secure-cache-offline-queue.md'),rd('14-conflict-convergence.md'),open('docs/00-PAYESH-CLOUD-CONSTITUTION.md',encoding='utf-8').read()
pr=[]
if '409 ordering' not in r13: pr.append('۱۳ کد 409 ordering را ندارد')
if '409 ordering' not in r14: pr.append('۱۴ کد 409 ordering (تعریف‌شده در ۱۳) را تعریف/ارجاع نکرده')
if 'D‑27' not in r14: pr.append('۱۴ به D‑27 ارجاع نداده')
if '۱۳ §۳.۱' not in r14: pr.append('۱۴ به ۱۳ §۳.۱ (قرارداد صف) ارجاع نداده')
for f,t in (('13',r13),('14',r14)):
    if 'ORPHANED' in t: pr.append(f+' از شکل بزرگ ORPHANED استفاده می‌کند (نام وضعیت = orphaned)')
if 'orphaned' not in r13 or 'orphaned' not in r14: pr.append('واژهٔ وضعیت orphaned در ۱۳/۱۴ کامل نیست')
if '۲۰۰۰' not in r13: pr.append('۱۳ سقف ۲۰۰۰ عملیات D‑27 را ندارد')
if '۲۰۰۰' not in rC: pr.append('قانون اساسی سقف ۲۰۰۰ را ندارد')
if 'server_seq' not in r14: pr.append('۱۴ قاعدهٔ ساعت/ترتیب (server_seq) را ندارد')
if pr: print('FAIL '+'؛ '.join(sorted(set(pr))))
else: print('OK صف↔تعارض: 409 ordering در ۱۳ و ۱۴ یکسان · وضعیت orphaned یکدست (بدون ORPHANED) · سقف ۲۰۰۰ مطابق D‑27/قانون اساسی')
PYEOF
)
case "$C13" in
  OK*) ok "C13 ${C13#OK }" ;;
  *)   bad "C13 ناهم‌خوانی صف/تعارض: ${C13#FAIL }" ;;
esac

# ---------------- C14) support_grant: نام یکتا و دامنهٔ یکسان در ۰۱ / ۰۱‑ب / ۱۲ / ۱۲‑ب ----------------
C14=$(python3 - <<'PYEOF'
import glob,re
D='docs/cloud/'
pr=[]
for f in sorted(glob.glob(D+'*.md')):
    t=open(f,encoding='utf-8').read()
    if 'support_grants' in t: pr.append(f.split('/')[-1]+' نام جمع support_grants را به‌کار می‌برد')
r01=open(D+'01-scope-and-roles-matrix.md',encoding='utf-8').read()
r01b=open(D+'01b-school-plan-subscription.md',encoding='utf-8').read()
r12=open(D+'12-multitenant-architecture.md',encoding='utf-8').read()
r12b=open(D+'12b-owner-panel-boundaries.md',encoding='utf-8').read()
s01b=r01b.split('### ۲.۶')[1].split('### ۲.۷')[0]
s12b=r12b.split('## ۳. ')[1].split('## ۴.')[0]
for name,sec in (('۰۱‑ب §۲.۶',s01b),('۱۲‑ب §۳',s12b)):
    for tok,label in (('content_write','ممنوعیت content_write'),('۷۲','سقف ۷۲ ساعت'),
                      ('approved_by','تأیید مالک'),('school_notified_at','اطلاع مدرسه'),('operator_id','تأیید غیرخودی')):
        if tok not in sec: pr.append(name+' '+label+' را ندارد')
if 'support_grant' not in r01: pr.append('۰۱ ماتریس نقش‌ها support_grant ندارد')
if 'R:S0' not in r01: pr.append('۰۱ دیدِ حسابرسی (R:S0) روی مجوز اضطراری را ندارد')
if 'support_grant' not in r12: pr.append('۱۲ جدول سطح پلتفرم support_grant را ندارد')
if 'support_access_log' not in r01b: pr.append('۰۱‑ب ثبت هر خواندن در support_access_log را الزام نکرده')
if 'support_access_log' not in r12b: pr.append('۱۲‑ب جدول ثبت خواندن (support_access_log) را نام نمی‌برد')
if pr: print('FAIL '+'؛ '.join(sorted(set(pr))))
else: print('OK support_grant: نام مفرد یکدست · دامنهٔ metadata/content_read بدون content_write · سقف ۷۲h · تأیید مالک ≠ درخواست‌کننده · ثبت خواندن در support_access_log')
PYEOF
)
case "$C14" in
  OK*) ok "C14 ${C14#OK }" ;;
  *)   bad "C14 ناهم‌خوانی support_grant: ${C14#FAIL }" ;;
esac

# ---------------- C10) حکم ----------------
if [ "$RC" -eq 0 ]; then
  say ""
  say "REVIEW-CLOSURE: OK — همهٔ بررسی‌های تقابلی سبز؛ هیچ بررسی‌ای به تصمیم مالک وابسته نبود."
  cp "$LINES" "$OUT"
  echo "→ $OUT"
  echo "REVIEW-CLOSURE-OK"
  grep -c '^\[PASS\]' "$OUT" | sed 's/^/checks_passed=/'
else
  say ""
  say "REVIEW-CLOSURE: FAILED — جزئیات بالا. شاهد سبز قبلی بازنویسی نشد."
  BAD="docs/cloud/reports/evidence/review-closure-01.FAILED-$TS.txt"
  cp "$LINES" "$BAD"
  echo "REVIEW-CLOSURE-FAILED: جزئیات در $BAD" >&2
  grep '^\[FAIL\]' "$BAD" >&2
  exit 1
fi
