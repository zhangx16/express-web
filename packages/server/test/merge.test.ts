import { describe, expect, it } from 'vitest';
import { createEmptyItem, type Channel, type DetailPoint, type ExpressItem } from '@ea/shared';
import { applyPreservation, mergeItems } from '../src/services/sync/merge.js';

function item(mailNo: string, source: Channel, overrides: Partial<ExpressItem> = {}): ExpressItem {
  return createEmptyItem({
    mailNo,
    source,
    companyName: `${source}-company`,
    latestText: `${source}-text`,
    latestTime: '2026-10-18 10:00:00',
    stateNum: 104,
    ...overrides,
  });
}

function oldMap(...items: ExpressItem[]): Map<string, ExpressItem> {
  return new Map(items.map((i) => [i.mailNo, i]));
}

describe('mergeItems 跨渠道优先级', () => {
  it('京东 > 淘宝 > 拼多多（同单号先写入者胜出）', () => {
    const result = mergeItems({
      fresh: {
        jd: [item('M1', 'jd')],
        taobao: [item('M1', 'taobao')],
        pdd: [item('M1', 'pdd')],
      },
      oldItems: new Map(),
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.source).toBe('jd');
  });

  it('没有京东时淘宝优先，淘宝无则拼多多', () => {
    expect(
      mergeItems({
        fresh: { taobao: [item('M2', 'taobao')], pdd: [item('M2', 'pdd')] },
        oldItems: new Map(),
      }).items[0]?.source,
    ).toBe('taobao');

    expect(
      mergeItems({
        fresh: { pdd: [item('M3', 'pdd')] },
        oldItems: new Map(),
      }).items[0]?.source,
    ).toBe('pdd');
  });

  it('各渠道独立单号全部保留，counts 正确', () => {
    const result = mergeItems({
      fresh: {
        jd: [item('J1', 'jd'), item('J2', 'jd')],
        taobao: [item('T1', 'taobao')],
        pdd: [item('P1', 'pdd')],
      },
      oldItems: new Map(),
    });
    expect(result.counts).toEqual({ jd: 2, taobao: 1, pdd: 1 });
    expect(result.items).toHaveLength(4);
  });
});

describe('preserveOld 防清空', () => {
  it('渠道返回空数组时保留旧数据', () => {
    const old = oldMap(item('J1', 'jd'));
    const result = mergeItems({ fresh: { jd: [] }, oldItems: old });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.mailNo).toBe('J1');
  });

  it('渠道为 null（未抓取/失败）时保留旧数据', () => {
    const old = oldMap(item('T1', 'taobao'));
    const result = mergeItems({ fresh: { taobao: null }, oldItems: old });
    expect(result.items.map((i) => i.mailNo)).toEqual(['T1']);
  });

  it('渠道缺失（undefined）时同样保留旧数据', () => {
    const old = oldMap(item('J1', 'jd'));
    const result = mergeItems({ fresh: {}, oldItems: old });
    expect(result.items.map((i) => i.mailNo)).toEqual(['J1']);
  });

  it('新数据非空时完全替换该渠道旧数据（已不存在的单号消失）', () => {
    const old = oldMap(item('J1', 'jd'), item('J2', 'jd'));
    const result = mergeItems({ fresh: { jd: [item('J2', 'jd')] }, oldItems: old });
    expect(result.items.map((i) => i.mailNo)).toEqual(['J2']);
  });

  it('无旧数据时允许写入空结果', () => {
    const result = mergeItems({ fresh: { jd: [] }, oldItems: new Map() });
    expect(result.items).toEqual([]);
  });
});

describe('PDD 单调并集', () => {
  it('新抓数据与历史 PDD 数据取并集，不因本次缺页丢失', () => {
    const old = oldMap(item('P1', 'pdd'), item('P2', 'pdd'));
    const result = mergeItems({ fresh: { pdd: [item('P2', 'pdd')] }, oldItems: old });
    expect(result.items.map((i) => i.mailNo).sort()).toEqual(['P1', 'P2']);
  });

  it('PDD 并集不会覆盖京东/淘宝的同单号条目', () => {
    const old = oldMap(item('J1', 'jd'), item('P1', 'pdd'));
    const result = mergeItems({ fresh: { jd: [item('J1', 'jd')], pdd: [] }, oldItems: old });
    expect(result.items.find((i) => i.mailNo === 'J1')?.source).toBe('jd');
  });
});

describe('用户字段保留', () => {
  const old = item('J1', 'jd', {
    tracked: true,
    notifiedText: '已通知文案',
    notifiedTime: '2026-10-17 09:00:00',
    stateOverride: '自定义状态',
    partitionOverride: 'abnormal',
    aiProgress: 66,
    aiEta: '明天',
    aiProgressAt: '2026-10-17T00:00:00Z',
    addressId: 'addr-1',
    pickupCode: 'OLD123',
  });

  it('用户字段来自旧记录', () => {
    const fresh = item('J1', 'jd', { tracked: false, latestText: '新文案' });
    const result = mergeItems({ fresh: { jd: [fresh] }, oldItems: oldMap(old) });
    const merged = result.items[0]!;
    expect(merged.tracked).toBe(true);
    expect(merged.notifiedText).toBe('已通知文案');
    expect(merged.notifiedTime).toBe('2026-10-17 09:00:00');
    expect(merged.stateOverride).toBe('自定义状态');
    expect(merged.partitionOverride).toBe('abnormal');
    expect(merged.aiProgress).toBe(66);
    expect(merged.aiEta).toBe('明天');
    expect(merged.aiProgressAt).toBe('2026-10-17T00:00:00Z');
    expect(merged.addressId).toBe('addr-1');
    expect(merged.latestText).toBe('新文案');
  });

  it('新取件码非空则覆盖，否则保留旧值', () => {
    const withCode = applyPreservation(item('J1', 'jd', { pickupCode: 'NEW9' }), old);
    expect(withCode.pickupCode).toBe('NEW9');
    const withoutCode = applyPreservation(item('J1', 'jd', { pickupCode: '' }), old);
    expect(withoutCode.pickupCode).toBe('OLD123');
  });

  it('新条目不受影响', () => {
    const result = mergeItems({ fresh: { jd: [item('NEW', 'jd')] }, oldItems: new Map() });
    expect(result.items[0]?.tracked).toBe(false);
  });
});

describe('PDD prompt-only 保护与完成自愈', () => {
  it('状态提示文案不覆盖旧的真实轨迹文本', () => {
    const old = item('P1', 'pdd', {
      latestText: '【杭州市】快件已到达杭州转运中心',
      latestTime: '2026-10-18 08:00:00',
    });
    const fresh = item('P1', 'pdd', { latestText: '待收货', latestTime: '2026-10-18 09:00:00' });
    const merged = applyPreservation(fresh, old);
    expect(merged.latestText).toBe('【杭州市】快件已到达杭州转运中心');
    expect(merged.latestTime).toBe('2026-10-18 08:00:00');
  });

  it('非 prompt-only 文本正常覆盖', () => {
    const old = item('P1', 'pdd', { latestText: '旧轨迹' });
    const fresh = item('P1', 'pdd', { latestText: '快件已派送' });
    expect(applyPreservation(fresh, old).latestText).toBe('快件已派送');
  });

  it.each(['已评价', '交易成功', '待评价', '已完成', '已签收', '签收'])(
    'stateName 含「%s」时自愈为 state=3 / stateNum=107',
    (marker) => {
      const merged = applyPreservation(
        item('P1', 'pdd', { state: 5, stateNum: 105, stateName: marker }),
        item('P1', 'pdd'),
      );
      expect(merged.state).toBe(3);
      expect(merged.stateNum).toBe(107);
    },
  );

  it('已是完成态不重复改写', () => {
    const merged = applyPreservation(
      item('P1', 'pdd', { state: 3, stateNum: 107, stateName: '已签收' }),
      item('P1', 'pdd'),
    );
    expect(merged.state).toBe(3);
  });

  it('仅对 PDD 生效', () => {
    const merged = applyPreservation(
      item('J1', 'jd', { state: 5, stateNum: 105, stateName: '已签收' }),
      item('J1', 'jd'),
    );
    expect(merged.state).toBe(5);
  });
});

describe('隐藏过滤与取件码回填', () => {
  it('隐藏单号不复活', () => {
    const result = mergeItems({
      fresh: { jd: [item('J1', 'jd'), item('J2', 'jd')] },
      oldItems: new Map(),
      hiddenMailNos: new Set(['J2']),
    });
    expect(result.items.map((i) => i.mailNo)).toEqual(['J1']);
  });

  it('从最新文案解析取件码', () => {
    const result = mergeItems({
      fresh: { jd: [item('J1', 'jd', { latestText: '请凭取件码 12-3-45 取件' })] },
      oldItems: new Map(),
    });
    expect(result.items[0]?.pickupCode).toBe('12-3-45');
  });

  it('PDD prompt-only 时用缓存轨迹回填文案', () => {
    const traces = new Map<string, DetailPoint[]>([
      ['P1', [{ context: '快件已到达杭州转运中心', time: '2026-10-18 08:00:00', formattedTime: '' }]],
    ]);
    const result = mergeItems({
      fresh: { pdd: [item('P1', 'pdd', { latestText: '待收货', latestTime: '' })] },
      oldItems: new Map(),
      pddTraces: traces,
    });
    expect(result.items[0]?.latestText).toBe('快件已到达杭州转运中心');
    expect(result.items[0]?.latestTime).toBe('2026-10-18 08:00:00');
  });
});

it('平台同步保留用户设置的独立查件资料', () => {
  const old = item('YT123456789', 'pdd', { companyName: '圆通速递', companyCode: '', provider: 'kuaidi100', phone: '1234' });
  const fresh = item('YT123456789', 'pdd', { companyName: '拼多多', companyCode: 'PDD', phone: null });
  expect(applyPreservation(fresh, old)).toMatchObject({ companyName: '圆通速递', companyCode: '', provider: 'kuaidi100', phone: '1234' });
});
