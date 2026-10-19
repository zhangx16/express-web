import type { ExpressItem } from '../model/item.js';
import { isTransport } from './sections.js';
import { extractEta } from './eta.js';

export function calendarDateKey(date = new Date(), timeZone = 'Asia/Shanghai'): string {
  if (!Number.isFinite(date.getTime())) return '';
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  } catch {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
  }
  const parts = formatter.formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function dateKey(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** 相对 ETA 基于该记录的更新时间，避免旧的“明天送达”每天向后漂移。 */
export function arrivalDateOf(item: ExpressItem, now = new Date(), timeZone = 'Asia/Shanghai'): string | null {
  if (!isTransport(item)) return null;
  for (const [text, stamp] of [[item.aiEta, item.aiProgressAt], [item.eta, item.latestTime], [extractEta(item.latestText), item.latestTime]]) {
    if (!text || (/发货/.test(text) && !/送达|到达|派送/.test(text))) continue;
    const raw = stamp || item.latestTime;
    let anchor = calendarDateKey(now, timeZone);
    const local = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(raw ?? '');
    if (local && !/(?:Z|[+-]\d{2}:?\d{2})$/.test(raw ?? '')) {
      anchor = dateKey(Number(local[1]), Number(local[2]), Number(local[3])) ?? anchor;
    } else if (raw && Number.isFinite(Date.parse(raw))) {
      anchor = calendarDateKey(new Date(raw), timeZone);
    }
    const [year = 0, month = 0, day = 0] = anchor.split('-').map(Number);
    const relative = /(今天|明天|后天)/.exec(text);
    if (relative) {
      const offset = relative[1] === '今天' ? 0 : relative[1] === '明天' ? 1 : 2;
      const date = new Date(Date.UTC(year, month - 1, day + offset));
      return dateKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
    }
    const full = /(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})/.exec(text);
    if (full) {
      const key = dateKey(Number(full[1]), Number(full[2]), Number(full[3]));
      if (key) return key;
      continue;
    }
    const short = /(\d{1,2})月(\d{1,2})日/.exec(text);
    if (short) {
      const targetMonth = Number(short[1]);
      const targetYear = year + (targetMonth < month - 6 ? 1 : targetMonth > month + 6 ? -1 : 0);
      const key = dateKey(targetYear, targetMonth, Number(short[2]));
      if (key) return key;
    }
  }
  return null;
}

/** 周一作为每周起点，包含首尾空白格。 */
export function calendarMonthCells(month: string): Array<string | null> {
  const [year = 0, index = 0] = month.split('-').map(Number);
  if (!dateKey(year, index, 1)) return [];
  const first = new Date(Date.UTC(year, index - 1, 1));
  const leading = (first.getUTCDay() + 6) % 7;
  const days = new Date(Date.UTC(year, index, 0)).getUTCDate();
  const count = Math.ceil((leading + days) / 7) * 7;
  return Array.from({ length: count }, (_, i) => i < leading || i >= leading + days ? null : dateKey(year, index, i - leading + 1));
}

export function shiftCalendarMonth(month: string, offset: number): string {
  const [year = 0, index = 0] = month.split('-').map(Number);
  const date = new Date(Date.UTC(year, index - 1 + offset, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}
