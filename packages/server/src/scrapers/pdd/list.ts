import type { BrowserContext, Page } from 'playwright';
import { createEmptyItem, type ExpressItem, type JdGoods } from '@ea/shared';
import { assertPddPageReady, watchPddPage, withPddSession, persistPddSession } from './session.js';
import { upsertGoods } from '../../db/repositories/goods.js';
import {
  enabledAccounts,
  setAccountStatus,
  type AccountRecord,
} from '../../services/accounts/repo.js';
import { logger } from '../../lib/logger.js';
import {
  accountStatusFor,
  safeMessage,
  TimeoutError,
} from '../browser/errors.js';
import { sleep, swipeUp } from '../browser/touch.js';
import {
  asObject,
  firstString,
  firstStringDeep,
  firstValueDeep,
  looksRelevant,
  readCaptures,
  timeString,
  tryTapAllOrders,
  tryTapMore,
  type PddCaptureEntry,
} from './capture.js';
import { pddStatusFromText } from './status.js';
import { installPddHook } from './hooks.js';

/** 拼多多 H5 买家订单页（React 无限滚动） */
export const PDD_ORDER_PAGE = 'https://mobile.yangkeduo.com/orders.html';

const INITIAL_DELAY_MS = 4000;
const ROUND_MS = 3000;
const MAX_ROUNDS = 18;
const HARD_TIMEOUT_MS = 75_000;

/* ─────────────── 候选键（与 Android PddListFetcher 完全一致） ─────────────── */

const ORDER_KEYS = new Set([
  'order_sn',
  'orderSn',
  'order_id',
  'orderId',
  'mall_order_sn',
  'order_no',
  'order_list_sn',
  'orderSnList',
]);
const TRACK_KEYS = new Set([
  'tracking_number',
  'tracking_no',
  'mailNo',
  'mail_no',
  'express_no',
  'logistics_no',
  'waybill_no',
  'waybillCode',
  'trackingNumber',
  'logistics_sn',
  'delivery_no',
]);
const COMPANY_KEYS = new Set([
  'logistics_company_short_name',
  'logisticsCompanyName',
  'logistics_company_name',
  'shipping_company',
  'express_company_name',
  'company_name',
  'express_company',
]);
const STATUS_KEYS = new Set([
  'order_status_prompt',
  'order_prompt',
  'status_prompt_text',
  'order_status_text',
  'combined_order_status_prompt',
  'status_desc',
  'statusDesc',
  'order_status_desc',
  'order_status',
  'orderStatus',
  'combined_order_status',
  'shipping_status',
  'status_text',
  'statusText',
  'logistics_status',
  'status',
]);
const TRACK_KEYS_TEXT = new Set([
  'order_status_prompt',
  'bottom_left_content',
  'logistics_desc',
  'tracking_desc',
  'logistics_desc_text',
  'status_desc',
  'statusDesc',
  'latest_status',
  'latest_status_text',
  'description',
  'desc',
  'text',
]);
const TRACK_KEYS_TIME = new Set([
  'logistics_update_time',
  'latest_time',
  'tracking_time',
  'update_time',
  'updateTime',
  'create_time',
  'gmt_modified',
  'status_change_time',
  'last_update_time',
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
  'thumb_url',
  'hd_thumb_url',
]);
const GOODS_NUM_KEYS = new Set(['goods_num', 'goodsCount', 'quantity', 'num', 'count', 'goods_number']);

const CLOSED_MARKERS = ['取消', '关闭', '退款', '售后', '待付款', '未支付', '已取消', '交易关闭'];

export interface PddFetchResult {
  items: ExpressItem[] | null;
  error: string | null;
}

export interface PddConvertResult {
  items: ExpressItem[];
  goods: Map<string, JdGoods>;
}

/**
 * 拼多多包裹列表（浏览器渠道）。
 * 逐账号抓取，一个账号失败不影响其它账号；同步过程中通过 onBatch 流式推送增量。
 */
export async function fetchPddOrders(
  onBatch?: (items: ExpressItem[]) => void,
): Promise<PddFetchResult> {
  const accounts = enabledAccounts('pdd');
  if (accounts.length === 0) return { items: null, error: null };

  const allItems: ExpressItem[] = [];
  const allGoods = new Map<string, JdGoods>();
  let error: string | null = null;
  let batchSeen = 0;

  for (const account of accounts) {
    if (account.status === 'challenge' || account.status === 'needs_login') {
      error = account.statusDetail || '拼多多已暂停抓取，请完成安全验证后重新登录';
      continue;
    }
    try {
      const { items, goods } = await withPddSession(account, (context) =>
        fetchPddAccount(context, account, (fresh) => {
          if (!onBatch) return;
          batchSeen += 1;
          onBatch(fresh);
        }),
      );
      allItems.push(...items);
      for (const [k, v] of goods) allGoods.set(k, v);
      setAccountStatus(account.id, 'ok', null);
    } catch (err) {
      const message = safeMessage(err);
      setAccountStatus(account.id, accountStatusFor(err), message);
      error = message;
      logger.warn({ channel: 'pdd', accountId: account.id, errorType: err instanceof Error ? err.name : 'Error', reason: message }, 'pdd account sync failed');
    }
  }

  if (allGoods.size > 0) {
    try {
      upsertGoods(allGoods);
    } catch (err) {
      logger.warn({ err }, 'pdd goods persist failed');
    }
  }

  // 无流式增量时（或流式期间未产出）补发一次最终结果，保证前端能出卡片
  if (onBatch && batchSeen === 0 && allItems.length > 0) onBatch(allItems);

  if (allItems.length === 0 && error !== null) return { items: null, error };
  return { items: dedupeByMailNo(allItems), error };
}

function dedupeByMailNo(items: ExpressItem[]): ExpressItem[] {
  const map = new Map<string, ExpressItem>();
  for (const item of items) if (!map.has(item.mailNo)) map.set(item.mailNo, item);
  return [...map.values()];
}

async function fetchPddAccount(
  context: BrowserContext,
  account: AccountRecord,
  onBatch: (items: ExpressItem[]) => void,
): Promise<PddConvertResult> {
  await installPddHook(context);

  const page = await context.newPage();
  watchPddPage(page);
  try {
    return await collectOrders(page, account, onBatch);
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function collectOrders(
  page: Page,
  account: AccountRecord,
  onBatch: (items: ExpressItem[]) => void,
): Promise<PddConvertResult> {
  const captures: PddCaptureEntry[] = [];
  const emitted = new Set<string>();
  const emittedGoods = new Set<string>();

  const deadline = Date.now() + HARD_TIMEOUT_MS;
  let collectStarted = false;
  let rounds = 0;
  let lastCount = -1;
  let stableStreak = 0;

  await page.goto(PDD_ORDER_PAGE, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch((err) => {
    logger.warn({ err }, 'pdd navigate failed');
  });

  while (Date.now() < deadline) {
    await assertPddPageReady(page);
    const url = page.url();

    if (url.includes('order') && !url.includes('proxy')) {
      if (!collectStarted) {
        collectStarted = true;
        await sleep(INITIAL_DELAY_MS);
        await assertPddPageReady(page);
      }

      rounds += 1;
      for (const entry of await readCaptures(page)) {
        if (!looksRelevant(entry.url, entry.body)) continue;
        if (captures.some((c) => c.url === entry.url && c.body === entry.body)) continue;
        captures.push(entry);
      }

      const converted = convert(captures, account);

      // 流式：只推送本轮新增的订单与商品（「获取一点加载一点」）
      if (converted.items.length > 0) {
        const fresh = converted.items.filter((i) => !emitted.has(i.mailNo));
        for (const i of fresh) emitted.add(i.mailNo);
        const freshGoods = [...converted.goods.entries()].filter(([k]) => !emittedGoods.has(k));
        for (const [k] of freshGoods) emittedGoods.add(k);
        if (fresh.length > 0) onBatch(fresh);
      }

      if (rounds === 1) await tryTapAllOrders(page);
      await tryTapMore(page);
      await swipeUp(page);

      if (converted.items.length === lastCount) {
        stableStreak += 1;
      } else {
        stableStreak = 0;
        lastCount = converted.items.length;
      }

      if (
        (converted.items.length > 0 && stableStreak >= 3 && rounds >= 6) ||
        rounds > MAX_ROUNDS
      ) {
        await refreshCookies(page, account);
        return converted;
      }

      await sleep(ROUND_MS);
      continue;
    }

    await sleep(500);
  }

  // 超时：与 Android 一致，返回已抓到的部分数据并附带错误
  await refreshCookies(page, account).catch(() => undefined);
  const final = convert(captures, account);
  if (final.items.length === 0) throw new TimeoutError('拼多多列表超时（已用部分数据）');
  return final;
}

/** 保存完整浏览器状态，防止后续查询退回仅 Cookie 的会话。 */
async function refreshCookies(page: Page, account: AccountRecord): Promise<void> {
  await persistPddSession(page.context(), account);
}

/** 与 Android `convert` 一致：排除 track/status 码表，递归收集订单 */
export function convert(captures: readonly PddCaptureEntry[], account: AccountRecord | null): PddConvertResult {
  const byOrder = new Map<string, ExpressItem>();
  const goodsMap = new Map<string, JdGoods>();
  const accountId = account?.id ?? '';
  const accountLabel = account?.label ?? '';

  for (const { url, body } of captures) {
    // 排除「状态码表」：express/track/status 只是 order_sn→GOT/SIGN/1 的映射，不是订单
    if (url.includes('track/status')) continue;
    if (!looksRelevant(url, body)) continue;
    let root: unknown;
    try {
      root = JSON.parse(body);
    } catch {
      continue;
    }
    collectOrdersFrom(root, byOrder, goodsMap, accountId, accountLabel);
  }

  return { items: [...byOrder.values()], goods: goodsMap };
}

function collectOrdersFrom(
  node: unknown,
  byOrder: Map<string, ExpressItem>,
  goodsMap: Map<string, JdGoods>,
  accountId: string,
  accountLabel: string,
): void {
  if (Array.isArray(node)) {
    for (const child of node) collectOrdersFrom(child, byOrder, goodsMap, accountId, accountLabel);
    return;
  }
  const obj = asObject(node);
  if (!obj) return;
  if (looksLikeOrder(obj)) {
    parseOrder(obj, byOrder, goodsMap, accountId, accountLabel);
    return;
  }
  for (const key of Object.keys(obj)) {
    const inner = obj[key];
    if (typeof inner === 'object' && inner !== null) {
      collectOrdersFrom(inner, byOrder, goodsMap, accountId, accountLabel);
    }
  }
}

function looksLikeOrder(obj: Record<string, unknown>): boolean {
  for (const keys of [ORDER_KEYS, TRACK_KEYS]) {
    for (const k of keys) {
      if (!(k in obj)) continue;
      const v = obj[k];
      if (typeof v === 'string' || typeof v === 'number') return true;
    }
  }
  return false;
}

/** 与 Android `parseOrder` 一致（状态映射/跳过规则/字段优先级逐条对齐） */
export function parseOrder(
  obj: Record<string, unknown>,
  byOrder: Map<string, ExpressItem>,
  goodsMap: Map<string, JdGoods>,
  accountId: string,
  accountLabel: string,
): void {
  const orderId = firstString(obj, ORDER_KEYS);
  const mailNo = firstString(obj, TRACK_KEYS) || orderId;
  if (mailNo === '') return;

  const statusText = firstString(obj, STATUS_KEYS);
  if (CLOSED_MARKERS.some((m) => statusText.includes(m))) return;

  const received = Number(obj.receive_time ?? obj.received_time ?? obj.confirm_receive_time) > 0;
  const statusTexts = [...STATUS_KEYS].map((key) => obj[key]).filter((value): value is string => typeof value === 'string' && !/^拼过\d+次$|^\d+$/.test(value));
  const status = statusTexts.map(pddStatusFromText).find((value) => value?.state === 4)
    ?? (received ? { state: 3, stateNum: 107, stateName: '已签收' } : null)
    ?? statusTexts.map(pddStatusFromText).find((value) => value?.state === 3)
    ?? statusTexts.map(pddStatusFromText).find((value) => value !== null)
    ?? { state: -1, stateNum: 0, stateName: '状态待确认' };
  const { state, stateNum } = status;

  const candidateText = firstStringDeep(obj, TRACK_KEYS_TEXT, 4) || statusText.trim();
  const latestText = /^拼过\d+次$|^\d+$/.test(candidateText) ? status.stateName : candidateText;
  const latestTime = timeString(firstValueDeep(obj, TRACK_KEYS_TIME, 4));
  const companyName = firstString(obj, COMPANY_KEYS) || '拼多多快递';
  const goods = extractGoods(obj);

  const key = orderId || mailNo;
  const previous = byOrder.get(key);
  if (previous && (state === -1 || (previous.state === 3 && state !== 3 && state !== 4))) return;
  const rawLink = firstString(obj, new Set(['order_link_url']));
  let jumpLinks = '';
  if (rawLink) {
    try {
      const url = new URL(rawLink, PDD_ORDER_PAGE);
      if (url.origin === new URL(PDD_ORDER_PAGE).origin && url.pathname === '/order.html') jumpLinks = JSON.stringify([{ link: url.href, type: 'order' }]);
    } catch { /* 无有效链接时使用订单号 */ }
  }
  byOrder.set(
    key,
    createEmptyItem({
      id: key,
      mailNo,
      companyCode: 'PDD',
      companyName,
      latestText,
      latestTime,
      state,
      stateName: status.state === 3 && !pddStatusFromText(statusText) ? status.stateName : (status.state === -1 ? status.stateName : statusText.trim().slice(0, 60) || status.stateName),
      jumpLinks,
      provider: 'Pinduoduo',
      stateNum,
      queryChannel: key,
      source: 'pdd',
      accountId,
      accountLabel,
    }),
  );

  if (goods && goods.name !== '') goodsMap.set(mailNo, goods);
}

/** 与 Android `extractGoods` 一致：空名视为无商品（保留旧值） */
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
