import { desc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import {
  sectionKeyOf,
  type Channel,
  type ExpressItem,
  type ItemsQuery,
  type SectionKey,
  SECTION_ORDER,
} from '@ea/shared';
import { getDb } from '../client.js';
import { hidden, items } from '../schema.js';
import { itemToRow, rowToItem } from '../mappers.js';

export function listAllItems(): ExpressItem[] {
  return getDb().select().from(items).all().map(rowToItem);
}

export function itemsBySource(source: Channel): ExpressItem[] {
  return getDb().select().from(items).where(eq(items.source, source)).all().map(rowToItem);
}

export function getItem(mailNo: string): ExpressItem | null {
  const row = getDb().select().from(items).where(eq(items.mailNo, mailNo)).get();
  return row ? rowToItem(row) : null;
}

export function getItemsMap(): Map<string, ExpressItem> {
  const map = new Map<string, ExpressItem>();
  for (const item of listAllItems()) map.set(item.mailNo, item);
  return map;
}

/**
 * 全量替换：写入合并后的列表并删除不再存在的条目。
 * 在单个事务中执行，避免中途失败造成半套数据。
 */
export function replaceAllItems(list: ExpressItem[]): void {
  const db = getDb();
  const now = new Date().toISOString();
  db.transaction((tx) => {
    const keep = list.map((i) => i.mailNo);
    for (const item of list) {
      const row = itemToRow(item);
      const existing = tx.select({ firstSeenAt: items.firstSeenAt }).from(items).where(eq(items.mailNo, item.mailNo)).get();
      tx.insert(items)
        .values({
          ...row,
          firstSeenAt: existing?.firstSeenAt ?? now,
          lastSyncedAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: items.mailNo,
          set: {
            companyCode: row.companyCode,
            companyName: row.companyName,
            latestText: row.latestText,
            latestTime: row.latestTime,
            latestTimeMs: row.latestTimeMs,
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
            source: row.source,
            accountId: row.accountId,
            accountLabel: row.accountLabel,
            addressId: row.addressId,
            pickupCode: row.pickupCode,
      pickupCabinet: row.pickupCabinet,
            manual: row.manual,
            lastSyncedAt: now,
            updatedAt: now,
          },
        })
        .run();
    }
    if (keep.length > 0) {
      tx.delete(items).where(notInArray(items.mailNo, keep)).run();
    } else {
      tx.delete(items).run();
    }
  });
}

/**
 * 新增单条（手工添加）：已存在则返回 null，由调用方决定报错文案。
 * 不走 `replaceAllItems`，避免同步合并前把未抓取渠道的旧数据清掉。
 */
export function insertItem(item: ExpressItem): ExpressItem | null {
  if (getItem(item.mailNo)) return null;
  const now = new Date().toISOString();
  const manual: ExpressItem = { ...item, manual: true };
  getDb()
    .insert(items)
    .values({ ...itemToRow(manual), firstSeenAt: now, lastSyncedAt: now, updatedAt: now })
    .run();
  return manual;
}

export function patchItem(mailNo: string, patch: Partial<ExpressItem>): ExpressItem | null {
  const db = getDb();
  const existing = getItem(mailNo);
  if (!existing) return null;
  const merged: ExpressItem = { ...existing, ...patch };
  if ((existing.source === 'manual' || existing.source === 'pdd') && (patch.companyName !== undefined || patch.companyCode !== undefined)) merged.provider = 'kuaidi100';
  const row = itemToRow(merged);
  db.update(items)
    .set({
      tracked: row.tracked,
      companyCode: row.companyCode,
      companyName: row.companyName,
      phone: row.phone,
      provider: row.provider,
      stateOverride: row.stateOverride,
      partitionOverride: row.partitionOverride,
      addressId: row.addressId,
      originalName: row.originalName,
      pickupCode: row.pickupCode,
      pickupCabinet: row.pickupCabinet,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(items.mailNo, mailNo))
    .run();
  return merged;
}

export function updateItemFields(mailNo: string, patch: Partial<ExpressItem>): void {
  const db = getDb();
  const row = itemToRow({ ...(getItem(mailNo) ?? { mailNo } as ExpressItem), ...patch });
  db.update(items)
    .set({ ...row, updatedAt: new Date().toISOString() })
    .where(eq(items.mailNo, mailNo))
    .run();
}

export function deleteItems(mailNos: string[]): void {
  if (mailNos.length === 0) return;
  getDb().delete(items).where(inArray(items.mailNo, mailNos)).run();
}

export function trackedTransportItems(): ExpressItem[] {
  return listAllItems().filter((i) => i.tracked);
}

export interface ItemsQueryResult {
  items: ExpressItem[];
  counts: Record<SectionKey, number>;
  syncedAt: string | null;
}

/** 查询 + 分区过滤 + 计数（在内存中做分区判定，保证与 App 规则完全一致） */
export function queryItems(query: ItemsQuery): ItemsQueryResult {
  const db = getDb();
  let list = listAllItems();

  if (query.source) list = list.filter((i) => i.source === query.source);
  if (query.accountId) list = list.filter((i) => i.accountId === query.accountId);
  if (query.tracked) list = list.filter((i) => i.tracked);

  if (query.q) {
    const q = query.q.toLowerCase();
    list = list.filter(
      (i) =>
        i.mailNo.toLowerCase().includes(q) ||
        i.companyName.toLowerCase().includes(q) ||
        i.latestText.toLowerCase().includes(q) ||
        i.originalName.toLowerCase().includes(q),
    );
  }

  if (!query.includeHidden) {
    const hiddenSet = new Set(db.select({ mailNo: hidden.mailNo }).from(hidden).all().map((r) => r.mailNo));
    list = list.filter((i) => !hiddenSet.has(i.mailNo));
  }

  const counts = Object.fromEntries(SECTION_ORDER.map((s) => [s, 0])) as Record<SectionKey, number>;
  for (const item of list) counts[sectionKeyOf(item)] += 1;

  if (query.section) list = list.filter((i) => sectionKeyOf(i) === query.section);

  list.sort((a, b) => {
    const at = parseMs(a.latestTime);
    const bt = parseMs(b.latestTime);
    if (bt !== at) return bt - at;
    return a.mailNo.localeCompare(b.mailNo);
  });

  const lastSync = db
    .select({ v: sql<string | null>`MAX(${items.lastSyncedAt})` })
    .from(items)
    .get();

  return { items: list, counts, syncedAt: lastSync?.v ?? null };
}

function parseMs(raw: string): number {
  const t = Date.parse(raw.replace(/\//g, '-'));
  return Number.isNaN(t) ? 0 : t;
}

export function listHidden(): Array<{ mailNo: string; hiddenAt: string; snapshot: ExpressItem | null }> {
  const rows = getDb().select().from(hidden).orderBy(desc(hidden.hiddenAt)).all();
  return rows.map((r) => {
    let snapshot: ExpressItem | null = null;
    try {
      snapshot = JSON.parse(r.snapshot) as ExpressItem;
    } catch {
      snapshot = null;
    }
    return { mailNo: r.mailNo, hiddenAt: r.hiddenAt, snapshot };
  });
}

export function hideItem(mailNo: string): boolean {
  const item = getItem(mailNo);
  if (!item) return false;
  const db = getDb();
  db.insert(hidden)
    .values({ mailNo, hiddenAt: new Date().toISOString(), snapshot: JSON.stringify(item) })
    .onConflictDoUpdate({
      target: hidden.mailNo,
      set: { hiddenAt: new Date().toISOString(), snapshot: JSON.stringify(item) },
    })
    .run();
  deleteItems([mailNo]);
  return true;
}

export function restoreItem(mailNo: string): ExpressItem | null {
  const db = getDb();
  const row = db.select().from(hidden).where(eq(hidden.mailNo, mailNo)).get();
  if (!row) return null;
  let item: ExpressItem | null = null;
  try {
    item = JSON.parse(row.snapshot) as ExpressItem;
  } catch {
    item = null;
  }
  db.delete(hidden).where(eq(hidden.mailNo, mailNo)).run();
  if (item) {
    const r = itemToRow(item);
    db.insert(items).values(r).onConflictDoNothing().run();
  }
  return item;
}

export function hiddenMailNos(): Set<string> {
  return new Set(getDb().select({ mailNo: hidden.mailNo }).from(hidden).all().map((r) => r.mailNo));
}
