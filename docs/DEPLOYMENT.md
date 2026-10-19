# 部署与运维

## 生产部署

以下以已安装 Node.js 24+、systemd 的 Debian/Ubuntu 为例，使用 `/opt/expressassistant` 作为代码目录。运行数据与代码分开保存。

```bash
sudo apt-get update
sudo apt-get install -y chromium xvfb nginx sqlite3 rsync
sudo git clone https://github.com/zhangx16/express-web.git /opt/expressassistant
cd /opt/expressassistant
sudo npm ci
sudo npm run build

sudo useradd --system --home /var/lib/expressassistant --shell /usr/sbin/nologin expressassistant
sudo install -d -o expressassistant -g expressassistant -m 700 /var/lib/expressassistant
sudo install -d -o root -g root -m 755 /etc/expressassistant
sudo install -o root -g root -m 600 deploy/env.example /etc/expressassistant/env
```

编辑 `/etc/expressassistant/env`，将 `PUBLIC_ORIGIN` 设为实际 HTTPS 地址，并确认 Chromium 路径。不要把 systemd 注入的 `MASTER_KEY_FILE` 覆写成其他位置。

初始化主密钥和管理员。以下命令明确指定运行目录，避免读取本地试运行的 `.env`：

```bash
sudo env NODE_ENV=production DATA_DIR=/var/lib/expressassistant \
  MASTER_KEY_FILE=/etc/expressassistant/master.key \
  node packages/server/dist/cli/gen-key.js
sudo env NODE_ENV=production DATA_DIR=/var/lib/expressassistant \
  MASTER_KEY_FILE=/etc/expressassistant/master.key \
  node packages/server/dist/cli/create-user.js admin
sudo chown -R expressassistant:expressassistant /var/lib/expressassistant

sudo install -d -o expressassistant -g expressassistant /var/lib/expressassistant/web
sudo rsync -a --chown=expressassistant:expressassistant packages/web/dist/ /var/lib/expressassistant/web/
sudo cp deploy/systemd/expressassistant*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now expressassistant-xvfb expressassistant
```

服务通过 systemd `LoadCredential` 读取主密钥副本。原主密钥保持 root 所有、0600权限；不要重新生成或覆盖已有主密钥。

## HTTPS 代理

`deploy/nginx/express-web.conf` 是通用模板。将域名与证书路径替换为自己的配置后放入 Nginx 的 HTTP 配置目录，执行 `nginx -t` 并重载。先准备好有效证书，模板不负责申请证书。

WebSocket 用于远程登录，SSE 用于同步进度；模板已配置升级头及关闭事件流缓冲。使用 CDN 时也应关闭 API、登录与事件流缓存。仅信任实际反向代理，按需调整 `TRUST_PROXY`。

## 配置

| 变量 | 说明 |
|---|---|
| `HOST` / `PORT` | 默认 `127.0.0.1:3000` |
| `PUBLIC_ORIGIN` | 浏览器访问地址，用于来源与CSRF校验；默认本地地址 |
| `DATA_DIR` | 数据目录，默认 `/var/lib/expressassistant` |
| `MASTER_KEY_FILE` | 主密钥文件；systemd 使用 credential 路径 |
| `CHROMIUM_PATH` | Chromium 可执行文件路径 |
| `BROWSER_HEADLESS` | `0` 有头、`1` 无头、`auto` 按 DISPLAY 决定 |
| `DISPLAY` | 使用模板中的 Xvfb 时为 `:99` |
| `BROWSER_MAX_CONTEXTS` | 并发浏览器上下文，默认2 |
| `SESSION_TTL_DAYS` | 站点登录会话有效天数，默认30 |

平台 Cookie、快递100 Key、Telegram Token 在网页设置中填写，不需要写入环境模板。

## 升级

```bash
cd /opt/expressassistant
sudo -u expressassistant ./scripts/backup.sh
sudo git pull --ff-only
sudo npm ci
sudo npm run build
sudo rsync -a --chown=expressassistant:expressassistant packages/web/dist/ /var/lib/expressassistant/web/
sudo systemctl restart expressassistant
./scripts/healthcheck.sh
```

使用预构建运行包升级时，先备份数据库和主密钥，再将新运行包解压到代码目录，执行 `npm ci --omit=dev`、复制前端产物并重启；不需要执行 `git pull` 或重新编译。

数据库迁移在启动时自动执行。升级时请避开正在进行的登录、同步操作。服务重启后等待健康检查通过，再刷新页面加载新前端。

## 备份与恢复

SQLite 使用 WAL，勿在运行时直接复制单个 `app.db` 文件。使用在线备份：

```bash
sudo -u expressassistant ./scripts/backup.sh
sudo ./scripts/restore.sh /var/lib/expressassistant/backups/manual-YYYYMMDDTHHMMSSZ.db.gz
```

恢复脚本会停止并重新启动服务，请先阅读脚本和确认备份路径。主密钥必须单独安全备份；数据库中的加密凭据依赖同一把主密钥。

## 排障

```bash
./scripts/healthcheck.sh
systemctl status expressassistant expressassistant-xvfb
journalctl -u expressassistant -n 50 --no-pager
```

- `browser: down` 可以表示空闲，浏览器按需启动；同时检查健康接口中的 `ok` 和 `db`。
- 页面静态文件404：检查 `DATA_DIR/web/` 是否包含当前构建，再重启服务并刷新页面。
- 无法显示远程登录：确认 Chromium、Xvfb 和 WebSocket 代理正常。
- 平台登录过期或风控：在设置中完成官方安全验证；不要重复高频重试。
