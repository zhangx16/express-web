#!/usr/bin/env bash
# 本地健康检查：供 cron / 监控 / 部署后验收使用。
# 退出码：0 健康；1 不健康；2 服务不可达。
#
# 用法: /opt/expressassistant/scripts/healthcheck.sh [http://127.0.0.1:3000]
set -euo pipefail

BASE="${1:-http://127.0.0.1:3000}"
BODY="$(curl -fsS --max-time 5 "$BASE/health" 2>/dev/null)" || {
  echo "UNREACHABLE $BASE/health" >&2
  exit 2
}

echo "$BODY"

ok="$(printf '%s' "$BODY" | jq -r '.ok // false')"
db="$(printf '%s' "$BODY" | jq -r '.db // false')"
browser="$(printf '%s' "$BODY" | jq -r '.browser // "unknown"')"

if [[ "$ok" != "true" || "$db" != "true" ]]; then
  echo "UNHEALTHY ok=$ok db=$db" >&2
  exit 1
fi

# 浏览器按需启动，down 属于正常空闲状态
echo "OK (browser=$browser)"
