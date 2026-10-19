import type { ExpressItem } from '../model/item.js';
/** 无时区的物流时间按中国时间处理，缺失/无效时间排最后。 */
export function logisticsUpdatedAt(raw: string): number {
  const text = raw.trim();
  if (!text) return 0;
  const local = /^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
  const normalized = local
    ? `${local[1]}-${local[2]!.padStart(2, '0')}-${local[3]!.padStart(2, '0')}T${(local[4] ?? '00').padStart(2, '0')}:${local[5] ?? '00'}:${local[6] ?? '00'}+08:00`
    : text;
  const time = Date.parse(normalized);
  return Number.isFinite(time) ? time : 0;
}
export function compareLogisticsUpdated(a: Pick<ExpressItem, 'latestTime' | 'mailNo'>, b: Pick<ExpressItem, 'latestTime' | 'mailNo'>): number {
  return logisticsUpdatedAt(b.latestTime) - logisticsUpdatedAt(a.latestTime) || a.mailNo.localeCompare(b.mailNo);
}
