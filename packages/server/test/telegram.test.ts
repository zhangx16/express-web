import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('../src/db/repositories/settings.js', () => ({ getSettings: () => ({ telegramEnabled: true, telegramChatId: 'test-chat' }), getSecret: () => 'test-token' }));
import { sendTelegramMessage } from '../src/services/notify/telegram.js';
beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
afterEach(() => vi.unstubAllGlobals());
it('Telegram明确确认成功后才返回发送成功', async () => {
  vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) } as Response);
  expect(await sendTelegramMessage('test-message')).toEqual({ ok: true });
  const req = vi.mocked(fetch).mock.calls[0]![1]!;
  expect(JSON.parse(String(req.body))).toMatchObject({ chat_id: 'test-chat', text: 'test-message' });
});
it('HTTP成功但Telegram返回ok=false时按失败处理', async () => {
  vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ ok: false, description: 'Bad Request' }) } as Response);
  expect(await sendTelegramMessage('test-message')).toEqual({ ok: false, error: 'Bad Request' });
});
it('无法解析确认响应时不伪造发送成功', async () => {
  vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => { throw new Error('invalid JSON'); } } as unknown as Response);
  expect((await sendTelegramMessage('test-message')).ok).toBe(false);
});
