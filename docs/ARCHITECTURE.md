# 架构

- `packages/shared`：TypeScript数据类型、状态分区、进度、取件信息解析、物流排序与日历规则。
- `packages/server`：Fastify HTTP/WebSocket服务、SQLite/Drizzle仓储、Playwright采集、快递100、Telegram和调度器。
- `packages/web`：React/Vite移动优先页面、PWA、TanStack Query缓存和SSE更新。
- `deploy`：环境模板、systemd服务、Nginx代理模板。
- `scripts`：健康检查、数据库备份/恢复、版本打包。

平台列表抓取与物流轨迹分开。列表按来源合并，并保留用户备注、追踪开关、取件信息及手工条目。详情按source选择平台账号或独立物流接口，统一将轨迹按旧到新保存。

浏览器按需启动。拼多多保存完整浏览器状态，按账号串行使用；安全验证由用户完成，不自动解验证码。其他平台使用各自账号凭据，不跨平台复用账号。

调度器执行待取件通知、平台同步、独立物流轮询、模板日报、清理与备份。任务异常相互隔离，防止重叠执行。通知去重和失败记录保存在SQLite中。

前端在途列表按最新物流时间统一排序后分页。SSE按批刷新受影响的查询缓存，避免每个增量事件都发起重复请求。
