Express Web 首个整理发布版本，基于 Halo0sama/ExpressAssistant 改造，采用 MIT 许可证。

### 主要功能

- 京东、淘宝、拼多多账号同步与物流轨迹，手工运单接入快递100。
- 在途包裹按物流更新时间倒序，支持取件码、丰巢柜号及手动补填。
- Telegram待取件自动通知、持久去重、信息补全提醒和失败重试。
- 模板日报、定时推送、本地API与MCP。
- 已删除小米、AI对话助手和AI日报配置。

### 下载与部署

- `express-web-0.1.0-source.tar.gz`：源码及测试，需要 Node.js 24+，执行 `npm ci` 和 `npm run build`。
- `express-web-0.1.0-runtime.tar.gz`：预构建前后端，执行 `npm ci --omit=dev` 后按文档初始化即可。
- `SHA256SUMS`：下载校验。

运行包不包含Node.js、Chromium、node_modules、账号、Cookie、数据库或密钥。生产部署请配置HTTPS与PUBLIC_ORIGIN。快递100需要自己的服务账号；平台登录态和新订单获取仍受平台会话及安全验证限制。

安装说明见仓库README与docs/DEPLOYMENT.md。

### 验证

- 类型检查、208项自动测试及生产构建通过。
- 运行包已在隔离目录安装生产依赖，验证密钥/管理员初始化、数据库迁移、服务启动、静态资源、登录与手工添加。
- 归档内容与敏感文件排除已检查。
