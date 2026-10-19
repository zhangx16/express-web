#!/usr/bin/env bash
# 从 .db.gz 备份恢复。会停止服务 → 备份当前库 → 覆盖 → 迁移 → 启动。
#
# 用法: sudo /opt/expressassistant/scripts/restore.sh /var/lib/expressassistant/backups/app-XXXX.db.gz
set -euo pipefail

DATA_DIR="${DATA_DIR:-/var/lib/expressassistant}"
DB="$DATA_DIR/app.db"
SERVICE="expressassistant.service"

if [[ $# -ne 1 ]]; then
  echo "用法: $0 <备份文件.db.gz>" >&2
  exit 1
fi
SRC="$1"
[[ -f "$SRC" ]] || { echo "备份不存在: $SRC" >&2; exit 1; }

# 校验 gzip 完整性
gzip -t "$SRC"

echo "==> 停止服务"
systemctl stop "$SERVICE" || true

if [[ -f "$DB" ]]; then
  SAFE="$DATA_DIR/app.db.pre-restore.$(date -u +%Y%m%dT%H%M%SZ)"
  echo "==> 保留当前库: $SAFE"
  mv "$DB" "$SAFE"
fi
rm -f "$DB-wal" "$DB-shm"

echo "==> 解压备份"
gunzip -c "$SRC" > "$DB"
chown expressassistant:expressassistant "$DB"
chmod 600 "$DB"

echo "==> 迁移到最新 schema"
sudo -u expressassistant \
  env MASTER_KEY_FILE=/etc/expressassistant/master.key \
      DATA_DIR="$DATA_DIR" \
      NODE_ENV=production \
  /usr/bin/node /opt/expressassistant/packages/server/dist/db/migrate-cli.js

echo "==> 启动服务"
systemctl start "$SERVICE"
sleep 2
systemctl --no-pager --lines=0 status "$SERVICE" || true
curl -fsS http://127.0.0.1:3000/health && echo

echo "恢复完成。若主密钥与备份不匹配，账号需重新登录（密文无法解密）。"
