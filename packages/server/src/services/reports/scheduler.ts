import { REPORT_REPEAT, weekdayBitFromSunday, type ReportScheduleDto } from '@ea/shared';
import {
  enabledSchedules,
  patchSchedule,
  touchSchedule,
} from '../../db/repositories/reports.js';
import { getSettings } from '../../db/repositories/settings.js';
import { generateAndDeliver } from './generator.js';
import { logger } from '../../lib/logger.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 星期掩码，与 Android `ReportScheduler.nextTrigger` 一致 */
export function scheduleMask(schedule: Pick<ReportScheduleDto, 'repeat' | 'weekdays'>): number {
  switch (schedule.repeat) {
    case REPORT_REPEAT.WEEKDAYS:
      return 0b0011111; // 周一~周五
    case REPORT_REPEAT.WEEKENDS:
      return 0b1100000; // 周六~周日
    case REPORT_REPEAT.CUSTOM:
      return schedule.weekdays;
    case REPORT_REPEAT.ONCE:
      return 0;
    default:
      return 0b1111111;
  }
}

function zonedParts(date: Date, timeZone: string): { y: number; m: number; d: number; h: number; min: number } {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(date)) parts[p.type] = p.value;
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    h: Number(parts.hour === '24' ? '0' : parts.hour),
    min: Number(parts.minute),
  };
}

/** 指定时区中「今天 + offset 天」的该时刻对应的 UTC 毫秒 */
function zonedTimeToUtc(y: number, m: number, d: number, hour: number, minute: number, timeZone: string): number {
  // 先按 UTC 组装，再用两次采样修正时区偏移（处理 DST；Asia/Shanghai 无 DST，但保持通用）
  const guess = Date.UTC(y, m - 1, d, hour, minute, 0, 0);
  const offsetAt = (ms: number): number => {
    const parts = zonedParts(new Date(ms), timeZone);
    return Date.UTC(parts.y, parts.m - 1, parts.d, parts.h, parts.min, 0, 0) - ms;
  };
  let ts = guess - offsetAt(guess);
  ts = guess - offsetAt(ts);
  return ts;
}

/** 下一次触发时间（UTC 毫秒），语义同 Android `nextTrigger` */
export function nextTrigger(schedule: ReportScheduleDto, now = Date.now()): number {
  const timeZone = getSettings().timezone;
  const [hourStr = '0', minuteStr = '0'] = schedule.time.split(':');
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  const mask = scheduleMask(schedule);

  for (let offset = 0; offset <= 7; offset += 1) {
    const base = new Date(now + offset * DAY_MS);
    const day = zonedParts(base, timeZone);
    // 用「本地日期」构造星期：Date.UTC 的 Y/M/D 得到该本地日期的星期几（0=周日）
    const dow = new Date(Date.UTC(day.y, day.m - 1, day.d)).getUTCDay();
    const bit = weekdayBitFromSunday(dow);
    if (mask !== 0 && (mask & bit) === 0) continue;
    const t = zonedTimeToUtc(day.y, day.m, day.d, hour, minute, timeZone);
    if (t > now) return t;
  }
  return now + DAY_MS;
}

/** 到点判定：当前本地时间 >= 计划时间，且今天尚未执行 */
function isDue(schedule: ReportScheduleDto, now: Date): boolean {
  if (!schedule.enabled) return false;
  const timeZone = getSettings().timezone;
  const parts = zonedParts(now, timeZone);
  const [hourStr = '0', minuteStr = '0'] = schedule.time.split(':');
  const scheduled = Number(hourStr) * 60 + Number(minuteStr);
  const current = parts.h * 60 + parts.min;
  // 只在计划时间后的 10 分钟窗口内触发，避免服务停机后补发一整天的日报
  if (current < scheduled || current - scheduled > 10) return false;

  const mask = scheduleMask(schedule);
  const dow = new Date(Date.UTC(parts.y, parts.m - 1, parts.d)).getUTCDay();
  const bit = weekdayBitFromSunday(dow);
  if (mask !== 0 && (mask & bit) === 0) return false;

  if (!schedule.lastRunAt) return true;
  const last = new Date(schedule.lastRunAt);
  const lastDay = last.toLocaleDateString('sv-SE', { timeZone });
  const today = `${parts.y}-${String(parts.m).padStart(2, '0')}-${String(parts.d).padStart(2, '0')}`;
  return lastDay !== today;
}

let running = false;

/** 调度器每分钟调用：执行所有到点的日报计划 */
export async function runDueReportSchedules(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const now = new Date();
    for (const schedule of enabledSchedules()) {
      if (!isDue(schedule, now)) continue;
      try {
        const result = await generateAndDeliver({ syncFirst: true });
        if (result === null) {
          // 无在途件：不生成日报，但记一次执行，避免每分钟重试
          touchSchedule(schedule.id, now.toISOString());
          logger.debug({ scheduleId: schedule.id }, 'report skipped: no in-transit items');
        } else {
          touchSchedule(schedule.id, now.toISOString());
        }
        if (schedule.repeat === REPORT_REPEAT.ONCE) {
          patchSchedule(schedule.id, { enabled: false });
        }
      } catch (err) {
        logger.warn(
          { scheduleId: schedule.id, err: err instanceof Error ? err.message : 'unknown' },
          'report schedule failed',
        );
        // 失败也记录执行时间，下一分钟不重复轰炸；用户可手动重试
        touchSchedule(schedule.id, now.toISOString());
      }
    }
  } finally {
    running = false;
  }
}
