#!/usr/bin/env bash
# نصب پایش-لوکال روی لینوکس (دبیان/اوبونتو/فدورا/آرچ)
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
$SUDO cp -r "$DIR/server" "$DIR/client" "$DIR/releases" "$DIR/package.json" "$TARGET/"
$SUDO mkdir -p "$TARGET/data"

echo "▶ ساخت سرویس systemd"
NODE_BIN="$(command -v node)"
$SUDO tee /etc/systemd/system/payesh.service >/dev/null <<UNIT
[Unit]
Description=Payesh Local - school system
After=network.target

[Service]
Type=simple
WorkingDirectory=$TARGET
Environment=PORT=$PORT
Environment=HOST=0.0.0.0
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
echo "✅ نصب شد."
echo "   همین سیستم : http://localhost:$PORT"
echo "   شبکهٔ مدرسه: http://${IP:-<ip>}:$PORT"
echo "   لاگ‌ها     : journalctl -u payesh -f"
