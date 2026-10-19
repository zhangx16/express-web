import type { ItemSource, DetailPoint, ExpressItem, TraceResponse } from '@ea/shared';
import { isWaitingPickup, pickupCodeFromParts, fengchaoCabinetFrom, extractEta, isDone, TRACE_TTL } from '@ea/shared';
import { fetchCarrierTrace, usesCarrier, MIN_QUERY_MS } from '../logistics/kuaidi100.js';
import { updateItemFields } from '../../db/repositories/items.js';
import { pddStatusFromTrace } from '../../scrapers/pdd/status.js';
import { getTrace, saveTrace, type CachedTrace } from '../../db/repositories/traces.js';
import { getAccountRecord, type CookieAccountPayload } from '../accounts/repo.js';
import { fetchJdTrack } from '../../scrapers/jd/track.js';
import { fetchSsrTraces } from '../../scrapers/taobao/ssr.js';
import { fetchCainiaoTraces } from '../../scrapers/taobao/cainiao.js';
import { fetchPddTrace } from '../../scrapers/pdd/trace.js';
import { AuthExpiredError, RiskChallengeError, ParseError, TimeoutError, RateLimitedError, safeMessage } from '../../scrapers/browser/errors.js';
import { eventBus } from '../../events/bus.js';
import { UpstreamError } from '../../http/errors.js';

/** 轨迹统一按「旧 → 新」存储；`points.at(-1)` 恒为最新一条 */
function toOldestFirst(points: DetailPoint[], native: 'newest-first' | 'oldest-first'): DetailPoint[] {
  return native === 'newest-first' ? [...points].reverse() : points;
}

function ttlFor(source: ItemSource, done: boolean): number {
  switch (source) {
    case 'manual': return done ? 24 * 60 * 60_000 : MIN_QUERY_MS;
    case 'pdd':
      return done ? TRACE_TTL.pddDone : TRACE_TTL.pddActive;
    case 'jd':
      return done ? TRACE_TTL.jdDone : TRACE_TTL.jdActive;
    default:
      return done ? TRACE_TTL.taobaoDone : TRACE_TTL.taobaoActive;
  }
}

function cacheFresh(fetchedAt: string, source: ItemSource, done: boolean): boolean {
  const t = Date.parse(fetchedAt);
  if (Number.isNaN(t)) return false;
  const ttl = ttlFor(source, done);
  return ttl === Number.POSITIVE_INFINITY || (Number.isFinite(ttl) && Date.now() - t < ttl);
}

function accountCookie(accountId: string, channel: 'jd' | 'taobao'): string {
  if (!accountId) throw new UpstreamError('account_missing', '该包裹没有关联账号，无法查询轨迹');
  const account = getAccountRecord(accountId);
  if (!account) throw new UpstreamError('account_missing', '关联账号不存在', 409);
  if (account.channel !== channel) throw new UpstreamError('account_channel_mismatch', '包裹关联账号的平台不匹配，请重新同步对应平台账号', 409);
  if (account.enabled === false) throw new UpstreamError('account_disabled', '关联账号已停用，请先在设置中启用', 409);
  if (account.status === 'needs_login' || account.status === 'challenge') throw new UpstreamError('account_login_required', '关联账号需要重新登录或完成安全验证', 409);
  const payload = account.payload as CookieAccountPayload;
  if (!payload.cookie) throw new UpstreamError('account_missing', '账号登录态缺失，请重新登录');
  return payload.cookie;
}

async function fetchFromUpstream(item: ExpressItem): Promise<{ points: DetailPoint[]; eta: string; status?: Pick<ExpressItem, 'state' | 'stateNum' | 'stateName'> }> {
  const done = isDone(item);

  switch (item.source) {
    case 'manual':
      throw new UpstreamError('trace_unavailable', '手工添加的包裹没有关联平台，无法查询轨迹');
    case 'jd': {
      const cookie = accountCookie(item.accountId, item.source);
      const result = await fetchJdTrack(item, cookie);
      if (result.error && result.points.length === 0) {
        throw new UpstreamError('trace_failed', result.error);
      }
      return {
        points: toOldestFirst(result.points, 'newest-first'),
        eta: extractEta(...result.points.map((p) => p.context)),
      };
    }
    case 'taobao': {
      const cookie = accountCookie(item.accountId, item.source);
      // 与 Android DetailActivity 一致：有订单号走 SSR，否则用菜鸟按运单号查
      const points = item.queryChannel
        ? ((await fetchSsrTraces(cookie, item.queryChannel)) ??
          (await fetchCainiaoTraces(cookie, item.mailNo)))
        : await fetchCainiaoTraces(cookie, item.mailNo);
      if (!points) throw new UpstreamError('trace_failed', '淘宝轨迹获取失败，请稍后重试');
      return {
        points: toOldestFirst(points, 'newest-first'),
        eta: extractEta(...points.map((p) => p.context)),
      };
    }
    case 'pdd': {
      const account = getAccountRecord(item.accountId);
      if (!account || account.channel !== 'pdd') throw new UpstreamError('account_missing', '关联拼多多账号不存在');
      let result;
      try {
        result = await fetchPddTrace(item, account);
      } catch (err) {
        if (err instanceof ParseError) throw new UpstreamError('pdd_order_unavailable', safeMessage(err), 409);
        if (err instanceof RateLimitedError) throw new UpstreamError('pdd_rate_limited', safeMessage(err), 429);
        if (err instanceof TimeoutError) throw new UpstreamError('pdd_trace_timeout', safeMessage(err));
        if (err instanceof RiskChallengeError || err instanceof AuthExpiredError) {
          throw new UpstreamError('pdd_verification_required', safeMessage(err), 409);
        }
        throw err;
      }
      if (!result) throw new UpstreamError('trace_failed', '拼多多轨迹获取失败，请稍后重试');
      return {
        points: toOldestFirst(result.points, 'oldest-first'),
        eta: extractEta(...result.points.map((p) => p.context)),
      };
    }
  }
}

/** 同一包裹的并发打开/刷新共用一次上游查询。 */
const pendingTraces = new Map<string, Promise<CachedTrace>>();

async function refreshTrace(item: ExpressItem, done: boolean): Promise<CachedTrace> {
  const source = item.source;
  const key = JSON.stringify([source, item.accountId, item.mailNo]);
  const pending = pendingTraces.get(key);
  if (pending) return pending;
  const task = (async () => {
    const carrier = usesCarrier(item);
    const result = carrier ? await fetchCarrierTrace(item) : await fetchFromUpstream(item);
    const { points, eta } = result;
    const newest = [...points].reverse().map(p => p.context);
    const pickupCode = pickupCodeFromParts(newest);
    const pickupCabinet = newest.map(fengchaoCabinetFrom).find(Boolean);
    if (pickupCode || pickupCabinet) updateItemFields(item.mailNo, {
      ...(pickupCode ? { pickupCode } : {}), ...(pickupCabinet ? { pickupCabinet } : {}),
    });
    const upstreamStatus = result.status ?? (source === 'pdd' ? pddStatusFromTrace(points) : null);
    const waiting = isWaitingPickup({ latestText: points.at(-1)?.context ?? '', state: upstreamStatus?.state ?? item.state, stateNum: upstreamStatus?.stateNum ?? item.stateNum });
    const status = waiting ? { state: 5, stateNum: 105, stateName: '待取件' } : upstreamStatus;
    if (carrier) updateItemFields(item.mailNo, { provider: 'kuaidi100', ...(eta ? { eta } : {}) });
    if (status) updateItemFields(item.mailNo, { ...status, latestText: points.at(-1)?.context ?? item.latestText, latestTime: points.at(-1)?.time ?? item.latestTime });
    const saved = saveTrace(item.mailNo, source, points, eta, !waiting && (status?.state === 3 || done));
    if (carrier) eventBus.publish({ type: 'item.updated', mailNo: item.mailNo });
    return saved;
  })().finally(() => pendingTraces.delete(key));
  pendingTraces.set(key, task);
  return task;
}

/**
 * 读取轨迹：命中未过期缓存直接返回，否则抓取并落库。
 * `force` 为 true 时跳过缓存（手动刷新）。
 */
export async function getItemTrace(item: ExpressItem, force = false): Promise<TraceResponse> {
  const done = isDone(item);
  const carrier = usesCarrier(item);
  if (item.source === 'manual' && !carrier) {
    if (force) throw new UpstreamError('logistics_not_configured', '请先在设置中启用快递100查询', 409);
    const previous = getTrace(item.mailNo, item.source);
    return {
      mailNo: item.mailNo,
      source: 'manual',
      points: previous?.points ?? [],
      eta: previous?.eta || item.eta,
      fetchedAt: previous?.fetchedAt ?? new Date().toISOString(),
      done: previous?.done ?? done,
      cached: Boolean(previous),
    };
  }
  const cached = getTrace(item.mailNo, item.source);

  if (!force && cached && (carrier ? Date.now() - Date.parse(cached.fetchedAt) < ((!isWaitingPickup(item) && (done || cached.done)) ? 24 * 60 * 60_000 : MIN_QUERY_MS) : cacheFresh(cached.fetchedAt, item.source, !isWaitingPickup(item) && (done || cached.done)))) {
    return {
      mailNo: item.mailNo,
      source: item.source,
      points: cached.points,
      eta: cached.eta || item.eta,
      fetchedAt: cached.fetchedAt,
      done: cached.done && !isWaitingPickup(item),
      cached: true,
    };
  }

  try {
    const saved = await refreshTrace(item, done);
    return {
      mailNo: item.mailNo,
      source: item.source,
      points: saved.points,
      eta: saved.eta || item.eta,
      fetchedAt: saved.fetchedAt,
      done: saved.done,
      cached: false,
    };
  } catch (err) {
    // 普通打开详情时保留可读轨迹；手动刷新仍明确报告失败，不伪造更新成功。
    if (force || !cached || cached.points.length === 0) throw err;
    return {
      mailNo: item.mailNo,
      source: item.source,
      points: cached.points,
      eta: cached.eta || item.eta,
      fetchedAt: cached.fetchedAt,
      done: cached.done && !isWaitingPickup(item),
      cached: true,
      stale: true,
      refreshError: safeMessage(err),
    };
  }
}

/** 详情页写回：轨迹有更新且未签收时，把最新轨迹文本回写为条目最新动态 */
export function traceLatestPoint(points: DetailPoint[]): DetailPoint | null {
  return points.length > 0 ? (points.at(-1) ?? null) : null;
}
