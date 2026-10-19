import { and, like, lt } from 'drizzle-orm';
import { getDb } from '../../db/client.js';
import { loginSessions, notifications, settings, syncRuns, traces } from '../../db/schema.js';
import { cleanupSessions } from '../../auth/session.js';

const DAY = 24 * 60 * 60 * 1000;
let lastRunDay: string | null = null;

/**
 * 每日 04:00 清理：轨迹/同步记录 30 天，会话过期，通知 90 天，登录会话过期。
 * 用本地日期去重，避免每分钟重复执行。
 */
export async function cleanupExpired(): Promise<void> {
  const now = new Date();
  const localDay = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const localHour = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false }).format(now),
  );
  if (lastRunDay === localDay || localHour !== 4) return;

  const db = getDb();
  const iso = (msAgo: number): string => new Date(Date.now() - msAgo).toISOString();

  db.delete(traces).where(lt(traces.fetchedAt, iso(30 * DAY))).run();
  db.delete(syncRuns).where(lt(syncRuns.startedAt, iso(30 * DAY))).run();
  db.delete(notifications).where(lt(notifications.sentAt, iso(90 * DAY))).run();
  db.delete(loginSessions).where(lt(loginSessions.expiresAt, iso(0))).run();
  db.delete(settings).where(and(like(settings.key, 'kuaidi100.retry.%'), lt(settings.updatedAt, iso(7 * DAY)))).run();
  cleanupSessions();

  lastRunDay = localDay;
}
