import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createEmptyItem } from '@ea/shared';
vi.mock('../src/db/repositories/settings.js', () => ({ getSettings: vi.fn(), getSecret: vi.fn(() => 'test-key') }));
vi.mock('../src/db/repositories/items.js', () => ({ listAllItems: vi.fn() }));
vi.mock('../src/db/repositories/traces.js', () => ({ getTrace: vi.fn() }));
vi.mock('../src/services/traces/service.js', () => ({ getItemTrace: vi.fn() }));
vi.mock('../src/services/logistics/kuaidi100.js', () => ({ MIN_QUERY_MS: 31 * 60_000, usesCarrier: vi.fn(i => i.source === 'manual' || i.source === 'pdd') }));
vi.mock('../src/services/tracking/evaluator.js', () => ({ evaluateTracking: vi.fn() }));
import { getSettings } from '../src/db/repositories/settings.js';
import { listAllItems } from '../src/db/repositories/items.js';
import { getTrace } from '../src/db/repositories/traces.js';
import { getItemTrace } from '../src/services/traces/service.js';
import { pollCarrierTraces } from '../src/services/logistics/poll.js';
let now = Date.parse('2026-10-19T00:00:00Z');
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers(); now += 2 * 60 * 60_000; vi.setSystemTime(now);
  vi.mocked(getSettings).mockReturnValue({ kuaidi100Enabled: true, kuaidi100Customer: 'test-customer', kuaidi100PollIntervalMin: 60 } as ReturnType<typeof getSettings>);
  vi.mocked(getTrace).mockReturnValue(null);
});
afterEach(() => vi.useRealTimers());
const manual = createEmptyItem({ mailNo: 'MANUAL123456', source: 'manual', state: 0, stateNum: 104 });
it('首页同步查询未开启追踪的手工件，同时不接管淘宝京东', async () => {
  vi.mocked(listAllItems).mockReturnValue([manual, { ...manual, mailNo: 'JD123456', source: 'jd', tracked: true }, { ...manual, mailNo: 'TB123456', source: 'taobao', tracked: true }]);
  await pollCarrierTraces({ manualSync: true });
  expect(getItemTrace).toHaveBeenCalledTimes(1);
  expect(getItemTrace).toHaveBeenCalledWith(manual);
});
it('自动查询仅更新已追踪的活跃运单', async () => {
  const tracked = { ...manual, mailNo: 'TRACK123456', tracked: true };
  vi.mocked(listAllItems).mockReturnValue([manual, tracked, { ...tracked, mailNo: 'DONE123456', state: 3, stateNum: 107 }]);
  await pollCarrierTraces();
  expect(getItemTrace).toHaveBeenCalledTimes(1);
  expect(getItemTrace).toHaveBeenCalledWith(tracked);
});
it('首页同步保留31分钟缓存，过期后不受60分钟自动轮询间隔阻拦', async () => {
  vi.mocked(listAllItems).mockReturnValue([manual]);
  vi.mocked(getTrace).mockReturnValue({ points: [], eta: '', fetchedAt: new Date(now - 20 * 60_000).toISOString(), done: false });
  await pollCarrierTraces({ manualSync: true });
  expect(getItemTrace).not.toHaveBeenCalled();
  vi.mocked(getTrace).mockReturnValue({ points: [], eta: '', fetchedAt: new Date(now - 40 * 60_000).toISOString(), done: false });
  await pollCarrierTraces({ manualSync: true });
  expect(getItemTrace).toHaveBeenCalledTimes(1);
});
it('单票失败不阻断其余手工包裹更新', async () => {
  vi.mocked(listAllItems).mockReturnValue([manual, { ...manual, mailNo: 'SECOND123456' }]);
  vi.mocked(getItemTrace).mockRejectedValueOnce(new Error('upstream test'));
  await pollCarrierTraces({ manualSync: true });
  expect(getItemTrace).toHaveBeenCalledTimes(2);
});
