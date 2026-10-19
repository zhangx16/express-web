import type { DetailPoint, JdGoods } from '@ea/shared';
import { mtopCallWithRetry, parseMtopJson } from './mtop.js';

/** 菜鸟全链路查询（商品溯源 + 轨迹共用一次请求） */
export const CAINIAO_TRACE_API = 'mtop.taobao.logisticstracedetailservice.queryalltrace';
export const CAINIAO_TRACE_VERSION = '1.0';
export const CAINIAO_TRACE_HOST = 'acs.m.taobao.com';

const CAINIAO_HEADERS = {
  origin: 'https://page.cainiao.com',
  referer: 'https://page.cainiao.com/',
} as const;

const QUERY_DATA_BASE = {
  appName: 'GUOGUO',
  actor: 'RECEIVER',
  isAccoutOut: true,
  isShowConsignDetail: true,
  ignoreInvalidNode: true,
  isUnique: true,
  isStandard: true,
  isShowItem: true,
  isShowTemporalityService: true,
  isShowCommonService: true,
  isStandardActionCode: true,
  isOrderByAction: true,
  isShowExpressMan: true,
  isShowProgressbar: true,
  isShowLastOneService: true,
  isShowServiceProvider: true,
  isShowDeliveryProgress: true,
} as const;

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

function asNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : -1;
  }
  return -1;
}

/**
 * 查询 `data.result[0]`（商品与轨迹共用一次请求）。
 * 与 Android `queryResultWith` 一致：失败一律返回 null，不抛异常。
 */
export async function queryCainiaoResult(
  cookie: string,
  mailNo: string,
): Promise<Record<string, unknown> | null> {
  if (!cookie || !mailNo) return null;
  try {
    const res = await mtopCallWithRetry({
      cookie,
      api: CAINIAO_TRACE_API,
      version: CAINIAO_TRACE_VERSION,
      data: { mailNo, ...QUERY_DATA_BASE },
      host: CAINIAO_TRACE_HOST,
      responseType: 'originaljson',
      ...CAINIAO_HEADERS,
    });
    const root = parseMtopJson(res.body);
    const data = asObject(root?.data);
    const result = data?.result;
    if (!Array.isArray(result) || result.length === 0) return null;
    return asObject(result[0]);
  } catch {
    return null;
  }
}

/** 与 Android `parseGoodsFromResult` 一致 */
export function parseCainiaoGoods(result: Record<string, unknown>): JdGoods | null {
  const items = result.packageItems;
  if (!Array.isArray(items) || items.length === 0) return null;
  const first = asObject(items[0]);
  if (!first) return null;
  const name = asString(first.goodsName);
  const pic = asString(first.itemPic) || asString(first.allPicUrl);
  const qty = asNumber(first.goodsQuantity);
  if (!name && !pic) return null;
  return { name, imageUrl: pic, count: qty > 0 ? `x${qty}` : '', shortName: '' };
}

/** 商品溯源（失败返回 null） */
export async function resolveCainiaoGoods(cookie: string, mailNo: string): Promise<JdGoods | null> {
  const result = await queryCainiaoResult(cookie, mailNo);
  return result ? parseCainiaoGoods(result) : null;
}

/** 与 Android `fetchTracesWith` 一致：fullTraceDetail 逆序（旧 → 新） */
export function parseCainiaoTraces(result: Record<string, unknown>): DetailPoint[] | null {
  const traces = result.fullTraceDetail;
  if (!Array.isArray(traces)) return null;
  const points: DetailPoint[] = [];
  for (let i = traces.length - 1; i >= 0; i -= 1) {
    const t = asObject(traces[i]);
    if (!t) continue;
    const time = asString(t.time);
    points.push({ context: asString(t.desc), time, formattedTime: time });
  }
  return points;
}

/** 轨迹（失败返回 null） */
export async function fetchCainiaoTraces(
  cookie: string,
  mailNo: string,
): Promise<DetailPoint[] | null> {
  const result = await queryCainiaoResult(cookie, mailNo);
  return result ? parseCainiaoTraces(result) : null;
}
