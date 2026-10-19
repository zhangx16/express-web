import { usesCarrier } from '../logistics/kuaidi100.js';
import { isWaitingPickup, isTransport, NOTIFICATION_BODY_MAX, type Channel, type ExpressItem } from '@ea/shared';
import { getItem, trackedTransportItems, patchItem } from '../../db/repositories/items.js';
import { getDb } from '../../db/client.js';
import { notifications } from '../../db/schema.js';
import { eventBus } from '../../events/bus.js';
import { logger } from '../../lib/logger.js';
import { sendTelegramMessage } from '../notify/telegram.js';

export interface TrackingOutcome {
  checked: number;
  notified: number;
}

function alreadySent(dedupeKey: string, channel: string): boolean {
  const row = getDb()
    .select({ id: notifications.id })
    .from(notifications)
    .all()
    .find((r) => r.id === `${dedupeKey}:${channel}`);
  return Boolean(row);
}

function recordNotification(input: {
  mailNo: string;
  title: string;
  body: string;
  dedupeKey: string;
  channel: string;
  ok: boolean;
  error?: string;
}): void {
  getDb()
    .insert(notifications)
    .values({
      id: `${input.dedupeKey}:${input.channel}`,
      mailNo: input.mailNo,
      title: input.title,
      body: input.body,
      dedupeKey: input.dedupeKey,
      channel: input.channel,
      sentAt: new Date().toISOString(),
      ok: input.ok,
      error: input.error ?? null,
    })
    .onConflictDoNothing()
    .run();
}

function notificationText(item: ExpressItem): { title: string; body: string } {
  const title = `${item.companyName} 有新动态`;
  const raw = item.latestText.trim();
  const body = (raw || '快递状态已更新').slice(0, NOTIFICATION_BODY_MAX);
  return { title, body };
}

/**
 * 追踪评估（同 Android `TrackingWorker`）：
 * - 只看 tracked 且在途的条目；
 * - 首次观测（notifiedText/notifiedTime 均空）只建立基线，不通知；
 * - latestTime 按字典序严格大于 notifiedTime 才通知（平台时间格式固定）；
 * - 去重键 mailNo + latestTime。
 */
export async function evaluateTracking(): Promise<TrackingOutcome> {
  const items = trackedTransportItems().filter(item => isTransport(item) && !isWaitingPickup(item));
  let notified = 0;

  for (const item of items) {
    const fresh = getItem(item.mailNo);
    if (!fresh) continue;

    if (fresh.notifiedText.trim() === '' && fresh.notifiedTime.trim() === '') {
      patchItem(fresh.mailNo, {
        notifiedText: fresh.latestText,
        notifiedTime: fresh.latestTime,
      });
      continue;
    }

    if (fresh.latestTime.trim() === '' || fresh.latestTime <= fresh.notifiedTime) continue;

    const dedupeKey = `${fresh.mailNo}:${fresh.latestTime}`;
    if (alreadySent(dedupeKey, 'telegram')) {
      patchItem(fresh.mailNo, {
        notifiedText: fresh.latestText,
        notifiedTime: fresh.latestTime,
      });
      continue;
    }

    const { title, body } = notificationText(fresh);
    const result = await sendTelegramMessage(`${title}\n\n${fresh.latestText}`);
    if (result.ok) {
      notified += 1;
      eventBus.publish({ type: 'notification.sent', mailNo: fresh.mailNo, title, body, channel: 'telegram' });
    } else if (result.error === 'telegram_disabled' || result.error === 'telegram_not_configured') {
      logger.debug({ mailNo: fresh.mailNo }, 'telegram not configured, skip notification');
    } else {
      logger.warn({ mailNo: fresh.mailNo, error: result.error }, 'notification failed');
    }

    // 无论成功与否都推进基线：失败重试会由下一轮新时间触发，避免同一动态刷屏
    recordNotification({
      mailNo: fresh.mailNo,
      title,
      body,
      dedupeKey,
      channel: 'telegram',
      ok: result.ok,
      ...(result.error ? { error: result.error } : {}),
    });
    patchItem(fresh.mailNo, {
      notifiedText: fresh.latestText,
      notifiedTime: fresh.latestTime,
    });
  }

  return { checked: items.length, notified };
}

/** 追踪轮询涉及的平台集合（只同步这些渠道） */
export function trackingChannels(): Channel[] {
  const set = new Set<Channel>();
  for (const item of trackedTransportItems().filter(isTransport)) {
    // 手工条目没有对应渠道，不驱动同步
    if (item.source !== 'manual' && !usesCarrier(item)) set.add(item.source);
  }
  return [...set];
}
