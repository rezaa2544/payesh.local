#!/usr/bin/env bash
# نصب «سرویس دادهٔ مدرسه» پایش روی لینوکس (دبیان/اوبونتو/فدورا/آرچ)
# ردیف ۱۲۷: سرور مدرسه فقط API همگام‌سازی (Sync v1) را برای اپ بومی پایش ارائه می‌دهد
# (PAYESH_HEADLESS=1) — هیچ صفحهٔ وب/مرورگری نصب یا سرو نمی‌شود (D‑49). رابط کاربری
# فقط اپ بومی است: اپ پایش ← «سرور مدرسه در همین شبکه» ← نشانی این سیستم.
set -euo pipefail
DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TARGET=/opt/payesh
PORT="${PORT:-8080}"
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"

echo "▶ بررسی Node.js"
if ! command -v node >/dev/null 2>&1; then
  echo "  Node.js نصب نیست. نصب می‌شود…"
  if command -v apt-get >/dev/null; then $SUDO apt-get update -y && $SUDO apt-get install -y nodejs npm
  elif command -v dnf >/dev/null; then $SUDO dnf install -y nodejs
  elif command -v pacman >/dev/null; then $SUDO pacman -Sy --noconfirm nodejs npm
  else echo "  لطفاً Node.js 22+ را دستی نصب کنید."; exit 1; fi
fi
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)" || \
  echo "  هشدار: نسخهٔ Node.js قدیمی است (پیشنهاد: 22+)."

echo "▶ کپی برنامه به $TARGET"
$SUDO mkdir -p "$TARGET"
# فقط سرور + کتابخانهٔ S3 سرور (client/lib) — رابط وب (client/index.html، app.js، …) کپی نمی‌شود
$SUDO mkdir -p "$TARGET/client" "$TARGET/releases"
$SUDO cp -r "$DIR/server" "$DIR/package.json" "$TARGET/"
$SUDO cp -r "$DIR/client/lib" "$TARGET/client/"
[ -f "$DIR/releases/manifest.json" ] && $SUDO cp "$DIR/releases/manifest.json" "$TARGET/releases/"
# نصب قبلی (نسخهٔ وب) — رابط وب پاک می‌شود، دادهٔ مدرسه (data/) دست نمی‌خورد
$SUDO find "$TARGET/client" -mindepth 1 -maxdepth 1 ! -name lib -exec rm -rf {} +
$SUDO mkdir -p "$TARGET/data"

echo "▶ ساخت سرویس systemd"
NODE_BIN="$(command -v node)"
$SUDO tee /etc/systemd/system/payesh.service >/dev/null <<UNIT
[Unit]
Description=Payesh data service - school Sync v1 server for the native app (API only)
After=network.target

[Service]
Type=simple
WorkingDirectory=$TARGET
Environment=PORT=$PORT
Environment=HOST=0.0.0.0
Environment=PAYESH_HEADLESS=1
Environment=PAYESH_UPDATE_AUTO=0
ExecStart=$NODE_BIN --experimental-sqlite --disable-warning=ExperimentalWarning server/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

$SUDO systemctl daemon-reload
$SUDO systemctl enable --now payesh.service
sleep 2
$SUDO systemctl --no-pager --lines=0 status payesh.service || true

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo
echo "✅ سرویس دادهٔ مدرسه نصب شد (فقط API، بدون صفحهٔ وب)."
echo "   اپ پایش را باز کنید ← «سرور مدرسه در همین شبکه» ← نشانی:"
echo "   روی همین سیستم : 127.0.0.1:$PORT   (راه‌اندازی اولیه فقط از همین سیستم)"
echo "   در شبکهٔ مدرسه : ${IP:-<ip>}:$PORT"
echo "   لاگ‌ها         : journalctl -u payesh -f"
