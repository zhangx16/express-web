import { describe, expect, it, vi } from 'vitest';
import { createEmptyItem, sectionKeyOf, isTransport } from '@ea/shared';
import { parseOrder } from '../src/scrapers/pdd/list.js';
import { collectTrace, parseDomPoints, normalizePddPoints, convertPddTraces, pddOrderUrl } from '../src/scrapers/pdd/trace.js';
import { pddStatusFromText } from '../src/scrapers/pdd/status.js';
import { mergeItems } from '../src/services/sync/merge.js';

function parse(order: Record<string, unknown>) {
  const map = new Map();
  parseOrder({ order_sn: '251019-123456789', ...order }, map, new Map(), 'account', 'pdd');
  return [...map.values()][0];
}

describe('PDD authoritative order status', () => {
  it.each(['已提货', '已取件', '已签收', '妥投', '取件成功'])('%s is completed', (text) => {
    const item = parse({ order_status_prompt: text });
    expect(sectionKeyOf(item)).toBe('done');
    expect(item.stateNum).toBe(107);
  });
  it('uses a confirmed receipt timestamp instead of marketing copy', () => {
    const item = parse({ order_status_prompt: '拼过3次', receive_time: 1760000000, tracking_number: 'SF12345678' });
    expect(item.state).toBe(3);
    expect(item.stateName).toBe('已签收');
    expect(item.mailNo).toBe('SF12345678');
  });
  it('does not invent a transport state from marketing or numeric status enums', () => {
    const item = parse({ order_status_prompt: '拼过7次', order_status: 1, shipping_status: 2 });
    expect(item.state).toBe(-1);
    expect(item.stateName).toBe('状态待确认');
  });
  it('does not mark an unsigned or failed delivery as completed', () => {
    expect(pddStatusFromText('未签收')?.state).not.toBe(3);
    expect(pddStatusFromText('签收失败')?.state).toBe(4);
  });
  it('does not overwrite an explicit completed order with weaker duplicate data', () => {
    const map = new Map();
    parseOrder({ order_sn: '251019-123456789', order_status_prompt: '已签收' }, map, new Map(), '', '');
    parseOrder({ order_sn: '251019-123456789', order_status_prompt: '拼过3次' }, map, new Map(), '', '');
    expect([...map.values()][0].state).toBe(3);
  });
});

describe('PDD logistics identity and parsing', () => {
  it('rejects legacy placeholder IDs before opening an account session', () => {
    expect(() => pddOrderUrl({ mailNo: 'PDD00001', queryChannel: 'PO-12345' })).toThrow('历史记录');
    expect(pddOrderUrl({ mailNo: 'SF12345678', queryChannel: '251019-123456789' })).toContain('251019-123456789');
  });
  it('uses only matching platform order links', () => {
    const item = { mailNo: 'SF12345678', queryChannel: '251019-123456789', jumpLinks: JSON.stringify([{ link: 'https://evil.example/order.html?order_sn=251019-123456789' }]) };
    expect(pddOrderUrl(item)).toBe('https://mobile.yangkeduo.com/order.html?order_sn=251019-123456789');
  });
  it('parses inline descriptions and sorts newest-first DOM into oldest-first storage', () => {
    const raw = '已签收2026-10-19 12:30您的包裹已签收\n运输中2026/10/18 09:00包裹正在运输';
    const points = normalizePddPoints(parseDomPoints(raw));
    expect(points).toHaveLength(2);
    expect(points.at(-1)?.context).toContain('已签收');
  });
  it('ignores order creation timestamps and recommendation descriptions as trace points', () => {
    const result = convertPddTraces([{ url: '/proxy/api/order_detail_group', body: JSON.stringify({ goods_list: [{ create_time: 1760000000, title: '推荐商品' }] }) }]);
    expect(result.points).toEqual([]);
  });
  it('normalizes numeric logistics timestamps', () => {
    const result = convertPddTraces([{ url: '/proxy/api/express/traces', body: JSON.stringify({ traces: [{ time: 1760000000, desc: '包裹已签收' }] }) }]);
    expect(result.points).toHaveLength(1);
    expect(result.points[0]?.time).toMatch(/^20\d\d-/);
  });
});

it('reconciles an old order-number key with a newly discovered real tracking number', () => {
  const old = createEmptyItem({ mailNo: '251019-123456789', queryChannel: '251019-123456789', source: 'pdd', tracked: true, pickupCode: '1-2-3' });
  const fresh = { ...old, mailNo: 'SF12345678', tracked: false, pickupCode: '' };
  const result = mergeItems({ oldItems: new Map([[old.mailNo, old]]), fresh: { pdd: [fresh] } });
  expect(result.items).toHaveLength(1);
  expect(result.items[0]).toMatchObject({ mailNo: fresh.mailNo, tracked: true, pickupCode: old.pickupCode });
});

it('does not resurrect an order hidden under its old order-number key', () => {
  const fresh = createEmptyItem({ mailNo: 'SF12345678', queryChannel: '251019-123456789', source: 'pdd' });
  const result = mergeItems({ oldItems: new Map(), fresh: { pdd: [fresh] }, hiddenMailNos: new Set(['251019-123456789']) });
  expect(result.items).toEqual([]);
});


it('never clicks an unrelated package when an invalid detail redirects back to the order list', async () => {
  const page = { goto: vi.fn().mockResolvedValue(null), url: () => 'https://mobile.yangkeduo.com/orders.html', getByText: vi.fn() };
  await expect(collectTrace(page as unknown as import('playwright').Page, 'https://mobile.yangkeduo.com/order.html?order_sn=251019-123456789')).rejects.toThrow('退回列表');
  expect(page.getByText).not.toHaveBeenCalled();
});

it('collects the goods_express route even without an order keyword in its query', async () => {
  vi.useFakeTimers();
  try {
    const page = {
      goto: vi.fn().mockResolvedValue(null), url: () => 'https://mobile.yangkeduo.com/goods_express.html?shipping_id=test',
      getByText: vi.fn(() => ({ count: async () => 0 })),
      evaluate: vi.fn(async (script: unknown) => typeof script === 'function' ? false : '已签收2026-10-19 12:30您的包裹已签收'),
    };
    const result = collectTrace(page as unknown as import('playwright').Page, 'https://mobile.yangkeduo.com/order.html?order_sn=251019-123456789');
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await result)?.points.at(-1)?.context).toContain('已签收');
  } finally { vi.useRealTimers(); }
});


it('parses descriptions before timestamps and excludes recommendation text', () => {
  const raw = '订单编号: example\n收货地址: example\n您的快件已领取，感谢使用快递服务\n2026-10-16 11:49:26\n展开\n商品推荐\n券后9.9\n已签收';
  const points = parseDomPoints(raw);
  expect(points).toHaveLength(1);
  expect(points[0]?.context).toBe('您的快件已领取，感谢使用快递服务');
  expect(pddStatusFromText(points[0]!.context)?.state).toBe(3);
});

it('does not confuse courier pickup with recipient pickup', () => {
  expect(pddStatusFromText('快递员已取件，包裹即将发往下一站')?.state).toBe(2);
});


it('keeps unconfirmed PDD records out of the in-transit count and automatic polling', () => {
  const item = parse({ order_status_prompt: '拼过3次' });
  expect(isTransport(item)).toBe(false);
});


it('does not downgrade a confirmed received order back to a generic waiting-for-receipt prompt', () => {
  const old = createEmptyItem({ mailNo: 'SF12345678', queryChannel: '251019-123456789', source: 'pdd', state: 3, stateNum: 107, stateName: '已签收' });
  const fresh = { ...old, state: 2, stateNum: 104, stateName: '待收货' };
  const result = mergeItems({ oldItems: new Map([[old.mailNo, old]]), fresh: { pdd: [fresh] } });
  expect(result.items[0]).toMatchObject({ state: 3, stateNum: 107, stateName: '已签收' });
});
