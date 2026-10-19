import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyItem } from '@ea/shared';
import { closeDb, openDb } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
vi.mock('../src/db/repositories/settings.js', () => ({
  getSettings: vi.fn(() => ({ kuaidi100Enabled: true, kuaidi100Customer: 'customer-test' })),
  getSecret: vi.fn(() => 'key-test'),
}));
vi.mock('../src/scrapers/pdd/trace.js', () => ({ fetchPddTrace: vi.fn() }));
import { fetchPddTrace } from '../src/scrapers/pdd/trace.js';
import { insertItem, getItem } from '../src/db/repositories/items.js';
import { getItemTrace } from '../src/services/traces/service.js';
import { getTrace } from '../src/db/repositories/traces.js';
import { getSettings } from '../src/db/repositories/settings.js';
import { carrierCode, fetchCarrierTrace, parseCarrierResponse, statusFromCode, usesCarrier } from '../src/services/logistics/kuaidi100.js';
const item = createEmptyItem({ mailNo: 'YT123456789', source: 'manual', companyName: '圆通速递' });
const result = { status: '200', state: '3', nu: item.mailNo, data: [
  { context: '已签收', time: '2026-10-19 12:00:00', ftime: '2026-10-19 12:00:00' },
  { context: '运输中', time: '2026-10-18 12:00:00' },
] };
beforeEach(() => { closeDb(); openDb(':memory:'); migrate(); vi.clearAllMocks(); });
afterEach(() => { closeDb(); vi.unstubAllGlobals(); });

describe('快递100接口', () => {
  it('按官方公式签名并仅发送所需运单资料', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => result });
    vi.stubGlobal('fetch', fetcher);
    const actual = await fetchCarrierTrace(item);
    const [url, req] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://poll.kuaidi100.com/poll/query.do');
    const body = req.body as URLSearchParams;
    const param = body.get('param')!;
    expect(JSON.parse(param)).toEqual({ com: 'yuantong', num: item.mailNo, show: '0', order: 'desc' });
    expect(body.get('sign')).toBe(createHash('md5').update(param + 'key-testcustomer-test').digest('hex').toUpperCase());
    expect(actual.points.at(-1)?.context).toBe('已签收');
    expect(actual.status).toMatchObject({ state: 3, stateNum: 107 });
  });
  it('重复请求即使强制刷新也受持久化频率限制', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => result });
    vi.stubGlobal('fetch', fetcher);
    await fetchCarrierTrace(item);
    await expect(fetchCarrierTrace(item)).rejects.toMatchObject({ code: 'logistics_rate_limited', statusCode: 429 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('网络错误不泄漏请求数据且仍限制重试', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('key-test customer-test cookie-test'));
    vi.stubGlobal('fetch', fetcher);
    await expect(fetchCarrierTrace(item)).rejects.toThrow('快递100连接失败');
    await expect(fetchCarrierTrace(item)).rejects.toMatchObject({ code: 'logistics_rate_limited' });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('中通未填手机号时不发请求，修正后可查询', async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => result });
    vi.stubGlobal('fetch', fetcher);
    await expect(fetchCarrierTrace({ ...item, companyName: '中通快递' })).rejects.toMatchObject({ code: 'logistics_phone_required' });
    expect(fetcher).not.toHaveBeenCalled();
    await fetchCarrierTrace({ ...item, companyName: '中通快递', phone: '1234' });
    expect(JSON.parse((fetcher.mock.calls[0]![1].body as URLSearchParams).get('param')!).phone).toBe('1234');
  });
  it('平台代号与订单占位号不当作承运公司或运单', () => {
    expect(carrierCode({ companyCode: 'PDD', companyName: '拼多多' })).toBeNull();
    expect(usesCarrier({ ...item, source: 'pdd', mailNo: 'PO-123456' })).toBe(false);
    expect(usesCarrier({ ...item, source: 'pdd' })).toBe(true);
  });
  it('拒绝错误运单、空轨迹和返回格式损坏', () => {
    expect(() => parseCarrierResponse({ ...result, nu: 'OTHER123456' }, item.mailNo)).toThrow('运单号不匹配');
    expect(() => parseCarrierResponse({ ...result, data: [] }, item.mailNo)).toThrow();
    expect(() => parseCarrierResponse('html', item.mailNo)).toThrow('格式异常');
  });
  it('提供可操作的错误提示，忽略上游不可信错误文本', () => {
    expect(() => parseCarrierResponse({ returnCode: '408', message: 'secret-test' }, item.mailNo)).toThrow('手机号验证失败');
    expect(() => parseCarrierResponse({ returnCode: '503' }, item.mailNo)).toThrow('Customer 和 Key');
  });
  it('签收、派件、退件和未知状态分别映射', () => {
    expect(statusFromCode('3')).toMatchObject({ state: 3 });
    expect(statusFromCode('5')).toMatchObject({ state: 5 });
    expect(statusFromCode('6')).toMatchObject({ state: 4 });
    expect(statusFromCode('unknown')).toMatchObject({ state: -1, stateNum: 0 });
  });
  it('未启用时不接管原平台查询', () => {
    vi.mocked(getSettings).mockReturnValueOnce({ kuaidi100Enabled: false } as ReturnType<typeof getSettings>);
    expect(usesCarrier({ ...item, source: 'pdd' })).toBe(false);
  });
});

it('手工运单通过统一轨迹服务落库并更新签收分类', async () => {
  const saved = insertItem(item)!;
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => result });
  vi.stubGlobal('fetch', fetcher);
  const trace = await getItemTrace(saved);
  expect(trace.done).toBe(true);
  expect(getTrace(item.mailNo, 'manual')?.points).toHaveLength(2);
  expect(getItem(item.mailNo)).toMatchObject({ state: 3, stateNum: 107, provider: 'kuaidi100', latestText: '已签收' });
  const cached = await getItemTrace(getItem(item.mailNo)!);
  expect(cached.cached).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('已有运单号的拼多多包裹不需要平台账号，失败也不触发网页登录', async () => {
  const saved = insertItem({ ...item, source: 'pdd', accountId: '' })!;
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => result }));
  expect((await getItemTrace(saved)).points).toHaveLength(2);
  await expect(getItemTrace(saved, true)).rejects.toMatchObject({ code: 'logistics_rate_limited' });
  expect(fetchPddTrace).not.toHaveBeenCalled();
});
