import { eq } from 'drizzle-orm';
import type { JdGoods } from '@ea/shared';
import { getDb } from '../client.js';
import { goods } from '../schema.js';

export interface GoodsRecord extends JdGoods {
  mailNo: string;
}

/** 全部商品信息（mailNo → 商品） */
export function goodsMap(): Map<string, GoodsRecord> {
  const rows = getDb().select().from(goods).all();
  const map = new Map<string, GoodsRecord>();
  for (const row of rows) {
    map.set(row.mailNo, {
      mailNo: row.mailNo,
      name: row.name,
      imageUrl: row.imageUrl,
      count: row.count,
      shortName: row.shortName,
    });
  }
  return map;
}

export function getGoods(mailNo: string): GoodsRecord | null {
  const row = getDb().select().from(goods).where(eq(goods.mailNo, mailNo)).get();
  if (!row) return null;
  return {
    mailNo: row.mailNo,
    name: row.name,
    imageUrl: row.imageUrl,
    count: row.count,
    shortName: row.shortName,
  };
}

/**
 * 批量写入商品；与 Android `Store.jdGoods` 一致：
 * 同单号已有 shortName 时保留旧短名（AI 结果不因重抓丢失）。
 */
export function upsertGoods(entries: Map<string, JdGoods> | GoodsRecord[]): void {
  const list = entries instanceof Map ? [...entries.entries()] : entries.map((g) => [g.mailNo, g] as const);
  if (list.length === 0) return;
  const db = getDb();
  const now = new Date().toISOString();
  db.transaction((tx) => {
    for (const [mailNo, g] of list) {
      if (!mailNo) continue;
      const existing = tx
        .select({ shortName: goods.shortName })
        .from(goods)
        .where(eq(goods.mailNo, mailNo))
        .get();
      tx.insert(goods)
        .values({
          mailNo,
          name: g.name.slice(0, 500),
          imageUrl: g.imageUrl,
          count: g.count,
          shortName: existing?.shortName ?? '',
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: goods.mailNo,
          set: {
            name: g.name.slice(0, 500),
            imageUrl: g.imageUrl,
            count: g.count,
            shortName: existing?.shortName ?? '',
            updatedAt: now,
          },
        })
        .run();
    }
  });
}

/** 仅更新短名（AI 批量优化用） */
export function setShortName(mailNo: string, shortName: string): void {
  const db = getDb();
  db.update(goods)
    .set({ shortName: shortName.slice(0, 64), updatedAt: new Date().toISOString() })
    .where(eq(goods.mailNo, mailNo))
    .run();
}

export function deleteGoods(mailNo: string): void {
  getDb().delete(goods).where(eq(goods.mailNo, mailNo)).run();
}
