import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyItem } from '@ea/shared';

vi.mock('../src/services/logistics/kuaidi100.js', () => ({ usesCarrier: vi.fn(() => false), fetchCarrierTrace: vi.fn(), MIN_QUERY_MS: 31 * 60_000 }));
vi.mock('../src/db/repositories/items.js', () => ({ updateItemFields: vi.fn() }));
vi.mock('../src/db/repositories/traces.js', () => ({ getTrace: vi.fn(), saveTrace: vi.fn() }));
vi.mock('../src/services/accounts/repo.js', () => ({ getAccountRecord: vi.fn() }));
vi.mock('../src/scrapers/pdd/trace.js', () => ({ fetchPddTrace: vi.fn() }));
vi.mock('../src/scrapers/jd/track.js', () => ({ fetchJdTrack: vi.fn() }));
vi.mock('../src/scrapers/taobao/ssr.js', () => ({ fetchSsrTraces: vi.fn() }));
vi.mock('../src/scrapers/taobao/cainiao.js', () => ({ fetchCainiaoTraces: vi.fn() }));

import { fetchJdTrack } from '../src/scrapers/jd/track.js';
import { fetchSsrTraces } from '../src/scrapers/taobao/ssr.js';
import { fetchCainiaoTraces } from '../src/scrapers/taobao/cainiao.js';
import { fetchCarrierTrace } from '../src/services/logistics/kuaidi100.js';
import { updateItemFields } from '../src/db/repositories/items.js';
import { getTrace, saveTrace } from '../src/db/repositories/traces.js';
import { getAccountRecord } from '../src/services/accounts/repo.js';
import { fetchPddTrace } from '../src/scrapers/pdd/trace.js';
import { getItemTrace } from '../src/services/traces/service.js';

const points = [{ context: '运输中', time: '2026-10-18 12:00', formattedTime: '10月18日' }];
const old = { points, eta: '10月20日送达', fetchedAt: '2020-01-01T00:00:00Z', done: false };
const item = createEmptyItem({ mailNo: 'PDD123456', source: 'pdd', accountId: 'test-account', state: 0 });

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getAccountRecord).mockReturnValue({ channel: 'pdd', payload: { cookie: 'test' } } as NonNullable<ReturnType<typeof getAccountRecord>>);
  vi.mocked(saveTrace).mockImplementation((_no, _source, data, eta, done) => ({ points: data, eta, done, fetchedAt: new Date().toISOString() }));
});

describe('trace cache contracts', () => {
  it('uses the permanent cache for completed PDD items', async () => {
    vi.mocked(getTrace).mockReturnValue({ ...old, done: true });
    const response = await getItemTrace({ ...item, state: 3, stateNum: 107 });
    expect(response.cached).toBe(true);
    expect(fetchPddTrace).not.toHaveBeenCalled();
  });

  it('allows an explicit refresh even for a completed item', async () => {
    vi.mocked(getTrace).mockReturnValue({ ...old, done: true });
    vi.mocked(fetchPddTrace).mockResolvedValue({ points, goods: null });
    expect((await getItemTrace({ ...item, state: 3, stateNum: 107 }, true)).cached).toBe(false);
    expect(fetchPddTrace).toHaveBeenCalledTimes(1);
  });

  it('coalesces simultaneous requests into one upstream call and save', async () => {
    vi.mocked(getTrace).mockReturnValue(null);
    let finish!: (value: Awaited<ReturnType<typeof fetchPddTrace>>) => void;
    vi.mocked(fetchPddTrace).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const first = getItemTrace(item);
    const second = getItemTrace(item, true);
    expect(fetchPddTrace).toHaveBeenCalledTimes(1);
    finish({ points, goods: null });
    const [a, b] = await Promise.all([first, second]);
    expect(a.points).toEqual(b.points);
    expect(saveTrace).toHaveBeenCalledTimes(1);
  });

  it('returns old data with its original timestamp when a normal read cannot refresh', async () => {
    vi.mocked(getTrace).mockReturnValue(old);
    vi.mocked(fetchPddTrace).mockRejectedValue(new Error('暂时不可用'));
    const response = await getItemTrace(item);
    expect(response).toMatchObject({ cached: true, stale: true, fetchedAt: old.fetchedAt, points, refreshError: '暂时不可用' });
    expect(saveTrace).not.toHaveBeenCalled();
  });

  it('reports an explicit refresh failure and releases the coalescing slot for retries', async () => {
    vi.mocked(getTrace).mockReturnValue(old);
    vi.mocked(fetchPddTrace).mockRejectedValueOnce(new Error('暂时不可用')).mockResolvedValueOnce({ points, goods: null });
    await expect(getItemTrace(item, true)).rejects.toThrow('暂时不可用');
    expect((await getItemTrace(item, true)).cached).toBe(false);
    expect(fetchPddTrace).toHaveBeenCalledTimes(2);
  });
});


it('updates a PDD item and cache completion when the latest trace confirms recipient pickup', async () => {
  vi.mocked(getTrace).mockReturnValue(null);
  const received = [{ context: '您的快件已领取，感谢使用快递服务', time: '2026-10-19 12:00', formattedTime: '' }];
  vi.mocked(fetchPddTrace).mockResolvedValue({ points: received, goods: null });
  const response = await getItemTrace(item);
  expect(response.done).toBe(true);
  expect(updateItemFields).toHaveBeenCalledWith(item.mailNo, expect.objectContaining({ state: 3, stateNum: 107, stateName: '已签收' }));
});

it('保存丰巢柜号与取件码，投柜待取不写成已完成缓存', async () => {
  vi.mocked(getTrace).mockReturnValue(null);
  const waiting = [{ context: '已放入丰巢快递柜，柜号FC102，取件码123456，请及时取件', time: '2026-10-19 12:00', formattedTime: '' }];
  vi.mocked(fetchPddTrace).mockResolvedValue({ points: waiting, goods: null });
  const response = await getItemTrace(item);
  expect(response.done).toBe(false);
  expect(updateItemFields).toHaveBeenCalledWith(item.mailNo, expect.objectContaining({ pickupCabinet: 'FC102', pickupCode: '123456' }));
  expect(updateItemFields).toHaveBeenCalledWith(item.mailNo, expect.objectContaining({ state: 5, stateName: '待取件' }));
});

for (const channel of ['jd', 'taobao'] as const) {
  it(`${channel}使用包裹绑定账号，不转向快递100`, async () => {
    vi.mocked(getTrace).mockReturnValue(null);
    vi.mocked(getAccountRecord).mockReturnValue({ id: 'bound-account', channel, enabled: true, status: 'ok', payload: { cookie: 'bound-cookie-test' } } as NonNullable<ReturnType<typeof getAccountRecord>>);
    vi.mocked(fetchJdTrack).mockResolvedValue({ points, error: null });
    vi.mocked(fetchSsrTraces).mockResolvedValue(points);
    await getItemTrace({ ...item, source: channel, accountId: 'bound-account', queryChannel: 'order-test' }, true);
    expect(getAccountRecord).toHaveBeenCalledWith('bound-account');
    if (channel === 'jd') expect(fetchJdTrack).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'bound-account' }), 'bound-cookie-test');
    else expect(fetchSsrTraces).toHaveBeenCalledWith('bound-cookie-test', 'order-test');
    expect(fetchCarrierTrace).not.toHaveBeenCalled();
    expect(fetchPddTrace).not.toHaveBeenCalled();
  });
  it(`${channel}拒绝错误平台账号且不调用其他账号`, async () => {
    vi.mocked(getTrace).mockReturnValue(null);
    await expect(getItemTrace({ ...item, source: channel }, true)).rejects.toMatchObject({ code: 'account_channel_mismatch' });
    expect(fetchJdTrack).not.toHaveBeenCalled();
    expect(fetchSsrTraces).not.toHaveBeenCalled();
    expect(fetchCarrierTrace).not.toHaveBeenCalled();
  });
}
it('淘宝SSR未返回轨迹时，继续使用同一账号查询菜鸟', async () => {
  vi.mocked(getTrace).mockReturnValue(null);
  vi.mocked(getAccountRecord).mockReturnValue({ channel: 'taobao', enabled: true, status: 'ok', payload: { cookie: 'taobao-cookie-test' } } as NonNullable<ReturnType<typeof getAccountRecord>>);
  vi.mocked(fetchSsrTraces).mockResolvedValue(null);
  vi.mocked(fetchCainiaoTraces).mockResolvedValue(points);
  await getItemTrace({ ...item, source: 'taobao', queryChannel: 'order-test' }, true);
  expect(fetchCainiaoTraces).toHaveBeenCalledWith('taobao-cookie-test', item.mailNo);
  expect(fetchCarrierTrace).not.toHaveBeenCalled();
});
