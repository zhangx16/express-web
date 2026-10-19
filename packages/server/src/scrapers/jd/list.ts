import type { Page } from 'playwright';
import { createEmptyItem, type ExpressItem, type JdGoods } from '@ea/shared';
import { acquireContext } from '../../browser/pool.js';
import { upsertGoods } from '../../db/repositories/goods.js';
import {
  enabledAccounts,
  setAccountStatus,
  updateAccountPayload,
  type AccountRecord,
  type CookieAccountPayload,
} from '../../services/accounts/repo.js';
import { logger } from '../../lib/logger.js';
import { collectCookies, hasLoginCookie, setCookiesForHosts } from '../browser/cookies.js';
import { accountStatusFor, RiskChallengeError, safeMessage, TimeoutError } from '../browser/errors.js';
import { sleep, swipeUp } from '../browser/touch.js';
import { installJdHook } from './hooks.js';

export const JD_ORDER_CENTER =
  'https://trade.m.jd.com/order/orderlist_jdm.shtml?orderType=all&source=m_outer_jx_order';

/** Cookie 注入/回读的 host 列表（与 Android JdListFetcher 一致） */
export const JD_COOKIE_HOSTS = [
  'https://www.jd.com',
  'https://wqs.jd.com',
  'https://trade.m.jd.com',
  'https://api.m.jd.com',
  'https://jingfen.jd.com',
] as const;

/** 回存时额外读取登录域，避免验证码完成后 token 丢失 */
const JD_COLLECT_HOSTS = [...JD_COOKIE_HOSTS, 'https://plogin.m.jd.com'] as const;

const SCROLL_ROUND_MS = 3000;
const MAX_SCROLL_ROUNDS = 14;
const HARD_TIMEOUT_MS = 60_000;

export interface JdFetchResult {
  items: ExpressItem[] | null;
  error: string | null;
}

interface JdConvertResult {
  items: ExpressItem[];
  goods: Map<string, JdGoods>;
  total: number;
}

/**
 * 京东包裹列表（浏览器渠道）。
 * 逐账号抓取，一个账号失败不影响其它账号；失败账号更新自身状态。
 */
export async function fetchJdOrders(): Promise<JdFetchResult> {
  const accounts = enabledAccounts('jd');
  if (accounts.length === 0) return { items: null, error: null };

  const allItems: ExpressItem[] = [];
  const allGoods = new Map<string, JdGoods>();
  let error: string | null = null;

  for (const account of accounts) {
    try {
      const { items, goods } = await fetchJdAccount(account);
      allItems.push(...items);
      for (const [k, v] of goods) allGoods.set(k, v);
      setAccountStatus(account.id, 'ok', null);
    } catch (err) {
      const message = safeMessage(err);
      setAccountStatus(account.id, accountStatusFor(err), message);
      error = message;
      logger.warn({ channel: 'jd', accountId: account.id }, 'jd account sync failed');
    }
  }

  if (allGoods.size > 0) {
    try {
      upsertGoods(allGoods);
    } catch (err) {
      logger.warn({ err }, 'jd goods persist failed');
    }
  }

  if (allItems.length === 0 && error !== null) return { items: null, error };
  return { items: dedupeById(allItems), error };
}

function dedupeById(items: ExpressItem[]): ExpressItem[] {
  const map = new Map<string, ExpressItem>();
  for (const item of items) if (!map.has(item.mailNo)) map.set(item.mailNo, item);
  return [...map.values()];
}

async function fetchJdAccount(account: AccountRecord): Promise<{
  items: ExpressItem[];
  goods: Map<string, JdGoods>;
}> {
  const payload = account.payload as CookieAccountPayload;
  const cookie = payload.cookie ?? '';
  if (!cookie || !hasLoginCookie(cookie, 'pt_key')) {
    // 无登录态：直接静默加载订单页会拿到空列表，按需登录处理
    throw new RiskChallengeError('京东未登录或登录态已失效，请重新登录');
  }

  const context = await acquireContext(account.id);
  await installJdHook(context);
  await setCookiesForHosts(context, cookie, JD_COOKIE_HOSTS);

  const page = await context.newPage();
  try {
    return await collectOrders(page, account);
  } finally {
    await page.close().catch(() => undefined);
  }
}

async function collectOrders(
  page: Page,
  account: AccountRecord,
): Promise<{ items: ExpressItem[]; goods: Map<string, JdGoods> }> {
  const captures: string[] = [];
  const deadline = Date.now() + HARD_TIMEOUT_MS;

  let collectStarted = false;
  let challengeSeen = false;
  let rounds = 0;
  let lastResult: JdConvertResult = { items: [], goods: new Map(), total: 0 };

  await page.goto(JD_ORDER_CENTER, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch((err) => {
    logger.warn({ err }, 'jd navigate failed');
  });

  while (Date.now() < deadline) {
    const url = page.url();

    if (url.includes('plogin') || url.includes('nopasswordcmcc')) {
      challengeSeen = true;
      // 静默等待页面自行完成验证；期间回存可能刷新的 Cookie
      await sleep(2500);
      await refreshCookies(page, account);
      await sleep(2000);
      continue;
    }

    if (url.includes('orderlist_jdm.shtml') && !url.includes('orderType=search')) {
      if (!collectStarted) {
        await refreshCookies(page, account);
        await sleep(4000);
        collectStarted = true;
      }

      rounds += 1;
      await readCaptures(page, captures);
      lastResult = convertCaptures(captures, account);
      if (
        (lastResult.total > 0 && lastResult.items.length >= lastResult.total) ||
        rounds > MAX_SCROLL_ROUNDS
      ) {
        await refreshCookies(page, account);
        return { items: lastResult.items, goods: lastResult.goods };
      }
      await swipeUp(page);
      await sleep(SCROLL_ROUND_MS);
      continue;
    }

    await sleep(500);
  }

  // 超时：与 Android 一致，返回已抓到的部分数据并附带错误
  if (!collectStarted && challengeSeen) {
    throw new RiskChallengeError('京东要求安全验证，请重新登录');
  }
  if (!collectStarted) {
    throw new TimeoutError('京东列表超时（已用部分数据）');
  }
  await readCaptures(page, captures);
  lastResult = convertCaptures(captures, account);
  if (lastResult.items.length === 0) {
    throw new TimeoutError('京东列表超时（已用部分数据）');
  }
  return { items: lastResult.items, goods: lastResult.goods };
}

/** 读取 `window.name` 中的捕获（跨导航存活），按字符串去重 */
async function readCaptures(page: Page, captures: string[]): Promise<void> {
  let raw: string;
  try {
    raw = await page.evaluate(() => window.name || '[]');
  } catch {
    return;
  }
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return;
  }
  if (!Array.isArray(arr)) return;
  for (const entry of arr) {
    if (typeof entry !== 'string') continue;
    if (!entry.includes('orderList')) continue;
    if (!captures.includes(entry)) captures.push(entry);
  }
}

/** 回存最新 Cookie（防降级：登录集不能被匿名集覆盖） */
async function refreshCookies(page: Page, account: AccountRecord): Promise<void> {
  let cookies: string;
  try {
    cookies = await collectCookies(page.context(), JD_COLLECT_HOSTS);
  } catch {
    return;
  }
  if (!cookies) return;
  const old = (account.payload as CookieAccountPayload).cookie ?? '';
  if (old.includes('pt_key=') && !cookies.includes('pt_key=')) {
    logger.info({ channel: 'jd', accountId: account.id }, 'skip anonymous cookie overwrite');
    return;
  }
  const identity = parseCookieHeaderValue(cookies, 'pt_pin');
  try {
    updateAccountPayload(account.id, { cookie: cookies, ...(identity ? { identity } : {}) });
  } catch (err) {
    logger.warn({ err }, 'jd cookie persist failed');
  }
}

function parseCookieHeaderValue(header: string, name: string): string | undefined {
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const idx = trimmed.indexOf('=');
    if (idx > 0 && trimmed.slice(0, idx) === name) {
      const value = trimmed.slice(idx + 1);
      return value ? decodeURIComponent(value) : undefined;
    }
  }
  return undefined;
}

/** 与 Android `convert` 一致：解析 orderList、跳过取消/待付款、映射状态 */
export function convertCaptures(captures: readonly string[], account: AccountRecord | null): JdConvertResult {
  const byId = new Map<string, ExpressItem>();
  const goods = new Map<string, JdGoods>();
  let total = 0;

  for (const body of captures) {
    let root: Record<string, unknown>;
    try {
      root = JSON.parse(body) as Record<string, unknown>;
    } catch {
      continue;
    }
    const bodyObj = asObject(root.body);
    if (!bodyObj) continue;
    const totalNum = asNumber(bodyObj.totalNum);
    if (totalNum > 0) total = totalNum;
    const orderList = bodyObj.orderList;
    if (!Array.isArray(orderList)) continue;

    for (const rawOrder of orderList) {
      const o = asObject(rawOrder);
      if (!o) continue;
      const orderId = asString(o.orderId);
      if (!orderId) continue;

      const status = asObject(o.orderStatusInfo);
      const statusName = asString(status?.orderStatusName);
      if (/(取消|关闭|退款|售后|待付款|未支付)/.test(statusName)) continue;

      const prog = asObject(o.progressInfo);
      const latestText =
        asString(prog?.content) || asString(status?.stateTip) || statusName;

      const trackLink =
        asString(prog?.progressLink) ||
        buildTrackLink({
          orderId,
          orderType: asString(o.orderType),
          skuId: asString(asObject(firstOf(o.wareInfoList))?.skuId),
          shopId: asString(asObject(o.shopInfo)?.shopId),
          dealState: asString(status?.originOrderStatus),
        });

      const latestTime = asString(prog?.tip);

      // 「待收货」只代表已发货在途，不等于「派送中」；
      // 只有状态文案明确写派送/派件时才映射到 105（85%），否则归运输中 104（55%）。
      const state =
        statusName.includes('完成') || statusName.includes('签收')
          ? 3
          : statusName.includes('派送') || statusName.includes('派件')
            ? 5
            : statusName.includes('待发货') ||
                statusName.includes('待出库') ||
                statusName.includes('未发货') ||
                statusName.includes('待成团')
              ? 1
              : statusName.includes('待收货') ||
                  statusName.includes('等待收货') ||
                  (statusName.includes('出库') && !statusName.includes('待出库')) ||
                  statusName.includes('运输') ||
                  statusName.includes('转运') ||
                  statusName.includes('分拣') ||
                  statusName.includes('发货')
                ? 2
                : 0;
      const stateNum = state === 3 ? 107 : state === 5 ? 105 : state === 2 ? 104 : state === 1 ? 103 : 104;

      byId.set(
        orderId,
        createEmptyItem({
          id: orderId,
          mailNo: orderId,
          companyCode: 'JDKD',
          companyName: '京东商品快递',
          latestText,
          latestTime,
          state,
          stateName: statusName,
          provider: 'JingDong',
          stateNum,
          queryChannel: trackLink,
          source: 'jd',
          accountId: account?.id ?? '',
          accountLabel: account?.label ?? '',
        }),
      );

      const wares = o.wareInfoList;
      if (Array.isArray(wares) && wares.length > 0) {
        const w0 = asObject(wares[0]);
        if (w0) {
          goods.set(orderId, {
            name: asString(w0.wareName),
            imageUrl: asString(w0.imageUrl),
            count: `x${asNumber(w0.num) || 1}`,
            shortName: '',
          });
        }
      }
    }
  }

  return { items: [...byId.values()], goods, total };
}

function buildTrackLink(input: {
  orderId: string;
  orderType: string;
  skuId: string;
  shopId: string;
  dealState: string;
}): string {
  return (
    'https://trade.m.jd.com/order/deal_wuliu_jdm.shtml?from=orderdetail' +
    `&dealState=${input.dealState}&dealId=${input.orderId}&orderType=${input.orderType}` +
    `&skuid=${input.skuId}&shopid=${input.shopId}&source=m_inner_orderList.track_orderTrack`
  );
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

function asNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function firstOf(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : undefined;
}
