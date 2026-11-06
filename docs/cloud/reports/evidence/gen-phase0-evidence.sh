#!/usr/bin/env bash
# مولد شاهد ساختاری اسناد فاز ۰ — تکرارپذیر
# اجرا:  bash docs/cloud/reports/evidence/gen-phase0-evidence.sh
# خروجی: mission-03-structure.txt · mission-01b-structure.txt ·
#         mission-04b-structure.txt · mission-04-structure.txt
set -u
cd "$(dirname "$0")/../../../.."   # ریشهٔ مخزن
OUT_DIR=docs/cloud/reports/evidence

emit() {
  local id="$1" doc="$2" extra="$3"
  local out="$OUT_DIR/mission-$id-structure.txt"
  {
    echo "# شاهد ساختاری مأموریت $id — $doc"
    echo "# تولید: bash docs/cloud/reports/evidence/gen-phase0-evidence.sh"
    echo "# تاریخ تولید: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "# HEAD: $(git rev-parse HEAD)"
    echo "# branch: $(git rev-parse --abbrev-ref HEAD)"
    echo "# وضعیت working tree: $(git status --porcelain | wc -l) تغییر"
    echo
    echo "## معیار پذیرش (ذخیره‌شده در سند)"
    sed -n '1,12p' "$doc"
    echo
    echo "## فهرست بخش‌ها"
    grep -n '^#\{2,3\} ' "$doc"
    echo
    echo "## ماتریس پذیرش"
    awk '/ماتریس پذیرش/,0' "$doc" | grep -E '^\| AC-|^\*\*حکم' | head -40
    echo
    echo "## ارجاعات تصمیم"
    grep -o 'D‑[0-9]\{2\}' "$doc" | sort -u | tr '\n' ' '
    echo
    echo "## شمارش"
    echo "خطوط سند: $(wc -l < "$doc")"
    echo "ردیف AC: $(grep -c '^| AC-' "$doc")"
    echo "تصمیم‌های ارجاع‌شده: $(grep -o 'D‑[0-9]\{2\}' "$doc" | sort -u | wc -l)"
    echo
    echo "## شاهد اضافی"
    eval "$extra"
    echo
    echo "## تغییر کد محصول در این مأموریت"
    git status --porcelain -- server client tests installer scripts || true
    echo "(خالی = هیچ تغییر کد محصول)"
  } > "$out"
  echo "→ $out"
}

emit "03" "docs/cloud/03-local-data-and-manager-backup.md" '
echo "W1/W2/W3: $(grep -c "W1\|W2\|W3" docs/cloud/03-local-data-and-manager-backup.md) اشاره"
echo "«هرکدام زودتر»: $(grep -c "هرکدام زودتر" docs/cloud/03-local-data-and-manager-backup.md)"
echo "UNKNOWN/ORPHANED: $(grep -c "UNKNOWN\|ORPHANED" docs/cloud/03-local-data-and-manager-backup.md)"
echo "KEEP_DAYS در کد (مقایسه): $(grep -n "KEEP_DAYS" server/mirror.js)"
echo "سقف صف فعلی کلاینت: $(grep -n "slice(-500)" client/app.js | head -1)"'

emit "01b" "docs/cloud/01b-school-plan-subscription.md" '
echo "گذارها: $(grep -c "^| \`" docs/cloud/01b-school-plan-subscription.md) ردیف جدول"
echo "QUOTA_SCHEMA: $(grep -c "quota_" docs/cloud/01b-school-plan-subscription.md) پیام"
echo "tenant_id در سرور فعلی: $(grep -rc "tenant_id" server/*.js | awk -F: "{s+=\$2} END {print s+0}") مورد"'

emit "04b" "docs/cloud/04b-plan-caps-usage-model.md" '
echo "پلن‌ها: $(grep -c "^\| \`basic\|^\| \`standard\|^\| \`pro\|^\| \`custom" docs/cloud/04b-plan-caps-usage-model.md)"
echo "نقاط اعمال: $(grep -c "POST /api" docs/cloud/04b-plan-caps-usage-model.md) ارجاع API"'

emit "04" "docs/cloud/04-capacity-and-availability.md" '
echo "اهداف سنجش: $(grep -c "^| \*\*C-" docs/cloud/04-capacity-and-availability.md)"
echo "INTERVAL_MS در کد: $(grep -n "INTERVAL_MS" server/live.js | head -2 | tr "\n" " ")"
echo "RPS_poll در سند: $(grep -c "RPS_poll" docs/cloud/04-capacity-and-availability.md)"
echo "UNKNOWN در سند: $(grep -c "UNKNOWN" docs/cloud/04-capacity-and-availability.md)"'
