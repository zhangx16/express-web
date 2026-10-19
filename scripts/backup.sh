#!/usr/bin/env bash
# 手动触发一次 SQLite 在线备份（服务无需停止）。
# 定时备份已由应用调度器每天 03:30 执行，本脚本用于上线前/升级前额外留档。
#
# 用法: sudo -u expressassistant /opt/expressassistant/scripts/backup.sh
set -euo pipefail

DATA_DIR="${DATA_DIR:-/var/lib/expressassistant}"
BACKUP_DIR="$DATA_DIR/backups"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$BACKUP_DIR/manual-$STAMP.db"

install -d -m 700 "$BACKUP_DIR"

# 必须用 SQLite backup API 而不是 cp：WAL 模式下直接复制会得到不一致的快照。
sqlite3 "$DATA_DIR/app.db" ".backup '$OUT'"
gzip -9 "$OUT"
chmod 600 "$OUT.gz"

echo "备份完成: $OUT.gz ($(du -h "$OUT.gz" | cut -f1))"
echo "提示：主密钥 /etc/expressassistant/master.key 需另行离线备份。"
