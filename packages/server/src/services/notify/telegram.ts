import { getSecret, getSettings } from '../../db/repositories/settings.js';
import { logger } from '../../lib/logger.js';

export interface TelegramResult {
  ok: boolean;
  error?: string;
}

const TIMEOUT_MS = 15_000;

/**
 * Telegram Bot 推送。
 * token 只出现在请求 URL 中，错误信息只回传 Telegram 的 description，绝不回传 URL。
 */
export async function sendTelegramMessage(text: string): Promise<TelegramResult> {
  const settings = getSettings();
  if (!settings.telegramEnabled) return { ok: false, error: 'telegram_disabled' };

  const token = getSecret('telegram_bot_token');
  const chatId = settings.telegramChatId.trim();
  if (!token || !chatId) return { ok: false, error: 'telegram_not_configured' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
      signal: controller.signal,
    });
    const data = (await res.json().catch(() => null)) as { ok?: boolean; description?: string } | null;
    if (!res.ok || data?.ok !== true) {
      const error = data?.description?.slice(0, 200) ?? (res.ok ? 'Telegram未确认发送成功' : `HTTP ${res.status}`);
      return { ok: false, error };
    }
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'network_error';
    logger.warn({ err: message }, 'telegram send failed');
    return { ok: false, error: message.slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

export function telegramConfigured(): boolean {
  const settings = getSettings();
  return (
    settings.telegramEnabled &&
    settings.telegramChatId.trim() !== '' &&
    Boolean(getSecret('telegram_bot_token'))
  );
}
