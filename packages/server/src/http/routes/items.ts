import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createEmptyItem,
  isReceived,
  parseJumpLinks,
  SECTION_ORDER,
  type Channel,
  type DetailBundle,
  type DetailPoint,
  type ExpressDetail,
  type ExpressItem,
  type GoodsDto,
  type ItemPatch,
  type ItemSource,
  type ItemsQuery,
  type ItemsResponse,
  type SectionKey,
} from '@ea/shared';
import {
  getItem,
  hiddenMailNos,
  hideItem,
  insertItem,
  listHidden,
  patchItem,
  queryItems,
  restoreItem,
  updateItemFields,
} from '../../db/repositories/items.js';
import { getGoods } from '../../db/repositories/goods.js';
import { getAccount, getAccountRecord } from '../../services/accounts/repo.js';
import { getItemTrace, traceLatestPoint } from '../../services/traces/service.js';
import { getTrace } from '../../db/repositories/traces.js';
import { resolveJdGoods } from '../../scrapers/jd/goods.js';
import { resolveCainiaoGoods } from '../../scrapers/taobao/cainiao.js';
import { ConflictError, NotFoundError, ValidationError } from '../../http/errors.js';

const SECTIONS = new Set<string>(SECTION_ORDER);
const SOURCES = new Set<string>(['jd', 'taobao', 'pdd', 'manual']);

const listQuerySchema = z.object({
  section: z.string().optional(),
  q: z.string().max(100).optional(),
  source: z.string().optional(),
  tracked: z.enum(['0', '1', 'true', 'false']).optional(),
  accountId: z.string().max(64).optional(),
  includeHidden: z.enum(['0', '1', 'true', 'false']).optional(),
});

const createSchema = z.object({
  mailNo: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]{6,40}$/, '单号格式不正确'),
  companyCode: z.string().trim().max(32).optional(),
  companyName: z.string().trim().max(64).optional(),
  phone: z.string().trim().regex(/^(?:[0-9+-]{4,24})?$/).optional(),
});

const patchSchema = z.object({
  companyCode: z.string().trim().max(32).optional(),
  companyName: z.string().trim().max(64).optional(),
  phone: z.string().trim().regex(/^(?:[0-9+-]{4,24})?$/).optional(),
  tracked: z.boolean().optional(),
  stateOverride: z.string().max(32).optional(),
  partitionOverride: z.string().max(32).optional(),
  addressId: z.string().max(64).optional(),
  originalName: z.string().max(200).optional(),
  pickupCode: z.string().max(32).optional(),
  pickupCabinet: z.string().trim().max(160).optional(),
});

function toGoodsDto(item: ExpressItem): GoodsDto | null {
  const goods = getGoods(item.mailNo);
  if (!goods) return null;
  return {
    mailNo: goods.mailNo,
    name: goods.name,
    imageUrl: goods.imageUrl,
    count: goods.count,
    shortName: goods.shortName,
  };
}

function buildDetail(item: ExpressItem): ExpressDetail {
  const cached = getTrace(item.mailNo, item.source);
  return {
    mailNo: item.mailNo,
    companyName: item.companyName,
    state: item.state,
    stateNum: item.stateNum,
    // stateNum 107 也是签收；只看 state 会把一部分已签收件显示成未签收
    isReceived: isReceived(item),
    data: cached?.points ?? [],
    eta: cached?.eta || item.eta,
  };
}

function bundle(item: ExpressItem): DetailBundle {
  const account = item.accountId ? getAccount(item.accountId) : null;
  return {
    detail: buildDetail(item),
    goods: toGoodsDto(item),
    account: account
      ? {
          id: account.id,
          label: account.label,
          enabled: account.enabled,
          channel: account.channel,
        }
      : null,
  };
}

function requireItem(mailNo: string): ExpressItem {
  const item = getItem(mailNo);
  if (!item) throw new NotFoundError('包裹不存在');
  return item;
}

/** 未签收时用最新轨迹回写条目的最新动态（与 Android DetailActivity 一致） */
function writeBackLatest(item: ExpressItem, points: DetailPoint[]): void {
  const last = traceLatestPoint(points);
  if (!last) return;
  const done = item.state === 3 || item.stateNum === 107;
  if (done) return;
  if (!last.context) return;
  if (last.context === item.latestText && last.time === item.latestTime) return;
  updateItemFields(item.mailNo, { latestText: last.context, latestTime: last.time });
}

export async function itemRoutes(app: FastifyInstance): Promise<void> {
  app.get('/items', async (req): Promise<ItemsResponse> => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError('查询参数不正确');
    const raw = parsed.data;

    const query: ItemsQuery = {};
    if (raw.section) {
      if (!SECTIONS.has(raw.section)) throw new ValidationError('分区不存在');
      query.section = raw.section as SectionKey;
    }
    if (raw.q) query.q = raw.q;
    if (raw.source) {
      if (!SOURCES.has(raw.source)) throw new ValidationError('来源渠道不存在');
      query.source = raw.source as ItemSource;
    }
    if (raw.tracked) query.tracked = raw.tracked === '1' || raw.tracked === 'true';
    if (raw.accountId) query.accountId = raw.accountId;
    if (raw.includeHidden) query.includeHidden = raw.includeHidden === '1' || raw.includeHidden === 'true';

    return queryItems(query);
  });

  /**
   * 手工添加快递（对齐 Android `MainActivity.showAddDialog`）：
   * 公司由用户填写，未填写则标记为「自动识别」。
   * 手工条目带 `manual` 标记，同步时即使渠道列表里没有也不会被清掉。
   */
  app.post('/items', async (req, reply) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('单号格式不正确');
    const { mailNo, companyCode, companyName, phone } = parsed.data;

    if (getItem(mailNo)) throw new ConflictError('item_exists', '该单号已存在');
    if (hiddenMailNos().has(mailNo)) {
      throw new ConflictError('item_hidden', '该单号在已删除列表中，请先恢复');
    }

    const name = companyName || '自动识别';
    const item = insertItem(
      createEmptyItem({
        mailNo,
        companyCode: companyCode || 'auto',
        companyName: name,
        originalName: name,
        state: 0,
        stateNum: 105,
        source: 'manual',
        phone: phone || null,
      }),
    );
    if (!item) throw new ConflictError('item_exists', '该单号已存在');

    reply.status(201);
    return { item };
  });

  app.get('/items/hidden', async () => ({
    items: listHidden().map((h) => ({
      mailNo: h.mailNo,
      hiddenAt: h.hiddenAt,
      item: h.snapshot,
    })),
  }));

  app.post('/items/:mailNo/restore', async (req) => {
    const { mailNo } = req.params as { mailNo: string };
    const item = restoreItem(mailNo);
    if (!item) throw new NotFoundError('隐藏记录不存在');
    return { ok: true, item };
  });

  app.get('/items/:mailNo', async (req): Promise<DetailBundle> => {
    const { mailNo } = req.params as { mailNo: string };
    return bundle(requireItem(mailNo));
  });

  app.patch('/items/:mailNo', async (req) => {
    const { mailNo } = req.params as { mailNo: string };
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('参数格式不正确');
    const patch: ItemPatch = parsed.data;

    if (patch.partitionOverride !== undefined && patch.partitionOverride !== '') {
      if (!SECTIONS.has(patch.partitionOverride)) throw new ValidationError('分区不存在');
    }

    const item = patchItem(mailNo, patch);
    if (!item) throw new NotFoundError('包裹不存在');
    return { item };
  });

  app.delete('/items/:mailNo', async (req) => {
    const { mailNo } = req.params as { mailNo: string };
    if (!hideItem(mailNo)) throw new NotFoundError('包裹不存在');
    return { ok: true };
  });

  app.get('/items/:mailNo/trace', async (req) => {
    const { mailNo } = req.params as { mailNo: string };
    const { refresh } = req.query as { refresh?: string };
    const item = requireItem(mailNo);
    const trace = await getItemTrace(item, refresh === '1' || refresh === 'true');
    if (!trace.cached) writeBackLatest(item, trace.points);
    return trace;
  });

  /** 手动刷新：强制抓取轨迹并回写最新动态，返回完整详情 */
  app.post('/items/:mailNo/refresh', async (req) => {
    const { mailNo } = req.params as { mailNo: string };
    const item = requireItem(mailNo);
    const trace = await getItemTrace(item, true);
    writeBackLatest(item, trace.points);
    return bundle(requireItem(mailNo));
  });

  /** 商品信息回填：京东搜索订单中心 / 淘宝菜鸟 / 拼多多用轨迹页结果 */
  app.post('/items/:mailNo/goods/resolve', async (req) => {
    const { mailNo } = req.params as { mailNo: string };
    const item = requireItem(mailNo);
    const existing = toGoodsDto(item);
    if (existing) return { goods: existing };

    if (item.source === 'jd') {
      const account = item.accountId ? getAccount(item.accountId) : null;
      if (!account) throw new NotFoundError('关联账号不存在');
      const record = getAccountRecord(account.id);
      const payload = record?.payload as { cookie?: string } | undefined;
      if (!payload?.cookie) throw new ValidationError('账号登录态缺失，请重新登录');
      const goods = await resolveJdGoods(item.mailNo, payload.cookie);
      return { goods: goods ? { mailNo: item.mailNo, ...goods } : null };
    }

    if (item.source === 'taobao') {
      const record = item.accountId ? getAccountRecord(item.accountId) : null;
      const payload = record?.payload as { cookie?: string } | undefined;
      if (!payload?.cookie) throw new ValidationError('账号登录态缺失，请重新登录');
      const goods = await resolveCainiaoGoods(payload.cookie, item.mailNo);
      return { goods: goods ? { mailNo: item.mailNo, ...goods } : null };
    }

    return { goods: null };
  });

  /** 跳转链接（供前端渲染「去平台查看」按钮） */
  app.get('/items/:mailNo/links', async (req) => {
    const { mailNo } = req.params as { mailNo: string };
    const item = requireItem(mailNo);
    return { links: parseJumpLinks(item.jumpLinks) };
  });
}
