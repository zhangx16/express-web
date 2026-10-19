import { describe, expect, it } from 'vitest';
import { compareLogisticsUpdated, createEmptyItem, fengchaoCabinetFrom, isWaitingPickup, isTransport, pickupCodeFrom, progressView, sectionKeyOf } from '@ea/shared';

describe('物流更新时间排序', () => {
  it('跨派送/运输状态统一由近及远，空时间放最后', () => {
    const items = [
      createEmptyItem({ mailNo: 'old-delivery', state: 5, latestTime: '2026-10-18 18:00:00' }),
      createEmptyItem({ mailNo: 'missing', latestTime: '' }),
      createEmptyItem({ mailNo: 'new-shipping', state: 0, latestTime: '2026-10-19 08:00:00' }),
    ];
    expect(items.sort(compareLogisticsUpdated).map(i => i.mailNo)).toEqual(['new-shipping', 'old-delivery', 'missing']);
  });
  it('中国物流本地时间与带时区时间一致，同时间顺序稳定', () => {
    const item = (mailNo: string, latestTime: string) => ({ mailNo, latestTime });
    expect(compareLogisticsUpdated(item('A', '2026/10/19 08:00:00'), item('B', '2026-10-19T00:00:00Z'))).toBeLessThan(0);
  });
});
describe('丰巢取件信息', () => {
  it.each([
    ['您的包裹已存入丰巢快递柜，柜号：FC-102，取件码：123456，请及时取件', 'FC-102', '123456'],
    ['已放入丰巢3号柜，开柜码【A1234】', '3号柜', 'A1234'],
    ['已放入幸福小区东门丰巢快递柜，取件码：8-2-301', '幸福小区东门丰巢快递柜', '8-2-301'],
  ])('柜号与码分别提取 %s', (text, cabinet, code) => {
    expect(fengchaoCabinetFrom(text)).toBe(cabinet);
    expect(pickupCodeFrom(text)).toBe(code);
  });
  it('没有明确柜号不把取件码或普通柜名称当柜号', () => {
    expect(fengchaoCabinetFrom('已存入丰巢快递柜，取件码123456')).toBeNull();
    expect(fengchaoCabinetFrom('菜鸟驿站，柜号123，取件码456')).toBeNull();
  });
  it('投柜签收且仍要求取件时归入在途待取件，进度95%', () => {
    const item = createEmptyItem({ state: 3, stateNum: 107, latestText: '已放入丰巢快递柜，取件码123456，请及时取件' });
    expect(isWaitingPickup(item)).toBe(true);
    expect(isTransport(item)).toBe(true);
    expect(sectionKeyOf(item)).toBe('delivering');
    expect(progressView(item)).toEqual({ kind: 'progress', value: 95 });
  });
  it('实际领取后不会因历史柜号或取件码继续显示待取件', () => {
    const item = createEmptyItem({ state: 3, stateNum: 107, latestText: '您的快件已从丰巢领取，取件成功', pickupCabinet: 'FC123', pickupCode: '123456' });
    expect(isWaitingPickup(item)).toBe(false);
    expect(isTransport(item)).toBe(false);
    expect(progressView(item).kind).toBe('done');
  });
});
