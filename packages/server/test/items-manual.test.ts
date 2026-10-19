import { rmSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEmptyItem, type ExpressItem } from '@ea/shared';
import { closeDb, openDb } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import {
  getItem,
  insertItem,
  listAllItems,
  replaceAllItems,
} from '../src/db/repositories/items.js';
import { mergeItems } from '../src/services/sync/merge.js';

/**
 * 手工添加快递的持久化契约：
 * - `insertItem` 强制标记 manual
 * - 全量同步（`replaceAllItems`）不会清掉渠道抓不到的 manual 条目
 * - 渠道后来抓到同单号时，真实渠道数据优先，但 manual 标记保留
 */

const DB_PATH = '/tmp/expressassistant-test/items-manual.db';

function manualItem(mailNo: string): ExpressItem {
  return createEmptyItem({
    mailNo,
    companyCode: 'SF',
    companyName: '顺丰速运',
    originalName: '顺丰速运',
    state: 0,
    stateNum: 105,
    source: 'manual',
  });
}

beforeAll(() => {
  closeDb();
  rmSync(DB_PATH, { force: true });
  openDb(DB_PATH);
  migrate();
});

afterAll(() => {
  closeDb();
  rmSync(DB_PATH, { force: true });
});

describe('手工添加快递', () => {
  it('insertItem 强制 manual=true 并落库', () => {
    const created = insertItem(manualItem('SF0000000001'));
    expect(created?.manual).toBe(true);
    expect(getItem('SF0000000001')?.manual).toBe(true);
  });

  it('重复单号返回 null（由路由转 409）', () => {
    expect(insertItem(manualItem('SF0000000001'))).toBeNull();
  });

  it('mergeItems 在渠道未返回该单号时保留手工条目', () => {
    const old = new Map(listAllItems().map((i) => [i.mailNo, i]));
    const result = mergeItems({ fresh: { jd: [] }, oldItems: old });
    expect(result.items.map((i) => i.mailNo)).toContain('SF0000000001');
    expect(result.items.find((i) => i.mailNo === 'SF0000000001')?.manual).toBe(true);
  });

  it('全量替换后手工条目仍在（渠道为空也不丢）', () => {
    const old = new Map(listAllItems().map((i) => [i.mailNo, i]));
    const merged = mergeItems({ fresh: { jd: [], taobao: [], pdd: [] }, oldItems: old });
    replaceAllItems(merged.items);
    expect(getItem('SF0000000001')?.manual).toBe(true);
  });

  it('渠道抓到同单号时渠道数据优先，manual 标记保留', () => {
    const old = new Map(listAllItems().map((i) => [i.mailNo, i]));
    const fresh = createEmptyItem({
      mailNo: 'SF0000000001',
      companyCode: 'SF',
      companyName: '顺丰速运',
      latestText: '快件已到达杭州转运中心',
      latestTime: '2026-10-18 08:00:00',
      state: 5,
      stateNum: 105,
      source: 'jd',
    });
    const result = mergeItems({ fresh: { jd: [fresh] }, oldItems: old });
    const merged = result.items.find((i) => i.mailNo === 'SF0000000001')!;
    expect(merged.latestText).toBe('快件已到达杭州转运中心');
    expect(merged.manual).toBe(true);
  });

  it('渠道再次缺失时，manual 条目仍能回到列表', () => {
    const old = new Map(listAllItems().map((i) => [i.mailNo, i]));
    const result = mergeItems({ fresh: { jd: [] }, oldItems: old });
    expect(result.items.some((i) => i.mailNo === 'SF0000000001' && i.manual)).toBe(true);
  });
});
