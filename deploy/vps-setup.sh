#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════
#  نصب «پایش» روی سرور اوبونتو (۲۲/۲۴) — یک دستور، همه‌چیز
#  استفاده:
#     sudo bash deploy/vps-setup.sh                      # فقط پورت ۸۰۸۰
#     sudo DOMAIN=payesh.example.ir bash deploy/vps-setup.sh   # با دامنه + SSL
# ═══════════════════════════════════════════════════════════════════
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/payesh}"
APP_USER="${APP_USER:-payesh}"
DOMAIN="${DOMAIN:-}"
PORT="${PORT:-8080}"

say() { printf '\n\033[36m▶ %s\033[0m\n' "$1"; }
ok()  { printf '  \033[32m✓ %s\033[0m\n' "$1"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$1"; exit 1; }

[ "$(id -u)" -eq 0 ] || die "این اسکریپت را با sudo اجرا کنید."
[ -f "$APP_DIR/server/index.js" ] || die "کد پایش در $APP_DIR پیدا نشد (APP_DIR را درست بدهید)."

say "نصب پیش‌نیازها"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates sqlite3 >/dev/null
ok "بسته‌های پایه"

say "بررسی Node.js (نیاز: ۲۲.۵ یا بالاتر)"
need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]')"
  minor="$(node -p 'process.versions.node.split(".")[1]')"
  if [ "$major" -gt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -ge 5 ]; }; then need_node=0; fi
fi
if [ "$need_node" -eq 1 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
node -v | sed 's/^/  Node /'
ok "Node آماده است"

say "ساخت کاربر سرویس و پوشهٔ داده"
id -u "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_DIR/data" "$APP_DIR/data/backups"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chmod 750 "$APP_DIR/data"
ok "کاربر $APP_USER و پوشهٔ $APP_DIR/data"

say "ساخت سرویس systemd"
cat >/etc/systemd/system/payesh.service <<UNIT
[Unit]
Description=Payesh — سامانهٔ مدرسه
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
Environment=NODE_ENV=production
Environment=PORT=$PORT
Environment=PAYESH_DATA=$APP_DIR/data
Environment=PAYESH_TUNNEL_AUTO=0
ExecStart=$(command -v node) --experimental-sqlite --disable-warning=ExperimentalWarning server/index.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ReadWritePaths=$APP_DIR/data

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now payesh >/dev/null
sleep 2
systemctl is-active --quiet payesh || { journalctl -u payesh -n 30 --no-pager; die "سرویس بالا نیامد (لاگ بالا)."; }
ok "سرویس payesh فعال و روشن است"

say "بررسی سلامت"
if node "$APP_DIR/deploy/selfcheck.mjs" "http://127.0.0.1:$PORT"; then ok "سامانه پاسخ می‌دهد"; else die "پاسخ سلامت نداد"; fi

if [ -n "$DOMAIN" ]; then
  say "نصب Nginx و SSL برای $DOMAIN"
  apt-get install -y -qq nginx >/dev/null
  cat >/etc/nginx/sites-available/payesh <<NGINX
server {
  listen 80;
  server_name $DOMAIN;
  client_max_body_size 25m;
  location / {
    proxy_pass http://127.0.0.1:$PORT;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_read_timeout 300s;
  }
}
NGINX
  ln -sf /etc/nginx/sites-available/payesh /etc/nginx/sites-enabled/payesh
  nginx -t >/dev/null && systemctl reload nginx
  apt-get install -y -qq certbot python3-certbot-nginx >/dev/null
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "admin@$DOMAIN" --redirect || \
    echo "  ⚠️ SSL خودکار انجام نشد؛ دستی: certbot --nginx -d $DOMAIN"
  # آدرس عمومی را ثابت کن
  sed -i "s#^Environment=PAYESH_TUNNEL_AUTO=0#Environment=PAYESH_TUNNEL_AUTO=0\nEnvironment=PAYESH_PUBLIC_URL=https://$DOMAIN#" /etc/systemd/system/payesh.service
  systemctl daemon-reload && systemctl restart payesh
  ok "https://$DOMAIN آماده است"
fi

say "بکاپ روزانه"
cat >/etc/cron.d/payesh-backup <<CRON
# هر شب ساعت ۲:۳۰ بکاپ پایگاه داده
30 2 * * * $APP_USER bash $APP_DIR/deploy/backup.sh >> $APP_DIR/data/backups/cron.log 2>&1
CRON
chmod 644 /etc/cron.d/payesh-backup
ok "cron نصب شد"

printf '\n\033[32m✅ تمام.\033[0m\n'
[ -n "$DOMAIN" ] && echo "  آدرس ثابت: https://$DOMAIN" || echo "  آدرس: http://$(hostname -I | awk '{print $1}'):$PORT"
echo "  لاگ زنده: journalctl -u payesh -f"
echo "  بکاپ:    sudo bash $APP_DIR/deploy/backup.sh"
