import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptyItem } from '@ea/shared';
import { closeDb, getDb, openDb } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { insertItem, updateItemFields } from '../src/db/repositories/items.js';
import { notifications } from '../src/db/schema.js';
vi.mock('../src/services/notify/telegram.js', () => ({ sendTelegramMessage: vi.fn(), telegramConfigured: vi.fn() }));
vi.mock('../src/db/repositories/settings.js', () => ({ getSettings: vi.fn(() => ({ telegramChatId: 'test-chat' })) }));
import { sendTelegramMessage, telegramConfigured } from '../src/services/notify/telegram.js';
import { notifyPendingPickups } from '../src/services/notify/pickup.js';
const pending = createEmptyItem({ mailNo: 'PICKUP123456', companyName: '顺丰速运', source: 'manual', state: 5, stateNum: 105, tracked: false, latestText: '已放入丰巢快递柜，柜号FC102，取件码123456，请及时取件' });
beforeEach(() => {
  closeDb(); openDb(':memory:'); migrate(); vi.resetAllMocks();
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-19T00:00:00Z'));
  vi.mocked(telegramConfigured).mockReturnValue(true);
  vi.mocked(sendTelegramMessage).mockResolvedValue({ ok: true });
});
afterEach(() => { closeDb(); vi.useRealTimers(); });
describe('Telegram待取件提醒', () => {
  it('未开启追踪也发送柜号、取件码、公司和运单号', async () => {
    insertItem(pending);
    expect(await notifyPendingPickups()).toMatchObject({ sent: 1 });
    const text = vi.mocked(sendTelegramMessage).mock.calls[0]![0];
    for (const field of ['FC102', '123456', '顺丰速运', 'PICKUP123456', '包裹待取件']) expect(text).toContain(field);
    expect(getDb().select().from(notifications).all()[0]?.ok).toBe(true);
  });
  it('同一取件信息即使物流时间改变也不重复推送', async () => {
    insertItem(pending); await notifyPendingPickups();
    updateItemFields(pending.mailNo, { latestTime: '2026-10-19 20:00:00' });
    await notifyPendingPickups();
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
  });
  it('先告知缺失信息，补全柜号或取件码后再次发送', async () => {
    insertItem({ ...pending, latestText: '包裹待取件' });
    await notifyPendingPickups();
    expect(vi.mocked(sendTelegramMessage).mock.calls[0]![0]).toContain('物流未提供');
    updateItemFields(pending.mailNo, { pickupCabinet: 'FC103', pickupCode: '987654' });
    await notifyPendingPickups();
    expect(sendTelegramMessage).toHaveBeenCalledTimes(2);
    expect(vi.mocked(sendTelegramMessage).mock.calls[1]![0]).toContain('987654');
  });
  it('非丰巢取件码也通知，实际领取和普通运输件不通知', async () => {
    insertItem({ ...pending, latestText: '已到菜鸟驿站，取件码8-2-301' });
    insertItem({ ...pending, mailNo: 'DONE123456', state: 3, stateNum: 107, latestText: '您的快件已领取，取件成功', pickupCode: 'oldcode', pickupCabinet: 'FC102' });
    insertItem({ ...pending, mailNo: 'MOVE123456', latestText: '运输中' });
    await notifyPendingPickups();
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sendTelegramMessage).mock.calls[0]![0]).toContain('8-2-301');
  });
  it('失败保留重试，五分钟内不重试，成功后停止', async () => {
    insertItem(pending);
    vi.mocked(sendTelegramMessage).mockResolvedValueOnce({ ok: false, error: 'network_error' });
    expect(await notifyPendingPickups()).toMatchObject({ failed: 1 });
    await notifyPendingPickups();
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5 * 60_000);
    expect(await notifyPendingPickups()).toMatchObject({ sent: 1 });
    await notifyPendingPickups();
    expect(sendTelegramMessage).toHaveBeenCalledTimes(2);
    expect(getDb().select().from(notifications).all()).toHaveLength(1);
    expect(getDb().select().from(notifications).all()[0]?.ok).toBe(true);
  });
  it('未配置时不发送也不消耗通知记录，配置后可以补发', async () => {
    insertItem(pending);
    vi.mocked(telegramConfigured).mockReturnValueOnce(false);
    await notifyPendingPickups();
    expect(sendTelegramMessage).not.toHaveBeenCalled();
    expect(getDb().select().from(notifications).all()).toHaveLength(0);
    await notifyPendingPickups();
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
  });
  it('并发检查共用一次发送', async () => {
    insertItem(pending);
    let finish!: (result: { ok: boolean }) => void;
    vi.mocked(sendTelegramMessage).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = notifyPendingPickups(); const second = notifyPendingPickups();
    expect(first).toBe(second);
    finish({ ok: true }); await Promise.all([first, second]);
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
  });
});
