# API

网页接口使用站点会话。写请求需要 `X-CSRF-Token` 和同源 `Origin`；凭据字段只写，读取仅返回配置状态或掩码。

## 网页接口

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/auth/login` | `{username,password}` 登录 |
| POST | `/api/auth/logout` | 登出 |
| GET | `/api/auth/me` | 当前用户 |
| POST | `/api/auth/password` | 修改密码 |
| GET | `/api/items` | 列表：支持q、source、section、tracked筛选 |
| POST | `/api/items` | 添加：mailNo、companyCode、companyName、phone |
| GET | `/api/items/:mailNo` | 详情 |
| PATCH | `/api/items/:mailNo` | 追踪、备注、分区、查件资料、pickupCabinet、pickupCode |
| DELETE | `/api/items/:mailNo` | 隐藏 |
| GET | `/api/items/hidden` | 隐藏列表 |
| POST | `/api/items/:mailNo/restore` | 恢复 |
| GET | `/api/items/:mailNo/trace` | 缓存或上游轨迹 |
| POST | `/api/items/:mailNo/refresh` | 主动刷新，仍受限频约束 |
| POST | `/api/sync` | 启动同步，返回runId |
| GET | `/api/sync/status` | 同步状态 |
| GET | `/api/sync/runs` | 同步历史 |
| GET | `/api/events` | SSE进度与缓存更新事件 |
| GET/PATCH/DELETE | `/api/accounts[/:id]` | 查询、修改或删除账号 |
| POST | `/api/accounts/:id/verify` | 校验账号状态 |
| POST | `/api/login/sessions` | 创建平台登录会话 |
| GET/DELETE | `/api/login/sessions/:sessionId` | 查询或取消登录 |
| WS | `/api/ws/login/:sessionId` | 登录画面与交互 |
| GET/PATCH | `/api/settings` | 查询或修改配置 |
| PUT/DELETE | `/api/settings/kuaidi100/key` | 快递100 Key，写入体为`{value}` |
| PUT/DELETE | `/api/settings/telegram/token` | Bot Token |
| PUT/DELETE | `/api/settings/local-api/token` | 对外API Token |
| GET/POST | `/api/addresses` | 地址列表或创建 |
| PATCH/DELETE | `/api/addresses/:id` | 修改或删除地址 |
| GET | `/api/reports` | 日报列表 |
| POST | `/api/reports/generate` | 生成模板日报 |
| GET/POST | `/api/reports/schedules` | 定时任务 |
| PATCH/DELETE | `/api/reports/schedules/:id` | 修改或删除任务 |

`GET /health` 公开返回服务健康状态。`/api/chat`、聊天历史与`/api/settings/ai/key`已移除。

## 对外API与MCP

在设置中创建本地 API Token，调用时使用 `Authorization: Bearer <token>`，不要将Token放在URL中。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/v1/health` | 健康状态 |
| GET | `/api/v1/express` | 包裹列表 |
| GET | `/api/v1/express/:mailNo` | 包裹详情 |
| POST | `/api/v1/sync` | 同步 |
| POST | `/api/v1/track` | 设置追踪 |
| POST | `/api/v1/rename` | 修改显示名称 |
| POST | `/mcp` | JSON-RPC MCP接口 |

MCP支持 `initialize`、`tools/list`、`tools/call`，工具包含包裹列表、详情、同步、追踪、重命名和本地模板摘要等。具体参数定义以`tools/list`响应为准。
