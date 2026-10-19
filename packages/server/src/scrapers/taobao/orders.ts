import { createEmptyItem, extractEta, type ExpressItem, type JdGoods } from '@ea/shared';
import { upsertGoods } from '../../db/repositories/goods.js';
import {
  enabledAccounts,
  setAccountStatus,
  type AccountRecord,
  type CookieAccountPayload,
} from '../../services/accounts/repo.js';
import { logger } from '../../lib/logger.js';
import { accountStatusFor, AuthExpiredError, safeMessage, TimeoutError } from '../browser/errors.js';
import { mtopCallWithRetry, parseMtopJson } from './mtop.js';
import { fetchSsrDetail, type TbParcel } from './ssr.js';

export const TB_LIST_API = 'mtop.taobao.order.queryboughtlistv2';
export const TB_LIST_VERSION = '1.0';
const TB_MAX_PAGES = 3;
const TB_PAGE_SIZE_HINT = 10;
const TB_DETAIL_CONCURRENCY = 4;

export interface TbOrder {
  orderId: string;
  tradeStatus: string;
  statusText: string;
  goodsName: string;
  goodsPic: string;
}

export interface TbFetchResult {
  items: ExpressItem[] | null;
  error: string | null;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

/** 淘宝订单列表（与 Android `fetchBoughtListWith` 一致） */
export async function fetchBoughtList(cookie: string, page: number): Promise<TbOrder[]> {
  if (!cookie) return [];
  const data = {
    tabCode: 'all',
    page,
    OrderType: 'OrderList',
    templateConfigVersion: '0',
    appName: 'tborder',
    appVersion: '3.0',
    condition: '{"version":"1.0.0","appChannel":""}',
    ttid: '201200@taobao_h5_9.18.0',
    requestIdentity: '#t#ip#h5',
  };
  const res = await mtopCallWithRetry({
    cookie,
    api: TB_LIST_API,
    version: TB_LIST_VERSION,
    data,
    host: 'h5api.m.taobao.com',
  });
  assertMtopOk(res.ret, res.body);
  return parseBoughtList(res.body);
}

const AUTH_EXPIRED_RET = [
  'FAIL_SYS_SESSION_EXPIRED',
  'FAIL_SYS_USER_VALIDATE',
  'FAIL_SYS_ILLEGAL_ACCESS',
  'FAIL_SYS_ACCESS_TOKEN_EMPTY',
];

function assertMtopOk(ret: readonly string[], body: string): void {
  if (ret.length === 0) {
    // 响应不是 JSONP（例如登录跳转 HTML）：视为登录态失效
    if (body.trimStart().startsWith('<')) {
      throw new AuthExpiredError('淘宝登录态已失效，请重新登录');
    }
    return;
  }
  if (ret.some((r) => AUTH_EXPIRED_RET.some((m) => r.includes(m)))) {
    throw new AuthExpiredError('淘宝登录态已失效，请重新登录');
  }
}

/** 与 Android `parseBoughtList` 一致：新格式 mainOrders，旧格式 Main_* 兜底 */
export function parseBoughtList(body: string): TbOrder[] {
  const root = parseMtopJson(body);
  const data = asObject(root?.data);
  if (!data) return [];

  let inner: Record<string, unknown> | null = null;
  const resultRaw = data.result;
  if (typeof resultRaw === 'string') {
    try {
      inner = asObject(JSON.parse(resultRaw));
    } catch {
      inner = null;
    }
  }
  inner ??= asObject(data.data);
  if (!inner) return [];

  const orders: TbOrder[] = [];
  const mainOrders = inner.mainOrders;
  if (Array.isArray(mainOrders)) {
    for (const raw of mainOrders) {
      const o = asObject(raw);
      if (!o) continue;
      const id = asString(o.id);
      const tradeStatus = asString(asObject(o.extra)?.tradeStatus);
      const statusText = asString(asObject(o.statusInfo)?.text);
      const subOrders = o.subOrders;
      const firstSub = Array.isArray(subOrders) ? asObject(subOrders[0]) : null;
      const itemInfo = asObject(firstSub?.itemInfo);
      orders.push({
        orderId: id,
        tradeStatus,
        statusText,
        goodsName: asString(itemInfo?.title),
        goodsPic: asString(itemInfo?.pic),
      });
    }
    return orders;
  }

  // 旧格式兜底：data.data.Main_<orderId>.fields
  for (const [key, raw] of Object.entries(inner)) {
    if (!key.startsWith('Main_')) continue;
    const fields = asObject(asObject(raw)?.fields);
    if (!fields) continue;
    const id = asString(fields.orderId) || key.slice('Main_'.length);
    const status = asString(fields.orderStatus);
    if (id) orders.push({ orderId: id, tradeStatus: '', statusText: status, goodsName: '', goodsPic: '' });
  }
  return orders;
}

/** 与 Android `toItem` 一致的状态映射 */
export function tbItemFromParcel(parcel: TbParcel, account: AccountRecord | null): ExpressItem | null {
  if (!parcel.mailNo) return null;
  const label = parcel.stateLabel;
  const state = label.includes('签收') || label.includes('成功')
    ? 3
    : label.includes('派送') || label.includes('派件')
      ? 5
      : label.includes('揽收') ||
          label.includes('运输') ||
          label.includes('转运') ||
          label.includes('分拣') ||
          label.includes('发往') ||
          label.includes('到达') ||
          label.includes('在途') ||
          label.includes('待收货') ||
          (label.includes('发货') && !label.includes('待发货'))
        ? 2
        : label.includes('下单') || label.includes('待发货')
          ? 1
          : 0;
  // 兜底用 104（运输中/55%）而不是 105（派送中/85%）：
  // 未知或运输类状态若落到 105，首页会把还在路上的件显示成「派送中」。
  const stateNum = state === 3 ? 107 : state === 5 ? 105 : state === 2 ? 104 : state === 1 ? 103 : 104;

  return createEmptyItem({
    id: parcel.mailNo,
    mailNo: parcel.mailNo,
    companyCode: '',
    companyName: parcel.cpName || '淘宝快递',
    latestText: parcel.latestText,
    latestTime: parcel.latestTime,
    state,
    stateName: label,
    provider: 'CaiNiao',
    stateNum,
    eta: extractEta(parcel.latestText, parcel.stateLabel),
    queryChannel: parcel.orderId,
    source: 'taobao',
    accountId: account?.id ?? '',
    accountLabel: account?.label ?? '',
  });
}

/**
 * 淘宝渠道抓取（纯 HTTP）：
 * 逐账号 订单列表(≤3 页) → 过滤关闭/未发货订单 → SSR 详情(每批 4 并发) → 商品缓存。
 * 一个账号失败不影响其他账号；全部失败时返回 items=null 触发防清空。
 */
export async function fetchTaobaoOrders(): Promise<TbFetchResult> {
  const accounts = enabledAccounts('taobao');
  if (accounts.length === 0) return { items: null, error: null };

  const allItems: ExpressItem[] = [];
  const allGoods = new Map<string, JdGoods>();
  let error: string | null = null;

  for (const account of accounts) {
    const cookie = (account.payload as CookieAccountPayload).cookie ?? '';
    if (!cookie) {
      setAccountStatus(account.id, 'needs_login', '淘宝未登录，请重新登录');
      error ??= '淘宝账号登录态缺失';
      continue;
    }
    try {
      const { items, goods } = await fetchTaobaoAccount(account, cookie);
      allItems.push(...items);
      for (const [k, v] of goods) allGoods.set(k, v);
      setAccountStatus(account.id, 'ok', null);
    } catch (err) {
      const message = safeMessage(err);
      setAccountStatus(account.id, accountStatusFor(err), message);
      error = message;
      logger.warn({ channel: 'taobao', accountId: account.id }, 'taobao account sync failed');
    }
  }

  if (allGoods.size > 0) {
    try {
      upsertGoods(allGoods);
    } catch (err) {
      logger.warn({ err }, 'taobao goods persist failed');
    }
  }

  if (allItems.length === 0 && error !== null) return { items: null, error };
  return { items: dedupeByMailNo(allItems), error };
}

function dedupeByMailNo(items: ExpressItem[]): ExpressItem[] {
  const map = new Map<string, ExpressItem>();
  for (const item of items) if (!map.has(item.mailNo)) map.set(item.mailNo, item);
  return [...map.values()];
}

async function fetchTaobaoAccount(
  account: AccountRecord,
  cookie: string,
): Promise<{ items: ExpressItem[]; goods: Map<string, JdGoods> }> {
  // 1) 订单列表（最多 3 页，按订单号去重，短页停止）
  const orders = new Map<string, TbOrder>();
  for (let page = 1; page <= TB_MAX_PAGES; page += 1) {
    const batch = await fetchBoughtList(cookie, page);
    for (const order of batch) if (order.orderId && !orders.has(order.orderId)) orders.set(order.orderId, order);
    if (batch.length < TB_PAGE_SIZE_HINT) break;
  }

  // 2) 过滤：交易关闭 / 交易成功（未发货）无物流可抓
  const withParcels = [...orders.values()].filter(
    (o) =>
      !o.tradeStatus.includes('CLOSED') &&
      o.statusText !== '交易关闭' &&
      o.statusText !== '交易成功（未发货）',
  );

  // 3) SSR 详情：每批 4 个并发，批次之间串行（对齐 Android chunked(4)）
  const parcels: TbParcel[] = [];
  for (let i = 0; i < withParcels.length; i += TB_DETAIL_CONCURRENCY) {
    const chunk = withParcels.slice(i, i + TB_DETAIL_CONCURRENCY);
    const settled = await Promise.all(chunk.map((o) => fetchSsrDetail(cookie, o.orderId)));
    for (const p of settled) if (p) parcels.push(p);
  }

  if (withParcels.length > 0 && parcels.length === 0) {
    throw new TimeoutError('淘宝物流详情获取失败，请稍后重试');
  }

  // 4) 商品缓存：订单号 → mailNo 重映射；空名称不写（保留旧值）
  const goodsByOrder = new Map<string, JdGoods>();
  for (const o of withParcels) {
    const pic = o.goodsPic.startsWith('//') ? `https:${o.goodsPic}` : o.goodsPic;
    goodsByOrder.set(o.orderId, { name: o.goodsName, imageUrl: pic, count: '', shortName: '' });
  }
  const goodsByMail = new Map<string, JdGoods>();
  for (const p of parcels) {
    const g = goodsByOrder.get(p.orderId);
    if (g && g.name.trim() !== '') goodsByMail.set(p.mailNo, g);
  }

  const items: ExpressItem[] = [];
  for (const p of parcels) {
    const item = tbItemFromParcel(p, account);
    if (item) items.push(item);
  }
  return { items, goods: goodsByMail };
}
