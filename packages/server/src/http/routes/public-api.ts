import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { stateLabel } from '@ea/shared';
import { getItem, listAllItems, patchItem, updateItemFields } from '../../db/repositories/items.js';
import { getSecret, getSettings, setSetting } from '../../db/repositories/settings.js';
import { getItemTrace } from '../../services/traces/service.js';
import { runSync } from '../../services/sync/orchestrator.js';
import { AppError, NotFoundError } from '../errors.js';

/**
 * 对外 API：兼容 Android `LocalApiServer` 契约，供脚本/MCP 客户端使用。
 * 鉴权：`Authorization: Bearer <local_api_token>`，token 在设置页生成，只存密文。
 * `/api/v1/*` 与 `/mcp` 在全局钩子里属于公开路径，因此必须在这里自行校验。
 * 错误响应沿用原 App 的 `{ok:false,error}` 形状。
 */

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function bearerToken(req: FastifyRequest): string {
  const header = req.headers.authorization ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1]?.trim() ?? '';
}

function requireToken(req: FastifyRequest): void {
  const expected = getSecret('local_api_token');
  if (!expected) {
    throw new AppError(401, 'token_not_configured', '尚未配置本地 API Token');
  }
  const provided = bearerToken(req);
  if (!provided || !timingSafeEqual(digest(provided), digest(expected))) {
    throw new AppError(401, 'unauthorized', 'Token 无效');
  }
}

/** 与 Android `listJson` 字段完全一致 */
function expressList(): unknown[] {
  return listAllItems().map((item) => ({
    mailNo: item.mailNo,
    companyCode: item.companyCode,
    companyName: item.companyName,
    latestText: item.latestText,
    latestTime: item.latestTime,
    state: item.state,
    stateName: item.stateName || stateLabel(item),
    eta: item.eta,
    tracked: item.tracked,
    provider: item.provider,
    phone: item.phone ?? '',
  }));
}

async function detailPayload(mailNo: string): Promise<unknown> {
  const item = getItem(mailNo);
  if (!item) throw new NotFoundError(`mailNo not found: ${mailNo}`);
  const trace = await getItemTrace(item, true);
  return {
    mailNo: trace.mailNo,
    companyName: item.companyName,
    state: item.state,
    isReceived: item.state === 3 || trace.done,
    eta: item.eta,
    points: trace.points.map((p) => ({
      time: p.time,
      formattedTime: p.formattedTime,
      context: p.context,
    })),
  };
}

function trackItem(mailNo: string, tracked: boolean): { ok: boolean; mailNo: string; tracked: boolean } {
  const item = getItem(mailNo);
  if (!item) throw new NotFoundError(`mailNo not found: ${mailNo}`);
  if (tracked) {
    // 与 App 一致：开启时以当前动态为通知基线，避免立刻补发旧消息
    patchItem(mailNo, {
      tracked: true,
      notifiedText: item.latestText,
      notifiedTime: item.latestTime,
    });
    if (getSettings().trackedPollIntervalMin <= 0) setSetting('trackedPollIntervalMin', 15);
  } else {
    patchItem(mailNo, { tracked: false });
  }
  return { ok: true, mailNo, tracked };
}

function renameItem(
  mailNo: string,
  name: string,
): { ok: boolean; error?: string; mailNo?: string; name?: string } {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: 'name is empty' };
  if (!getItem(mailNo)) return { ok: false, error: `mailNo not found: ${mailNo}` };
  updateItemFields(mailNo, { companyName: trimmed });
  return { ok: true, mailNo, name: trimmed };
}

/** 同步：App 里是阻塞等待，这里同样等结束后返回，便于调用方拿到最新列表 */
async function syncAndWait(): Promise<string> {
  const result = await runSync({ trigger: 'manual' });
  if (result === null) return '同步正在进行中，请稍候';
  return `已同步 ${result.total} 件快递`;
}

// ── MCP ──

const MCP_TOOLS = [
  {
    name: 'summarize',
    description:
      '仓管 AI 总结当前所有快递：按问题或默认汇总，返回精炼文字，避免把所有包裹原始数据交给调用方',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '可选的自然语言问题，例如“我的快递都到哪了”' },
        maxChars: { type: 'integer', description: '返回文本最大长度，默认 2000' },
      },
      required: [],
    },
  },
  {
    name: 'list_packages',
    description: '返回全部快递的精简列表（公司、单号、状态、预计送达、是否跟踪），适合调用方需要结构化数据时使用',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'package_detail',
    description: '查询某个快递的完整物流轨迹',
    inputSchema: {
      type: 'object',
      properties: { mailNo: { type: 'string' } },
      required: ['mailNo'],
    },
  },
  {
    name: 'sync',
    description: '触发一次同步，刷新快递列表',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'track',
    description: '开启或关闭某个快递的跟踪通知',
    inputSchema: {
      type: 'object',
      properties: { mailNo: { type: 'string' }, tracked: { type: 'boolean' } },
      required: ['mailNo', 'tracked'],
    },
  },
  {
    name: 'rename',
    description: '修改某个快递的显示名称',
    inputSchema: {
      type: 'object',
      properties: { mailNo: { type: 'string' }, name: { type: 'string' } },
      required: ['mailNo', 'name'],
    },
  },
];

function compactList(): string {
  const items = listAllItems();
  if (items.length === 0) return '暂无快递';
  return items
    .map((item) => {
      let line = `${item.companyName} ${item.mailNo}｜${stateLabel(item)}`;
      if (item.eta.trim() !== '') line += `｜预计 ${item.eta}`;
      if (item.tracked) line += `｜跟踪中`;
      return line;
    })
    .join('\n');
}

function summarizeFallback(items: ReturnType<typeof listAllItems>): string {
  const moving = items.filter((it) => it.state !== 3).length;
  const delivering = items.filter((it) => it.state === 5 || it.stateName.includes('派送')).length;
  const head =
    `当前共 ${items.length} 个快递，在途 ${moving} 个` + (delivering > 0 ? `（派送中 ${delivering}）` : '');
  const lines = items
    .slice(0, 8)
    .map((it) => `- ${it.companyName} ${it.mailNo}：${stateLabel(it)}；${it.latestText}`);
  return `${head}\n${lines.join('\n')}`;
}

async function summarize(_question: string, maxChars: number): Promise<string> {
  return summarizeFallback(listAllItems()).slice(0, Math.max(100, Math.trunc(maxChars)));
}

async function mcpCall(name: string, args: Record<string, unknown>): Promise<string> {
  const mailNo = typeof args.mailNo === 'string' ? args.mailNo : '';
  switch (name) {
    case 'summarize': {
      const question = typeof args.question === 'string' ? args.question : '';
      const maxChars = typeof args.maxChars === 'number' ? args.maxChars : 2000;
      return summarize(question, maxChars);
    }
    case 'list_packages':
      return compactList();
    case 'package_detail':
      return JSON.stringify(await detailPayload(mailNo), null, 2);
    case 'sync':
      return syncAndWait();
    case 'track': {
      const result = trackItem(mailNo, args.tracked === true || args.tracked === 'true');
      return `已${result.tracked ? '开启' : '关闭'}跟踪：${result.mailNo}`;
    }
    case 'rename': {
      const result = renameItem(mailNo, typeof args.name === 'string' ? args.name : '');
      if (!result.ok) throw new Error(result.error ?? 'rename failed');
      return `已改名为：${result.name}`;
    }
    default:
      throw new Error(`tool not found: ${name}`);
  }
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: unknown;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown> };
}

function mcpResult(id: unknown, result: unknown): unknown {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function mcpError(id: unknown, code: number, message: string): unknown {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

async function handleMcp(body: JsonRpcRequest): Promise<unknown> {
  const id = body.id;
  try {
    switch (body.method) {
      case 'tools/list':
        return mcpResult(id, { tools: MCP_TOOLS });
      case 'tools/call': {
        const name = body.params?.name ?? '';
        const args = body.params?.arguments ?? {};
        const text = await mcpCall(name, args);
        return mcpResult(id, { content: [{ type: 'text', text }] });
      }
      default:
        return mcpError(id, -32601, `method not found: ${body.method ?? ''}`);
    }
  } catch (err) {
    return mcpError(id, -32603, err instanceof Error ? err.message : 'internal error');
  }
}

const trackSchema = z.object({ mailNo: z.string().min(1), tracked: z.boolean() });
const renameSchema = z.object({ mailNo: z.string().min(1), name: z.string() });

function unauthorized(reply: FastifyReply): void {
  reply.header('WWW-Authenticate', 'Bearer');
}

export async function publicApiRoutes(app: FastifyInstance): Promise<void> {
  // 该插件是封装上下文：错误形状只影响 /api/v1/* 与 /mcp
  app.setErrorHandler((err: unknown, req, reply) => {
    const statusCode = err instanceof AppError ? err.statusCode : 500;
    const message =
      err instanceof AppError ? err.message : err instanceof Error ? err.message : 'internal error';
    if (statusCode >= 500) req.log.error({ err }, 'public api error');
    return reply.status(statusCode).send({ ok: false, error: message });
  });

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0] ?? req.url;
    if (!path.startsWith('/api/v1/') && path !== '/mcp') return;
    try {
      requireToken(req);
    } catch (err) {
      unauthorized(reply);
      throw err;
    }
  });

  app.get('/api/v1/health', async () => ({ ok: true, app: 'express-assistant' }));

  app.get('/api/v1/express', async () => expressList());

  app.get('/api/v1/express/:mailNo', async (req) => {
    const { mailNo } = req.params as { mailNo: string };
    return detailPayload(mailNo);
  });

  app.post('/api/v1/sync', async () => ({ ok: true, message: await syncAndWait() }));

  app.post('/api/v1/track', async (req) => {
    const parsed = trackSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, 'bad_request', 'mailNo/tracked 参数不正确');
    return trackItem(parsed.data.mailNo, parsed.data.tracked);
  });

  app.post('/api/v1/rename', async (req) => {
    const parsed = renameSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, 'bad_request', 'mailNo/name 参数不正确');
    return renameItem(parsed.data.mailNo, parsed.data.name);
  });

  app.post('/mcp', async (req) => {
    const body = (req.body ?? {}) as JsonRpcRequest;
    return handleMcp(body);
  });
}
