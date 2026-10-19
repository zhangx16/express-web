import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '../client.js';
import { secrets, settings } from '../schema.js';
import { decrypt, encrypt, maskTail } from '../../lib/crypto.js';

/** 默认设置；缺省值必须与 Android 行为一致 */
export const DEFAULT_SETTINGS = {
  syncIntervalMin: 0,
  trackedPollIntervalMin: 0,
  timezone: 'Asia/Shanghai',
  kuaidi100Enabled: false,
  kuaidi100Customer: '',
  kuaidi100PollIntervalMin: 60,
  telegramEnabled: false,
  telegramChatId: '',
  webPushEnabled: false,
} as const;

export type SettingsKey = keyof typeof DEFAULT_SETTINGS;
export type SettingsValues = { [K in SettingsKey]: (typeof DEFAULT_SETTINGS)[K] };

const valueSchemas = {
  syncIntervalMin: z.coerce.number().int().min(0).max(1440),
  trackedPollIntervalMin: z.coerce.number().int().min(0).max(1440),
  timezone: z.string().min(1).max(64),
  kuaidi100Enabled: z.boolean(),
  kuaidi100Customer: z.string().trim().max(128),
  kuaidi100PollIntervalMin: z.number().int().min(31).max(1440),
  telegramEnabled: z.boolean(),
  telegramChatId: z.string().max(64),
  webPushEnabled: z.boolean(),
} satisfies Record<SettingsKey, z.ZodTypeAny>;

export function getSettings(): SettingsValues {
  const rows = getDb().select().from(settings).all();
  const result = { ...DEFAULT_SETTINGS } as SettingsValues;
  for (const row of rows) {
    const key = row.key as SettingsKey;
    if (!(key in valueSchemas)) continue;
    try {
      const parsed = valueSchemas[key].safeParse(JSON.parse(row.value));
      if (parsed.success) {
        (result as Record<string, unknown>)[key] = parsed.data;
      }
    } catch {
      // 忽略损坏值，回落默认
    }
  }
  return result;
}

export function setSetting(key: SettingsKey, value: unknown): void {
  const parsed = valueSchemas[key].safeParse(value);
  if (!parsed.success) {
    throw new Error(`设置项 ${key} 无效: ${parsed.error.issues[0]?.message ?? ''}`);
  }
  const db = getDb();
  const now = new Date().toISOString();
  db.insert(settings)
    .values({ key, value: JSON.stringify(parsed.data), updatedAt: now })
    .onConflictDoUpdate({ target: settings.key, set: { value: JSON.stringify(parsed.data), updatedAt: now } })
    .run();
}

export function getSetting<K extends SettingsKey>(key: K): SettingsValues[K] {
  return getSettings()[key];
}

// ── 密钥（只写不读） ──

export type SecretName = 'telegram_bot_token' | 'vapid_private_key' | 'local_api_token' | 'kuaidi100_key';

export function setSecret(name: SecretName, plaintext: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  const valueEnc = encrypt(plaintext);
  db.insert(secrets)
    .values({ name, valueEnc, updatedAt: now })
    .onConflictDoUpdate({ target: secrets.name, set: { valueEnc, updatedAt: now } })
    .run();
}

export function getSecret(name: SecretName): string | null {
  const row = getDb().select().from(secrets).where(eq(secrets.name, name)).get();
  if (!row) return null;
  try {
    return decrypt(row.valueEnc);
  } catch {
    return null;
  }
}

export function deleteSecret(name: SecretName): void {
  getDb().delete(secrets).where(eq(secrets.name, name)).run();
}

export function secretState(name: SecretName): { configured: boolean; maskedTail: string | null } {
  const value = getSecret(name);
  return { configured: Boolean(value), maskedTail: value ? maskTail(value) : null };
}
