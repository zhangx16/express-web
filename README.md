# Express Web

自托管快递管理工具，基于 [Halo0sama/ExpressAssistant](https://github.com/Halo0sama/ExpressAssistant) 的业务逻辑改造成 Web 版。支持京东、淘宝、拼多多和手工运单，适合部署在自己的 Linux 服务器上。

## 功能

- 通过服务端浏览器登录平台账号，支持在网页中完成扫码、短信和安全验证。
- 京东、淘宝通过包裹关联账号查询；手工运单接入快递100；有真实运单号和承运公司信息的拼多多包裹可独立查询物流。
- 在途包裹按物流更新时间从近到远排序，提供搜索、渠道筛选、分页、到达日历和隐藏恢复。
- 主页展示取件码，丰巢待取件包裹额外展示柜号或位置，支持手动补填。
- Telegram 自动推送待取件信息，不要求开启追踪；相同信息去重，信息补全后再次提醒，失败后重试。
- 普通模板日报、定时推送、本地 API 与 MCP 接口。
- SQLite 存储，平台凭据和服务密钥加密保存，支持在线备份。

本版已移除小米、AI 对话助手和 AI 日报配置。

## 快速开始

要求 Node.js **24+**、npm，以及 Chromium。以下在已安装 Node.js 24 的 Debian/Ubuntu 环境执行：

```bash
sudo apt-get update
sudo apt-get install -y chromium

git clone https://github.com/zhangx16/express-web.git
cd express-web
npm ci
cp .env.example .env
npm run build

node packages/server/dist/cli/gen-key.js
node packages/server/dist/cli/create-user.js admin
mkdir -p .local/data/web
cp -a packages/web/dist/. .local/data/web/
npm start
```

访问 `http://127.0.0.1:3000`，使用创建的管理员账号登录。密码通过交互输入。若 Chromium 路径不同，修改 `.env` 中的 `CHROMIUM_PATH`。远程访问请按生产部署文档配置域名、HTTPS 和 `PUBLIC_ORIGIN`。

- [生产部署、升级与备份](docs/DEPLOYMENT.md)
- [使用说明与平台限制](docs/USAGE.md)
- [API 与 MCP](docs/API.md)
- [架构](docs/ARCHITECTURE.md)
- [安全说明](SECURITY.md)
- [更新记录](CHANGELOG.md)

## 平台与通知配置

1. 在“设置 → 平台账号”登录京东、淘宝或拼多多，完成验证后确认登录。
2. 手工运单查询：在“设置 → 快递100”配置 Customer 和 Key、启用服务，再选择实际承运公司；部分公司需要查件手机号。
3. Telegram：填写 Bot Token、Chat ID 并开启推送。待取件通知发送柜号或位置、取件码和运单号。接口未提供的信息会标为缺失；补填后会再通知。
4. 自动更新：设置平台同步间隔，或开启包裹追踪。快递100自动轮询仅更新开启追踪的包裹；首页手动同步也会更新尚未完成的手工包裹。

快递100需要自行开通对应服务，费用以其控制台为准；每单查询至少间隔31分钟。平台 Cookie 失效、安全验证、设备互踢由平台控制，本项目不能保证登录态永久有效。独立物流接口可以更新已知运单，不能发现新增购物订单。

## Release 包

[Releases](https://github.com/zhangx16/express-web/releases) 提供源码归档、预构建运行包及 SHA-256 校验文件。

预构建运行包包含服务端和前端构建产物，不含 `node_modules`、浏览器、用户数据或密钥。解压后运行 `npm ci --omit=dev`，再按部署文档初始化环境、主密钥和管理员，并将 `packages/web/dist/` 复制到 `DATA_DIR/web/`。运行包不需要再次编译。

## 自动检查与发布

推送和Pull Request会运行类型检查、测试和构建。通过检查后，主分支推送或手动工作流会为尚未发布的package.json版本生成GitHub Release；已有版本不会覆盖。发布新版本时先更新版本号和更新记录。

## 开发与验证

```bash
npm ci
npm run typecheck
npm test
npm run build
```

当前有208项自动测试。测试使用隔离的数据目录和模拟上游响应，不使用生产登录态，不访问真实快递100付费接口或发送 Telegram 测试消息。

## 许可证与致谢

采用 MIT 许可证。保留原项目作者 Halo0sama 的版权和许可声明，详见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。本仓库是独立的 Web 改造版本，与相关电商、物流平台没有官方关联。
