import type { ExpressItem } from '@ea/shared';
import type { InferSelectModel } from 'drizzle-orm';
import type { items } from './schema.js';

type ItemRow = InferSelectModel<typeof items>;

export function rowToItem(row: ItemRow): ExpressItem {
  return {
    id: row.mailNo,
    companyCode: row.companyCode,
    companyName: row.companyName,
    mailNo: row.mailNo,
    latestText: row.latestText,
    latestTime: row.latestTime,
    state: row.state,
    stateName: row.stateName,
    phone: row.phone,
    provider: row.provider,
    stateNum: row.stateNum,
    queryChannel: row.queryChannel,
    iconUrl: row.iconUrl,
    originalName: row.originalName,
    eta: row.eta,
    tracked: row.tracked,
    notifiedText: row.notifiedText,
    notifiedTime: row.notifiedTime,
    stateOverride: row.stateOverride,
    partitionOverride: row.partitionOverride,
    aiProgress: row.aiProgress,
    aiEta: row.aiEta,
    aiProgressAt: row.aiProgressAt,
    jumpLinks: row.jumpLinks,
    source: row.source as ExpressItem['source'],
    accountId: row.accountId,
    accountLabel: row.accountLabel,
    addressId: row.addressId,
    pickupCode: row.pickupCode,
    pickupCabinet: row.pickupCabinet,
    manual: row.manual,
  };
}

export function itemToRow(item: ExpressItem): ItemRow {
  const now = new Date().toISOString();
  return {
    mailNo: item.mailNo,
    companyCode: item.companyCode,
    companyName: item.companyName,
    latestText: item.latestText,
    latestTime: item.latestTime,
    latestTimeMs: parseTimeMs(item.latestTime),
    state: item.state,
    stateName: item.stateName,
    phone: item.phone,
    provider: item.provider,
    stateNum: item.stateNum,
    queryChannel: item.queryChannel,
    iconUrl: item.iconUrl,
    originalName: item.originalName,
    eta: item.eta,
    tracked: item.tracked,
    notifiedText: item.notifiedText,
    notifiedTime: item.notifiedTime,
    stateOverride: item.stateOverride,
    partitionOverride: item.partitionOverride,
    aiProgress: item.aiProgress,
    aiEta: item.aiEta,
    aiProgressAt: item.aiProgressAt,
    jumpLinks: item.jumpLinks,
    source: item.source,
    accountId: item.accountId,
    accountLabel: item.accountLabel,
    addressId: item.addressId,
    pickupCode: item.pickupCode,
    pickupCabinet: item.pickupCabinet || '',
    manual: item.manual,
    raw: null,
    firstSeenAt: now,
    lastSyncedAt: now,
    updatedAt: now,
  };
}

/**
 * 平台时间字符串差异很大（`2026-10-18 12:30:00`、`10-18 12:30`、`今天 12:30`），
 * 仅用于列表排序：解析失败返回 0，前端仍展示原始字符串。
 */
export function parseTimeMs(raw: string): number {
  if (!raw) return 0;
  const normalized = raw.trim().replace(/\//g, '-');
  const direct = Date.parse(normalized);
  if (!Number.isNaN(direct)) return direct;

  const now = new Date();
  const hm = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(normalized);
  const timePart = hm
    ? { h: Number(hm[1]), m: Number(hm[2]), s: Number(hm[3] ?? 0) }
    : { h: 0, m: 0, s: 0 };

  const md = /(\d{1,2})-(\d{1,2})/.exec(normalized);
  if (md) {
    const d = new Date(
      now.getFullYear(),
      Number(md[1]) - 1,
      Number(md[2]),
      timePart.h,
      timePart.m,
      timePart.s,
    );
    return d.getTime();
  }
  if (normalized.includes('今天') || normalized.includes('刚刚')) {
    return new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      timePart.h,
      timePart.m,
      timePart.s,
    ).getTime();
  }
  if (normalized.includes('昨天')) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    d.setHours(timePart.h, timePart.m, timePart.s, 0);
    return d.getTime();
  }
  return 0;
}
