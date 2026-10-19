import type { Page } from 'playwright';
import { parseJumpLinks, type DetailPoint, type ExpressItem, type JdGoods } from '@ea/shared';
import { assertPddPageReady, watchPddPage, persistPddSession, withPddSession } from './session.js';
import { accountStatusFor, safeMessage, ParseError, TimeoutError } from '../browser/errors.js';
import { getAccountRecord, setAccountStatus, type AccountRecord } from '../../services/accounts/repo.js';
import { logger } from '../../lib/logger.js';
import { sleep } from '../browser/touch.js';
import {
  asObject,
  firstString,
  firstStringDeep,
  looksRelevant,
  readCaptures,
  timeString,
  type PddCaptureEntry,
} from './capture.js';
import { installPddHook } from './hooks.js';

/** 拼多多 H5 订单详情页（`order_link_url` 实测为 order.html?order_sn=…） */
export const PDD_TRACE_PAGE = 'https://mobile.yangkeduo.com/order.html?order_sn=';

const TRACE_TIMEOUT_MS = 45_000;
const COLLECT_DELAY_MS = 2500;
const ROUND_MS = 2000;
const MAX_ROUNDS = 10;

/* ─────────────── 候选键（与 Android PddTraceFetcher 完全一致） ─────────────── */

const TIME_KEYS = new Set([
  'time',
  'create_time',
  'update_time',
  'logistics_time',
  'tracking_time',
  'subtitle',
  'format_time',
  'formatTime',
  'gmt_create',
]);
const DESC_KEYS = new Set([
  'desc',
  'description',
  'context',
  'status_desc',
  'statusDesc',
  'text',
  'content',
  'track_desc',
  'logistics_desc',
  'logistics_status_desc',
  'sub_desc',
  'title',
]);
const GOODS_NAME_KEYS = new Set([
  'goods_name',
  'goodsName',
  'goods_title',
  'goods_brief',
  'product_name',
  'item_name',
  'sku_name',
  'goods_name_text',
]);
const GOODS_PIC_KEYS = new Set([
  'goods_image_url',
  'goodsImageUrl',
  'image_url',
  'thumbnail',
  'pic',
  'image',
  'goods_img',
  'goods_thumb_url',
]);
const GOODS_NUM_KEYS = new Set(['goods_num', 'goodsCount', 'quantity', 'num', 'count']);

/** 只点击当前订单的精确物流入口，绝不在回退的订单列表中选其他包裹。 */
async function openLogistics(page: Page): Promise<boolean> {
  const entry = page.getByText(/^(查看物流|查物流|物流详情|物流信息)$/, { exact: true }).first();
  if (await entry.count() === 0) return false;
  await entry.click({ timeout: 5000 });
  return true;
}

async function expandLogistics(page: Page): Promise<void> {
  const candidates = page.getByText(/^(展开|展开全部|查看全部物流|更多物流信息)$/, { exact: true });
  for (let i = 0; i < Math.min(await candidates.count(), 8); i += 1) {
    const candidate = candidates.nth(i);
    const belongsToTrace = await candidate.evaluate((element) => {
      let parent = element.parentElement;
      for (let depth = 0; parent && depth < 4; depth += 1, parent = parent.parentElement) {
        const text = parent.innerText ?? '';
        if (text.length > 2000 || parent.tagName === 'BODY') break;
        if (/\d{1,2}[-/月]\d{1,2}.*\d{1,2}:\d{2}/s.test(text) && /快件|包裹|签收|领取|揽收|派送|运输/.test(text) && !/收货地址/.test(text)) return true;
      }
      return false;
    }).catch(() => false);
    if (belongsToTrace) { await candidate.click({ timeout: 3000 }); await sleep(700); return; }
  }
}

const READ_BODY_JS = `(function(){return document.body ? document.body.innerText.slice(0,30000) : 'no-body';})()`;

export interface PddTraceResult {
  points: DetailPoint[];
  goods: JdGoods | null;
}

export function pddOrderUrl(item: Pick<ExpressItem, 'mailNo' | 'queryChannel'> & Partial<Pick<ExpressItem, 'jumpLinks'>>): string {
  for (const entry of parseJumpLinks(item.jumpLinks ?? '')) {
    try {
      const url = new URL(entry.link, PDD_TRACE_PAGE);
      if (url.origin === 'https://mobile.yangkeduo.com' && url.pathname === '/order.html' && url.searchParams.get('order_sn') === item.queryChannel) return url.href;
    } catch { /* 忽略无效链接 */ }
  }
  const id = item.queryChannel || item.mailNo;
  if (!/^\d{6,}-\d+$/.test(id)) throw new ParseError('此历史记录缺少有效的拼多多订单号，请先重新同步账号；不会查询其他包裹');
  return PDD_TRACE_PAGE + encodeURIComponent(id);
}

/**
 * 拼多多轨迹 + 商品：加载订单详情页，页面 SDK 自行签名物流接口，
 * 由 hook 捕获响应；物流页是 DOM 渲染，优先解析 DOM 文本，JSON 兜底。
 *
 * 与订单列表共用账号上下文；出现验证即停止，避免重载验证页。
 */
export async function fetchPddTrace(
  item: Pick<ExpressItem, 'mailNo' | 'queryChannel'> & Partial<Pick<ExpressItem, 'jumpLinks'>>,
  account: AccountRecord,
): Promise<PddTraceResult | null> {
  const target = pddOrderUrl(item);
  try {
    return await withPddSession(account, async (context) => {
      await installPddHook(context);
      const page = await context.newPage();
      watchPddPage(page);
      try {
        const result = await collectTrace(page, target);
        await persistPddSession(context, account);
        if (result?.points.length) setAccountStatus(account.id, 'ok', null);
        return result;
      } finally {
        await page.close().catch(() => undefined);
      }
    });
  } catch (err) {
    const status = accountStatusFor(err);
    const reason = safeMessage(err);
    const current = getAccountRecord(account.id);
    if (!(err instanceof ParseError || err instanceof TimeoutError) && current && (current.status !== status || current.statusDetail !== reason)) setAccountStatus(account.id, status, reason);
    logger.warn({ channel: 'pdd', accountId: account.id, errorType: err instanceof Error ? err.name : 'Error', reason }, 'pdd trace failed');
    throw err;
  }
}

export async function collectTrace(page: Page, target: string): Promise<PddTraceResult | null> {
  const captures: PddCaptureEntry[] = [];
  const deadline = Date.now() + TRACE_TIMEOUT_MS;
  let collectStarted = false;
  let rounds = 0;
  let lastCount = -1;
  let opened = false;
  let expanded = false;

  await page
    .goto(target, {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    })
    .catch(() => undefined);

  while (Date.now() < deadline) {
    const path = new URL(page.url()).pathname;
    if (path === '/orders.html') throw new ParseError('订单详情已退回列表，该订单标识无效或不属于此账号，请重新同步；未查询其他包裹');
    await assertPddPageReady(page);

    if (/order|logistic|express/.test(path)) {
      if (!collectStarted) {
        collectStarted = true;
        await sleep(COLLECT_DELAY_MS);
        await assertPddPageReady(page);
      }

      rounds += 1;

      const currentPath = new URL(page.url()).pathname;
      if (currentPath === '/order.html' && !opened) {
        opened = await openLogistics(page).catch(() => false);
        if (opened) { await sleep(1000); continue; }
      }
      if (/express|logistic/.test(currentPath) && !expanded) {
        await expandLogistics(page).catch(() => undefined);
        expanded = true;
      }
      // 只有物流页面的时间线可作为轨迹，订单创建时间/推荐商品不算轨迹。
      const rawText = /express|logistic/.test(currentPath)
        ? await page.evaluate(READ_BODY_JS).catch(() => '') : '';
      const domPoints = normalizePddPoints(parseDomPoints(typeof rawText === 'string' ? rawText : ''));
      if (domPoints.length > 0) {
        const stable = domPoints.length === lastCount;
        lastCount = domPoints.length;
        if ((stable && rounds >= 2) || rounds > MAX_ROUNDS) {
          return { points: domPoints, goods: null };
        }
        await sleep(ROUND_MS);
        continue;
      }

      for (const entry of await readCaptures(page)) {
        if (!looksRelevant(entry.url, entry.body)) continue;
        if (captures.some((c) => c.url === entry.url && c.body === entry.body)) continue;
        captures.push(entry);
      }
      const converted = convertPddTraces(captures);
      const stable = converted.points.length === lastCount;
      lastCount = converted.points.length;
      if (converted.points.length > 0 && ((stable && rounds >= 2) || rounds > MAX_ROUNDS)) return converted;
      if (rounds > MAX_ROUNDS) throw new TimeoutError('拼多多物流页未返回可解析的轨迹，请稍后刷新');

      await sleep(ROUND_MS);
      continue;
    }

    await sleep(500);
  }

  // 超时：与 Android 一致，用已捕获的数据收尾
  for (const entry of await readCaptures(page)) {
    if (!looksRelevant(entry.url, entry.body)) continue;
    if (captures.some((c) => c.url === entry.url && c.body === entry.body)) continue;
    captures.push(entry);
  }
  const result = convertPddTraces(captures);
  if (result.points.length === 0) throw new TimeoutError('拼多多未返回有效物流轨迹，未写入空缓存');
  return result;
}



/* ─────────────── DOM 文本解析 ─────────────── */

const DATE_RE = /((?:(20\d{2})[-/.年])?(\d{1,2})[-/.月](\d{1,2})日?[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?)/;
const NOISE = new Set([
  '复制',
  '展开',
  '物流服务',
  '在App打开',
  '顶部',
  '打赏快递员',
  '拨打电话',
  '货物跟踪',
  '包裹追踪',
]);
/** 推荐流/价格杂线 */
const REC_RE = /(即将恢复|本店已拼|全店总售|已抢|券后|立减|未发货秒退|24小时发货|限1件|退货包运费|\d+\.\d+$)/;
const SKIP_RE = /(订单编号|收货地址|快递员|网点电话|投诉电话|联系电话|微信公众号|^：$|^\d+$)/;
const DESC_KW = [
  '快件',
  '包裹',
  '派件',
  '揽收',
  '签收',
  '领取',
  '发往',
  '到达',
  '转运',
  '投递',
  '取件',
  '出库',
  '配送',
  '妥投',
  '物流',
  '运输',
  '发出',
  '已投',
  '送达',
  '查询',
  '无轨迹',
  '拦截',
  '快递',
  '签收人',
  '配送至',
  '快递员',
  '网点',
];
const CONT_KW = [
  '快递',
  '签收',
  '物流',
  '包裹',
  '快件',
  '网点',
  '电话',
  '服务',
  '反馈',
  '感谢',
  '送达',
  '配送',
  '运输',
  '预计',
];

function looksLikeDesc(line: string): boolean {
  return line.length >= 6 && DESC_KW.some((kw) => line.includes(kw));
}

/**
 * 与 Android `parseDomPoints` 完全一致：
 * goods_express 物流页为「状态+时间 粘连行 + 描述行」结构。
 */
export function parseDomPoints(raw: string | null | undefined, reference = new Date()): DetailPoint[] {
  let text = (raw ?? '').trim();
  if (!text) return [];
  if (text.startsWith('"') && text.endsWith('"')) {
    text = text.slice(1, -1).replace(/\\n/g, '\n');
  }

  text = text.replace(/((?:20\d{2}[-/.年])?\d{1,2}[-/.月]\d{1,2}日?)\s*\n\s*(\d{1,2}:\d{2})/g, '$1 $2');
  const points: DetailPoint[] = [];
  let pending: string | null = null;
  let pendingTime = '';
  let inRec = false;
  let descriptionFirst = false;
  let seenDate = false;

  const flush = (): void => {
    const d = (pending ?? '').trim();
    if (d !== '' && d.length >= 2 && pendingTime !== '') {
      points.push({ context: d.slice(0, 400), time: pendingTime, formattedTime: pendingTime });
    }
  };

  for (const line of text.split('\n')) {
    const l = line.trim();
    if (l === '') continue;

    const dm = DATE_RE.exec(l);
    if (dm) {
      const rawDate = dm[1] ?? '';
      const month = Number(dm[3]);
      let year = Number(dm[2]) || reference.getFullYear();
      if (!dm[2] && month > reference.getMonth() + 7) year -= 1;
      const t = `${year}-${String(month).padStart(2, '0')}-${String(dm[4]).padStart(2, '0')} ${String(dm[5]).padStart(2, '0')}:${dm[6]}${dm[7] ? `:${dm[7]}` : ''}`;
      const statusPrefix = l.slice(0, dm.index).trim();
      const suffix = l.slice(dm.index + rawDate.length).trim();
      if (!seenDate && !statusPrefix && !suffix && pending && looksLikeDesc(pending)) descriptionFirst = true;
      seenDate = true;
      if (descriptionFirst) {
        pending = [pending, statusPrefix, suffix].filter(Boolean).join(' ');
        pendingTime = t;
        flush();
        pending = null;
        pendingTime = '';
        inRec = false;
        continue;
      }
      flush();
      pendingTime = t;
      inRec = false;
      pending = [statusPrefix, suffix].filter((part) => part && !NOISE.has(part)).join(' ');
      continue;
    }

    if (NOISE.has(l)) continue;
    if (inRec) continue;

    // 描述行优先（包含 快递/送达/签收 等）——即使里面混有电话/网点数字
    if (looksLikeDesc(l)) {
      if (!seenDate) { pending = l; continue; }
      if (pending === null) pending = '';
      if (pending.length < 400) pending += ` ${l}`;
      continue;
    }

    if (REC_RE.test(l)) {
      // 进入推荐流：把已收集描述落点并停止追加
      flush();
      pending = null;
      inRec = true;
      continue;
    }

    if (SKIP_RE.test(l)) continue;

    if (pending === null) {
      if (seenDate && l.length >= 4 && !/^\d+$/.test(l) && !descriptionFirst) pending = l;
    } else {
      // 续行追加仅接受带物流关键词的行（防止推荐流标题混入）
      // 注意：Kotlin 原文为 `l.length >= 6 && l.contains("快递") || contKw.any {...}`，
      // `&&` 优先级高于 `||`，此处保持同样语义。
      const accept =
        (l.length >= 6 && l.includes('快递')) || CONT_KW.some((kw) => l.includes(kw));
      if (accept && pending.length < 400) pending += ` ${l}`;
    }
  }

  // 收尾：最后一条的「状态+时间」已在时间行记录，flush 剩余描述
  flush();
  return points;
}

/* ─────────────── 容错解析（JSON 捕获） ─────────────── */

/** 与 Android `convert` 一致：轨迹点来自任意相关响应；商品只从列表接口取 */
export function convertPddTraces(captures: readonly PddCaptureEntry[]): PddTraceResult {
  const pointsMap = new Map<string, DetailPoint>();
  let goods: JdGoods | null = null;

  for (const { url, body } of captures) {
    if (!looksRelevant(url, body)) continue;
    if (!/express|logistic|track/.test(url)) continue;
    let root: unknown;
    try {
      root = JSON.parse(body);
    } catch {
      continue;
    }
    collectPoints(root, pointsMap);
    // 详情页 order_detail_group.goods_list 是推荐流，不要误采
    if (goods === null && url.includes('order_list_v4')) {
      const obj = asObject(root);
      if (obj) goods = extractGoods(obj);
    }
  }

  return { points: normalizePddPoints([...pointsMap.values()]), goods };
}

/** 服务端统一存储为旧→新，DOM 通常为新→旧；去重后按时间排序。 */
export function normalizePddPoints(points: readonly DetailPoint[]): DetailPoint[] {
  const unique = new Map(points.map((point) => [`${point.time}|${point.context}`, point]));
  const stamp = (point: DetailPoint) => Date.parse(point.time.replace(/\//g, '-').replace(' ', 'T'));
  return [...unique.values()].sort((a, b) => {
    const at = stamp(a), bt = stamp(b);
    return Number.isFinite(at) && Number.isFinite(bt) ? at - bt : 0;
  });
}

function collectPoints(node: unknown, out: Map<string, DetailPoint>): void {
  if (Array.isArray(node)) {
    for (const child of node) collectPoints(child, out);
    return;
  }
  const obj = asObject(node);
  if (!obj) return;

  // 轨迹点对象：同时有时间与描述
  const rawTime = [...TIME_KEYS].map((key) => obj[key]).find((value) => typeof value === 'string' || typeof value === 'number');
  const time = timeString(rawTime);
  const desc = [...DESC_KEYS].map((key) => obj[key]).find((value): value is string => typeof value === 'string' && value.trim() !== '') ?? '';
  if (time !== '' && desc !== '' && desc !== time) {
    const key = `${time}|${desc}`;
    if (!out.has(key)) {
      out.set(key, { context: desc, time, formattedTime: time });
    }
    return;
  }

  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (typeof v === 'object' && v !== null) collectPoints(v, out);
  }
}

/** 与 Android `extractGoods` 一致：空名视为无商品 */
export function extractGoods(obj: Record<string, unknown>): JdGoods | null {
  const name = firstStringDeep(obj, GOODS_NAME_KEYS, 6);
  if (name === '') return null;
  let pic = firstStringDeep(obj, GOODS_PIC_KEYS, 6);
  if (pic.startsWith('//')) pic = `https:${pic}`;
  const count = firstStringDeep(obj, GOODS_NUM_KEYS, 6);
  return {
    name: name.slice(0, 200),
    imageUrl: pic,
    count: count !== '' ? `x${count}` : '',
    shortName: '',
  };
}
