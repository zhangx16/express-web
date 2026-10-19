import { describe, expect, it } from 'vitest';
import {
  createEmptyItem,
  effectiveProgress,
  displayProgress,
  extractEta,
  isTransport,
  pickupCodeFrom,
  progressFor,
  progressView,
  sectionKeyOf,
  stateLabel,
  weekdayBit,
  type ExpressItem,
  type SectionKey,
} from '@ea/shared';

function item(overrides: Partial<ExpressItem>): ExpressItem {
  return createEmptyItem({ mailNo: 'TEST0001', ...overrides });
}

describe('sectionKeyOf', () => {
  it('partitionOverride 优先于一切', () => {
    expect(sectionKeyOf(item({ partitionOverride: 'abnormal', stateNum: 107, state: 3 }))).toBe(
      'abnormal',
    );
  });

  it.each([
    [105, -1, 'delivering'],
    [106, -1, 'delivering'],
    [0, 5, 'delivering'],
    [107, -1, 'done'],
    [0, 3, 'done'],
    [108, -1, 'abnormal'],
    [111, -1, 'abnormal'],
    [0, 4, 'abnormal'],
    [101, -1, 'notshipped'],
    [103, -1, 'notshipped'],
    [0, 1, 'notshipped'],
    [104, 0, 'shipped'],
    [0, 0, 'shipped'],
  ] as Array<[number, number, SectionKey]>)(
    'stateNum=%i state=%i → %s',
    (stateNum, state, expected) => {
      expect(sectionKeyOf(item({ stateNum, state }))).toBe(expected);
    },
  );

  it('106 永远落在 delivering（done 分支不可达）', () => {
    expect(sectionKeyOf(item({ stateNum: 106 }))).not.toBe('done');
  });
});

describe('isTransport', () => {
  it('done / abnormal 不在途', () => {
    expect(isTransport(item({ stateNum: 107 }))).toBe(false);
    expect(isTransport(item({ state: 3 }))).toBe(false);
    expect(isTransport(item({ stateNum: 108 }))).toBe(false);
    expect(isTransport(item({ state: 4 }))).toBe(false);
  });

  it('运输中/派送中/待发货在途', () => {
    expect(isTransport(item({ stateNum: 104 }))).toBe(true);
    expect(isTransport(item({ stateNum: 105 }))).toBe(true);
    expect(isTransport(item({ stateNum: 101 }))).toBe(true);
  });
});

describe('progressView', () => {
  it('已签收 → done，且不受手动分区影响', () => {
    expect(progressView(item({ state: 3, stateNum: 107 })).kind).toBe('done');
    expect(progressView(item({ state: 0, stateNum: 107 })).kind).toBe('done');
    // 手动把在途件拖进「已签收」分区：分区变了，进度环不能变成 100%
    expect(progressView(item({ state: 0, stateNum: 105, partitionOverride: 'done' })).kind).toBe(
      'progress',
    );
  });

  it('异常/终止不再显示 0%', () => {
    for (const stateNum of [108, 109, 110, 111]) {
      expect(progressView(item({ stateNum })).kind).toBe('abnormal');
    }
    expect(progressView(item({ state: 4 })).kind).toBe('abnormal');
  });

  it('状态未同步的手工件 → unknown 而不是 85%', () => {
    expect(progressView(item({ manual: true, state: 0, stateNum: 105, latestText: '' })).kind).toBe(
      'unknown',
    );
    // 渠道抓到数据后恢复正常进度
    expect(
      progressView(item({ manual: true, state: 0, stateNum: 105, latestText: '运输中' })),
    ).toEqual({ kind: 'progress', value: 85 });
  });

  it('createEmptyItem 初始态 → unknown', () => {
    expect(progressView(item({ state: -1, stateNum: 0 })).kind).toBe('unknown');
  });

  it('AI 进度超过 100 时截断', () => {
    expect(progressView(item({ stateNum: 104, aiProgress: 130 })).value).toBe(100);
    expect(effectiveProgress(item({ stateNum: 104, aiProgress: 130 }))).toBe(100);
  });
});

describe('progressFor / displayProgress / effectiveProgress', () => {
  it.each([
    [101, 5],
    [102, 15],
    [103, 25],
    [104, 55],
    [105, 85],
    [106, 95],
    [107, 100],
    [108, 0],
    [109, 0],
    [110, 0],
    [111, 0],
  ])('stateNum %i → %i', (stateNum, expected) => {
    expect(progressFor(item({ stateNum }))).toBe(expected);
  });

  it('state 回退映射', () => {
    expect(progressFor(item({ state: 1 }))).toBe(25);
    expect(progressFor(item({ state: 3 }))).toBe(100);
    expect(progressFor(item({ state: 5 }))).toBe(85);
    expect(progressFor(item({ state: 0 }))).toBe(55);
    expect(progressFor(item({ state: -1 }))).toBe(0);
  });

  it('已签收强制 100，忽略 AI', () => {
    expect(displayProgress(item({ state: 3, aiProgress: 42 }))).toBe(100);
  });

  it('AI 0% 只在 101..103 有效', () => {
    expect(displayProgress(item({ stateNum: 101, aiProgress: 0 }))).toBe(0);
    expect(displayProgress(item({ stateNum: 103, aiProgress: 0 }))).toBe(0);
    expect(displayProgress(item({ stateNum: 104, aiProgress: 0 }))).toBe(-1);
    expect(displayProgress(item({ stateNum: 0, aiProgress: 0 }))).toBe(-1);
  });

  it('AI 负数视为无效', () => {
    expect(displayProgress(item({ aiProgress: -1 }))).toBe(-1);
  });

  it('有效 AI 优先于规则进度', () => {
    expect(effectiveProgress(item({ stateNum: 104, aiProgress: 60 }))).toBe(60);
    expect(effectiveProgress(item({ stateNum: 104, aiProgress: -1 }))).toBe(55);
  });
});

describe('pickupCodeFrom', () => {
  it.each([
    ['您的取件码：A1234，请及时取件', 'A1234'],
    ['取货码 8-2-301', '8-2-301'],
    ['提货码:Z99881', 'Z99881'],
    ['驿站码：AB-12', 'AB-12'],
    ['取件验证码 123456', '123456'],
  ])('%s → %s', (text, expected) => {
    expect(pickupCodeFrom(text)).toBe(expected);
  });

  it('无取件码返回 null', () => {
    expect(pickupCodeFrom('包裹已签收')).toBeNull();
    expect(pickupCodeFrom('')).toBeNull();
    expect(pickupCodeFrom(null)).toBeNull();
  });

  it('单字符不匹配（至少 2 位）', () => {
    expect(pickupCodeFrom('取件码 A')).toBeNull();
  });
});

describe('extractEta', () => {
  it.each([
    ['预计10月3日送达', '10月3日送达'],
    ['【10月3日】前发货', '10月3日前发货'],
    ['10月3日送达', '10月3日送达'],
    ['预计明天送达', '明天送达'],
    ['预计 10月5日', '10月5日'],
  ])('%s → %s', (text, expected) => {
    expect(extractEta(text)).toBe(expected);
  });

  it('无 ETA 返回空串', () => {
    expect(extractEta('包裹运输中')).toBe('');
    expect(extractEta('', null, undefined)).toBe('');
  });
});

describe('stateLabel', () => {
  it('stateOverride > stateName > state 映射', () => {
    expect(stateLabel(item({ stateOverride: '手动状态', stateName: '平台状态' }))).toBe('手动状态');
    expect(stateLabel(item({ stateName: '平台状态' }))).toBe('平台状态');
    expect(stateLabel(item({ state: 3 }))).toBe('已签收');
    expect(stateLabel(item({ state: 5 }))).toBe('派送中');
    expect(stateLabel(item({ state: 9 }))).toBe('未知');
  });
});

describe('weekdayBit', () => {
  it('周一=bit0 … 周日=bit6', () => {
    // 2026-10-19 是周一
    expect(weekdayBit(new Date(2026, 9, 19))).toBe(1);
    expect(weekdayBit(new Date(2026, 9, 25))).toBe(1 << 6);
  });
});
