import { describe, expect, it } from 'vitest';
import { progressView, sectionKeyOf, type ExpressItem } from '@ea/shared';
import { tbItemFromParcel } from '../src/scrapers/taobao/orders.js';
import { convertCaptures } from '../src/scrapers/jd/list.js';
import { parseOrder } from '../src/scrapers/pdd/list.js';

/** 首页进度环 + 分区的组合断言：运输中必须是 55%，不能是派送中的 85% */
function expectShipping(item: ExpressItem | null): void {
  expect(item).not.toBeNull();
  const value = item as ExpressItem;
  expect(value.state).toBe(2);
  expect(value.stateNum).toBe(104);
  expect(sectionKeyOf(value)).toBe('shipped');
  expect(progressView(value)).toEqual({ kind: 'progress', value: 55 });
}

describe('淘宝列表状态映射', () => {
  it.each(['运输中', '转运中', '快件已发往下一站', '已到达济宁市', '待收货'])(
    '%s → 运输中（state 2 / 104 / 55%%）',
    (stateLabel) => {
      expectShipping(
        tbItemFromParcel(
          {
            mailNo: 'TB0001',
            cpName: '申通快递',
            stateLabel,
            latestText: '包裹已在发往下一站的路上',
            latestTime: '10-19 01:27',
            orderId: 'ORDER1',
          },
          null,
        ),
      );
    },
  );

  it('派送中 → state 5 / 105（85%）', () => {
    const item = tbItemFromParcel(
      {
        mailNo: 'TB0002',
        cpName: '申通快递',
        stateLabel: '派送中',
        latestText: '',
        latestTime: '',
        orderId: 'ORDER2',
      },
      null,
    );
    expect(item?.state).toBe(5);
    expect(item?.stateNum).toBe(105);
    expect(progressView(item as ExpressItem).value).toBe(85);
  });

  it('已签收 → done', () => {
    const item = tbItemFromParcel(
      {
        mailNo: 'TB0003',
        cpName: '申通快递',
        stateLabel: '已签收',
        latestText: '',
        latestTime: '',
        orderId: 'ORDER3',
      },
      null,
    );
    expect(item?.state).toBe(3);
    expect(progressView(item as ExpressItem).kind).toBe('done');
  });

  it('无法识别的状态兜底为运输中，而不是派送中', () => {
    const item = tbItemFromParcel(
      {
        mailNo: 'TB0004',
        cpName: '申通快递',
        stateLabel: '莫名其妙的状态',
        latestText: '',
        latestTime: '',
        orderId: 'ORDER4',
      },
      null,
    );
    expect(item?.state).toBe(0);
    expect(item?.stateNum).toBe(104);
    expect(progressView(item as ExpressItem).value).toBe(55);
  });
});

describe('京东列表状态映射', () => {
  function jdItem(statusName: string): ExpressItem | undefined {
    const body = JSON.stringify({
      body: {
        totalNum: 1,
        orderList: [
          {
            orderId: 'JD0001',
            orderStatusInfo: { orderStatusName: statusName },
            progressInfo: { content: '您的订单已出库' },
          },
        ],
      },
    });
    return convertCaptures([body], null).items[0];
  }

  it('待收货 → 运输中（55%），不再显示派送中', () => {
    expectShipping(jdItem('待收货') ?? null);
  });

  it('运输中 → 运输中（55%）', () => {
    expectShipping(jdItem('运输中') ?? null);
  });

  it('派送中 → 85%', () => {
    const item = jdItem('派送中');
    expect(item?.state).toBe(5);
    expect(item?.stateNum).toBe(105);
  });

  it('待出库仍是待发货', () => {
    const item = jdItem('待出库');
    expect(item?.state).toBe(1);
    expect(item?.stateNum).toBe(103);
  });
});

describe('拼多多列表状态映射', () => {
  function pddItem(status: string): ExpressItem | undefined {
    const byOrder = new Map<string, ExpressItem>();
    parseOrder(
      { order_sn: 'PDD0001', tracking_no: 'PDDMAIL1', order_status_prompt: status },
      byOrder,
      new Map(),
      '',
      '',
    );
    return [...byOrder.values()][0];
  }

  it('待收货 → 运输中（55%）', () => {
    expectShipping(pddItem('待收货，商品运输中') ?? null);
  });

  it('运输中 → 运输中（55%）', () => {
    expectShipping(pddItem('运输中') ?? null);
  });

  it('派送中 → 85%', () => {
    const item = pddItem('派送中');
    expect(item?.state).toBe(5);
    expect(item?.stateNum).toBe(105);
  });
});
