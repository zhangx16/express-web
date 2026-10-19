import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SettingsDto } from '@ea/shared';
import {
  deleteSecret,
  getSettings,
  secretState,
  setSecret,
  setSetting,
} from '../../db/repositories/settings.js';
import { ValidationError } from '../errors.js';
import { audit } from '../../lib/audit.js';

const settingsPatchSchema = z
  .object({
    syncIntervalMin: z.number().int().min(0).max(1440).optional(),
    trackedPollIntervalMin: z.number().int().min(0).max(1440).optional(),
    timezone: z.string().min(1).max(64).optional(),
    kuaidi100Enabled: z.boolean().optional(),
    kuaidi100Customer: z.string().trim().max(128).optional(),
    kuaidi100PollIntervalMin: z.number().int().min(31).max(1440).optional(),
    telegramEnabled: z.boolean().optional(),
    telegramChatId: z.string().max(64).optional(),
    webPushEnabled: z.boolean().optional(),
  })
  .strict();

const secretSchema = z.object({
  value: z.string().min(1).max(4096),
});

function toDto(): SettingsDto {
  const s = getSettings();
  return {
    syncIntervalMin: s.syncIntervalMin,
    trackedPollIntervalMin: s.trackedPollIntervalMin,
    timezone: s.timezone,
    logistics: { enabled: s.kuaidi100Enabled, customer: s.kuaidi100Customer, pollIntervalMin: s.kuaidi100PollIntervalMin, key: secretState('kuaidi100_key') },
    notifications: {
      telegram: {
        enabled: s.telegramEnabled,
        chatId: s.telegramChatId || null,
        token: secretState('telegram_bot_token'),
      },
      webPush: { enabled: s.webPushEnabled },
    },
  };
}

/** 设置与密钥：密钥只写不读，GET 仅返回 {configured, maskedTail} */
export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/settings', async (): Promise<SettingsDto> => toDto());

  app.patch('/settings', async (req) => {
    const parsed = settingsPatchSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('设置项格式不正确');
    const patch = parsed.data;

    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      try {
        setSetting(key as Parameters<typeof setSetting>[0], value);
      } catch {
        throw new ValidationError(`设置项 ${key} 无效`);
      }
    }
    audit(req, 'settings.patch', { fields: Object.keys(patch) });
    return { settings: toDto() };
  });

  app.put('/settings/kuaidi100/key', async (req) => {
    const parsed = secretSchema.safeParse(req.body);
    if (!parsed.success || !parsed.data.value.trim()) throw new ValidationError('Key 格式不正确');
    setSecret('kuaidi100_key', parsed.data.value.trim());
    audit(req, 'settings.secret', { name: 'kuaidi100_key' });
    return { key: secretState('kuaidi100_key') };
  });
  app.delete('/settings/kuaidi100/key', async (req) => {
    deleteSecret('kuaidi100_key');
    audit(req, 'settings.secret.delete', { name: 'kuaidi100_key' });
    return { key: secretState('kuaidi100_key') };
  });

  // ── Telegram Bot Token（只写） ──
  app.put('/settings/telegram/token', async (req) => {
    const parsed = secretSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Bot Token 格式不正确');
    setSecret('telegram_bot_token', parsed.data.value.trim());
    audit(req, 'settings.secret', { name: 'telegram_bot_token' });
    return { token: secretState('telegram_bot_token') };
  });

  app.delete('/settings/telegram/token', async (req) => {
    deleteSecret('telegram_bot_token');
    audit(req, 'settings.secret.delete', { name: 'telegram_bot_token' });
    return { token: secretState('telegram_bot_token') };
  });

  // ── 本地 API Token（供 /api/v1 与 MCP 使用） ──
  app.put('/settings/local-api/token', async (req) => {
    const parsed = secretSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('Token 格式不正确');
    setSecret('local_api_token', parsed.data.value.trim());
    audit(req, 'settings.secret', { name: 'local_api_token' });
    return { token: secretState('local_api_token') };
  });

  app.delete('/settings/local-api/token', async (req) => {
    deleteSecret('local_api_token');
    audit(req, 'settings.secret.delete', { name: 'local_api_token' });
    return { token: secretState('local_api_token') };
  });

  app.get('/settings/local-api/token', async () => ({ token: secretState('local_api_token') }));
}
