import { notifyPendingPickups } from '../notify/pickup.js';
import { randomUUID } from 'node:crypto';
import type {
  Channel,
  ExpressItem,
  SyncChannelProgress,
  SyncStatusResponse,
  SyncTrigger,
} from '@ea/shared';
import { CHANNELS, isTransport, MERGE_PRIORITY } from '@ea/shared';
import { getDb } from '../../db/client.js';
import { syncRuns } from '../../db/schema.js';
import { desc, eq, ne } from 'drizzle-orm';
import { eventBus } from '../../events/bus.js';
import { getItemsMap, replaceAllItems, trackedTransportItems } from '../../db/repositories/items.js';
import { pddTracesMap } from '../../db/repositories/traces.js';
import { hiddenMailNos } from '../../db/repositories/items.js';
import { getSettings } from '../../db/repositories/settings.js';
import { enabledAccounts } from '../accounts/repo.js';
import { fetchJdOrders } from '../../scrapers/jd/list.js';
import { fetchTaobaoOrders } from '../../scrapers/taobao/orders.js';
import { fetchPddOrders } from '../../scrapers/pdd/list.js';
import { mergeItems } from './merge.js';
import { pollCarrierTraces } from '../logistics/poll.js';
import { evaluateTracking, trackingChannels } from '../tracking/evaluator.js';
import { ConflictError } from '../../http/errors.js';
import { logger } from '../../lib/logger.js';

export interface SyncOptions {
  trigger: SyncTrigger;
  /** 仅同步这些渠道（追踪轮询用）；缺省为全部启用渠道 */
  channels?: Channel[];
}

export interface SyncResult {
  runId: string;
  total: number;
  channels: SyncChannelProgress[];
  durationMs: number;
}

interface ActiveRun {
  runId: string;
  trigger: SyncTrigger;
  startedAt: string;
  channels: Channel[];
  progress: Map<Channel, SyncChannelProgress>;
}

let activeRun: ActiveRun | null = null;

export function isSyncRunning(): boolean {
  return activeRun !== null;
}

/** 最近一次已结束的同步（用于状态接口） */
function lastFinishedRun(): {
  finishedAt: string | null;
  error: string | null;
} {
  const row = getDb()
    .select()
    .from(syncRuns)
    .where(ne(syncRuns.status, 'running'))
    .orderBy(desc(syncRuns.startedAt))
    .limit(1)
    .get();
  return { finishedAt: row?.finishedAt ?? null, error: row?.error ?? null };
}

export function getSyncStatus(): SyncStatusResponse {
  if (activeRun) {
    return {
      running: true,
      runId: activeRun.runId,
      trigger: activeRun.trigger,
      startedAt: activeRun.startedAt,
      channels: [...activeRun.progress.values()],
      lastFinishedAt: lastFinishedRun().finishedAt,
      lastError: null,
    };
  }
  const last = lastFinishedRun();
  return {
    running: false,
    runId: null,
    trigger: null,
    startedAt: null,
    channels: [],
    lastFinishedAt: last.finishedAt,
    lastError: last.error,
  };
}

/** 手工/接口触发：立即返回 runId，实际同步在后台进行 */
export function startSync(opts: SyncOptions): { runId: string; channels: Channel[] } {
  if (activeRun) {
    throw new ConflictError('sync_running', '已有同步正在进行');
  }
  const channels = resolveChannels(opts.channels);
  const runId = randomUUID();
  // 先占位，避免并发请求在异步开始前再次进入
  activeRun = {
    runId,
    trigger: opts.trigger,
    startedAt: new Date().toISOString(),
    channels,
    progress: new Map(channels.map((c) => [c, { channel: c, state: 'pending', count: 0 }])),
  };
  void executeSync(runId, opts.trigger, channels).catch((err) => {
    logger.error({ err }, 'sync failed');
  });
  return { runId, channels };
}

/** 调度器/启动时调用：串行执行，运行中直接跳过 */
export async function runSync(opts: SyncOptions): Promise<SyncResult | null> {
  if (activeRun) return null;
  const channels = resolveChannels(opts.channels);
  const runId = randomUUID();
  activeRun = {
    runId,
    trigger: opts.trigger,
    startedAt: new Date().toISOString(),
    channels,
    progress: new Map(channels.map((c) => [c, { channel: c, state: 'pending', count: 0 }])),
  };
  return executeSync(runId, opts.trigger, channels);
}

function resolveChannels(requested?: Channel[]): Channel[] {
  const withAccounts = new Set(
    CHANNELS.filter((c) => enabledAccounts(c).length > 0),
  );
  if (!requested) return CHANNELS.filter((c) => withAccounts.has(c));
  return CHANNELS.filter((c) => requested.includes(c) && withAccounts.has(c));
}

async function executeSync(runId: string, trigger: SyncTrigger, channels: Channel[]): Promise<SyncResult> {
  const startedAt = activeRun?.startedAt ?? new Date().toISOString();
  const t0 = Date.now();
  const db = getDb();
  db.insert(syncRuns)
    .values({
      id: runId,
      trigger,
      status: 'running',
      channels: JSON.stringify(channels),
      startedAt,
    })
    .run();

  eventBus.publish({ type: 'sync.started', runId, trigger, channels, startedAt });

  const fresh: Partial<Record<Channel, ExpressItem[] | null>> = {};
  const errors = new Map<Channel, string>();

  try {
    for (const channel of channels) {
      const progress = activeRun?.progress.get(channel);
      if (progress) progress.state = 'running';

      if (channel === 'jd') {
        const result = await syncBrowserChannel('jd', runId, () => fetchJdOrders());
        fresh.jd = result.items;
        if (result.error) errors.set('jd', result.error);
      } else if (channel === 'taobao') {
        const result = await syncBrowserChannel('taobao', runId, () => fetchTaobaoOrders());
        fresh.taobao = result.items;
        if (result.error) errors.set('taobao', result.error);
      } else {
        const result = await syncBrowserChannel('pdd', runId, (onBatch) => fetchPddOrders(onBatch));
        fresh.pdd = result.items;
        if (result.error) errors.set('pdd', result.error);
      }
    }

    const merged = mergeItems({
      fresh,
      oldItems: getItemsMap(), // 保留抓取期间保存的查件资料、手工条目和独立物流更新。
      pddTraces: pddTracesMap(),
      hiddenMailNos: hiddenMailNos(),
    });
    replaceAllItems(merged.items);

    // 首页同步同时更新手工运单；不通过平台账号查手工件，也不绕过快递100缓存/限频。
    if (trigger === 'manual') await pollCarrierTraces({ manualSync: true });
    try { await notifyPendingPickups(); } catch { logger.warn('pickup notification evaluation failed'); }

    // 完成态：全部渠道成功 → ok；部分失败 → partial
    const progressList: SyncChannelProgress[] = [];
    for (const channel of channels) {
      const failed = errors.get(channel);
      const p = activeRun?.progress.get(channel);
      const finalState: SyncChannelProgress = {
        channel,
        state: failed ? 'failed' : 'ok',
        count: merged.counts[channel] ?? 0,
        ...(failed ? { error: failed } : {}),
      };
      if (p) Object.assign(p, finalState);
      progressList.push(finalState);
      eventBus.publish({
        type: 'sync.channel.done',
        runId,
        channel,
        state: finalState.state,
        count: finalState.count,
        ...(failed ? { error: failed } : {}),
        durationMs: Date.now() - t0,
      });
    }

    // 前端渐进更新：按合并优先级推送最终条目
    for (const channel of MERGE_PRIORITY) {
      if (!channels.includes(channel)) continue;
      const list = merged.items.filter((i) => i.source === channel);
      eventBus.publish({ type: 'sync.partial', runId, channel, items: list, count: list.length });
    }

    const durationMs = Date.now() - t0;
    const status = errors.size === 0 ? 'ok' : 'partial';
    db.update(syncRuns)
      .set({
        status,
        total: merged.items.length,
        error: errors.size > 0 ? [...errors.entries()].map(([c, e]) => `${c}: ${e}`).join('; ') : null,
        finishedAt: new Date().toISOString(),
      })
      .where(eq(syncRuns.id, runId))
      .run();

    eventBus.publish({
      type: 'sync.done',
      runId,
      total: merged.items.length,
      channels: progressList,
      durationMs,
    });

    return { runId, total: merged.items.length, channels: progressList, durationMs };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    db.update(syncRuns)
      .set({ status: 'failed', error: message, finishedAt: new Date().toISOString() })
      .where(eq(syncRuns.id, runId))
      .run();
    eventBus.publish({ type: 'sync.error', runId, message });
    throw err;
  } finally {
    activeRun = null;
  }
}

interface ChannelSyncResult {
  items: ExpressItem[] | null;
  error: string | null;
}

/**
 * 浏览器渠道：抓取器自行管理账号/context。
 * 失败时返回 null（触发 merge 的防清空逻辑），并已由抓取器更新账号状态。
 */
async function syncBrowserChannel(
  channel: 'jd' | 'taobao' | 'pdd',
  runId: string,
  fetchFn: (onBatch?: (items: ExpressItem[]) => void) => Promise<{ items: ExpressItem[] | null; error: string | null }>,
): Promise<ChannelSyncResult> {
  const accounts = enabledAccounts(channel);
  if (accounts.length === 0) return { items: null, error: null };

  eventBus.publish({
    type: 'sync.channel.started',
    runId,
    channel,
    accountId: accounts[0]!.id,
    accountLabel: accounts[0]!.label,
  });

  try {
    const onBatch = (items: ExpressItem[]): void => {
      eventBus.publish({ type: 'sync.partial', runId, channel, items, count: items.length });
    };
    return await fetchFn(channel === 'pdd' ? onBatch : undefined);
  } catch (err) {
    const message = sanitizeError(err);
    logger.warn({ channel }, 'channel sync failed');
    return { items: null, error: message };
  }
}

/** 错误信息脱敏：去掉可能的 URL 参数/长串 */
export function sanitizeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/([?&](?:token|passToken|pt_key|serviceToken|PDDAccessToken|_m_h5_tk)=)[^&\s]+/gi, '$1***')
    .slice(0, 300);
}

/**
 * 调度器入口：按设置决定是否执行周期同步。
 * 周期同步与追踪轮询互不重叠（运行中直接跳过）。
 */
export async function maybeRunPeriodicSync(): Promise<void> {
  if (activeRun) return;
  const settings = getSettings();

  if (settings.syncIntervalMin > 0) {
    const last = lastRunStartedAt();
    if (!last || Date.now() - last >= settings.syncIntervalMin * 60_000) {
      await runSync({ trigger: 'schedule' });
      return;
    }
  }

  if (settings.trackedPollIntervalMin > 0) {
    // 只有「已追踪且仍在途」的条目才驱动轮询（已签收/异常的不再刷新）
    const tracked = trackedTransportItems().filter((i) => isTransport(i));
    if (tracked.length > 0) {
      // 手工条目没有对应渠道，不驱动同步
      const sources = trackingChannels();
      if (sources.length === 0) return;
      const last = lastRunStartedAt('tracking');
      if (!last || Date.now() - last >= settings.trackedPollIntervalMin * 60_000) {
        const result = await runSync({ trigger: 'tracking', channels: sources });
        // 仅在本次轮询真正执行后评估通知（runSync 在并发时返回 null）
        if (result) {
          try {
            const outcome = await evaluateTracking();
            if (outcome.notified > 0) {
              logger.info({ checked: outcome.checked, notified: outcome.notified }, 'tracking notifications sent');
            }
          } catch (err) {
            logger.warn({ err }, 'tracking evaluation failed');
          }
        }
      }
    }
  }
}

function lastRunStartedAt(trigger?: SyncTrigger): number | null {
  const db = getDb();
  const row = trigger
    ? db.select().from(syncRuns).where(eq(syncRuns.trigger, trigger)).orderBy(desc(syncRuns.startedAt)).limit(1).get()
    : db.select().from(syncRuns).orderBy(desc(syncRuns.startedAt)).limit(1).get();
  if (!row) return null;
  const t = Date.parse(row.startedAt);
  return Number.isNaN(t) ? null : t;
}
