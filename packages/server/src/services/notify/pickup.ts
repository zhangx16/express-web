import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { isWaitingPickup, pickupCabinetFrom, pickupCodeFrom, type ExpressItem } from '@ea/shared';
import { listAllItems, getItem } from '../../db/repositories/items.js';
import { getSettings } from '../../db/repositories/settings.js';
import { getDb } from '../../db/client.js';
import { notifications } from '../../db/schema.js';
import { eventBus } from '../../events/bus.js';
import { sendTelegramMessage, telegramConfigured } from './telegram.js';

const RETRY_MS = 5 * 60_000;
export interface PickupNotificationOutcome { checked: number; sent: number; failed: number }

export function pickupMessage(item: ExpressItem): { text: string; cabinet: string; code: string } {
  const cabinet = item.pickupCabinet || pickupCabinetFrom(item.latestText) || '';
  const code = item.pickupCode || pickupCodeFrom(item.latestText) || '';
  return { cabinet, code, text: [
    '📦 包裹待取件',
    `快递公司：${item.companyName || '未提供'}`,
    `运单号：${item.mailNo}`,
    ...(item.originalName && item.originalName !== item.companyName ? [`包裹备注：${item.originalName.slice(0, 200)}`] : []),
    `柜号 / 位置：${cabinet || '物流未提供，请查看取件通知'}`,
    `取件码：${code || '物流未提供，请查看取件通知'}`,
    ...(item.latestText ? [`最新动态：${item.latestText.slice(0, 500)}`] : []),
  ].join('\n') };
}

let inFlight: Promise<PickupNotificationOutcome> | null = null;
/** 待取件提醒覆盖全部未隐藏包裹，独立于追踪开关。 */
export function notifyPendingPickups(): Promise<PickupNotificationOutcome> {
  if (inFlight) return inFlight;
  inFlight = notify().finally(() => { inFlight = null; });
  return inFlight;
}

async function notify(): Promise<PickupNotificationOutcome> {
  const outcome = { checked: 0, sent: 0, failed: 0 };
  if (!telegramConfigured()) return outcome;
  const destination = getSettings().telegramChatId.trim();
  for (const candidate of listAllItems()) {
    const item = getItem(candidate.mailNo);
    if (!item || !isWaitingPickup(item)) continue;
    outcome.checked++;
    const { text, cabinet, code } = pickupMessage(item);
    // 时间变化不重发；柜号/码补全时重发，修改接收目标后也能收到。
    const digest = createHash('sha256').update(JSON.stringify([destination, cabinet, code])).digest('hex');
    const dedupeKey = `pickup:${item.mailNo}:${digest}`;
    const id = `${dedupeKey}:telegram`;
    const previous = getDb().select().from(notifications).where(eq(notifications.id, id)).get();
    if (previous?.ok) continue;
    if (previous && Date.now() - Date.parse(previous.sentAt) < RETRY_MS) continue;
    const result = await sendTelegramMessage(text);
    // 配置在发送前被关闭或删除时，不占用去重记录。
    if (result.error === 'telegram_disabled' || result.error === 'telegram_not_configured') break;
    const payload = {
      id, mailNo: item.mailNo, title: '包裹待取件', body: text, dedupeKey, channel: 'telegram',
      sentAt: new Date().toISOString(), ok: result.ok, error: result.error ?? null,
    };
    getDb().insert(notifications).values(payload).onConflictDoUpdate({ target: notifications.id, set: payload }).run();
    if (result.ok) {
      outcome.sent++;
      eventBus.publish({ type: 'notification.sent', mailNo: item.mailNo, title: '包裹待取件', body: text, channel: 'telegram' });
    } else outcome.failed++;
    // 限制单轮发送量，余下包裹在下一次检查继续。
    if (outcome.sent + outcome.failed >= 20) break;
  }
  return outcome;
}
