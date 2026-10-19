import type { BrowserContext } from 'playwright';
import { and, eq } from 'drizzle-orm';
import type { AccountStatus, AccountView, Channel } from '@ea/shared';
import { getDb } from '../../db/client.js';
import { accounts } from '../../db/schema.js';
import { decryptJson, encryptJson, randomToken } from '../../lib/crypto.js';
import { eventBus } from '../../events/bus.js';
import { ConflictError, NotFoundError } from '../../http/errors.js';

/** 各渠道凭据结构（整体加密存储，绝不进日志/响应） */
export interface CookieAccountPayload {
  /** 完整 Cookie 头（平台登录态） */
  cookie: string;
  /** 京东 pt_pin / 淘宝 unb / 拼多多 pdduid 等展示标识 */
  identity?: string;
  /** 拼多多完整浏览器登录态，随 Cookie 一起加密保存，不向客户端暴露。 */
  browserState?: Awaited<ReturnType<BrowserContext['storageState']>>;
  /** 人工验证入口及平台限流冷却，只在加密凭据中保存。 */
  verificationUrl?: string;
  pddRetryAfter?: string;
}

export type AccountPayload = CookieAccountPayload;

export interface AccountRecord extends AccountView {
  payload: AccountPayload;
}

function rowToView(row: typeof accounts.$inferSelect): AccountView {
  return {
    id: row.id,
    channel: row.channel as Channel,
    label: row.label,
    enabled: row.enabled,
    status: row.status as AccountStatus,
    statusDetail: row.statusDetail,
    lastOkAt: row.lastOkAt,
    lastErrorAt: row.lastErrorAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function listAccounts(channel?: Channel): AccountView[] {
  const rows = channel
    ? getDb().select().from(accounts).where(eq(accounts.channel, channel)).all()
    : getDb().select().from(accounts).all();
  return rows.map(rowToView).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** 启用中的账号（抓取用，按创建时间保证"先绑定账号优先"） */
export function enabledAccounts(channel: Channel): AccountRecord[] {
  return getDb()
    .select()
    .from(accounts)
    .where(and(eq(accounts.channel, channel), eq(accounts.enabled, true)))
    .all()
    .map(rowToRecord)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getAccount(id: string): AccountView | null {
  const row = getDb().select().from(accounts).where(eq(accounts.id, id)).get();
  return row ? rowToView(row) : null;
}

export function getAccountRecord(id: string): AccountRecord | null {
  const row = getDb().select().from(accounts).where(eq(accounts.id, id)).get();
  return row ? rowToRecord(row) : null;
}

function rowToRecord(row: typeof accounts.$inferSelect): AccountRecord {
  let payload: AccountPayload;
  try {
    payload = decryptJson<AccountPayload>(row.payloadEnc);
  } catch {
    // 主密钥变更/损坏：凭据不可读，按需重新登录处理
    payload = { cookie: '' };
  }
  return { ...rowToView(row), payload };
}

export function findAccountByLabel(channel: Channel, label: string): AccountView | null {
  const row = getDb()
    .select()
    .from(accounts)
    .where(and(eq(accounts.channel, channel), eq(accounts.label, label)))
    .get();
  return row ? rowToView(row) : null;
}

export interface UpsertAccountInput {
  channel: Channel;
  label: string;
  payload: AccountPayload;
  enabled?: boolean;
}

/** 新建或覆盖同渠道同标签账号（重新登录时复用 id） */
export function upsertAccount(input: UpsertAccountInput): AccountView {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = db
    .select()
    .from(accounts)
    .where(and(eq(accounts.channel, input.channel), eq(accounts.label, input.label)))
    .get();

  const payloadEnc = encryptJson(input.payload);
  if (existing) {
    db.update(accounts)
      .set({
        payloadEnc,
        enabled: input.enabled ?? existing.enabled,
        status: 'ok',
        statusDetail: null,
        lastOkAt: now,
        updatedAt: now,
      })
      .where(eq(accounts.id, existing.id))
      .run();
    const view = getAccount(existing.id);
    if (!view) throw new NotFoundError('账号不存在');
    eventBus.publish({
      type: 'account.status',
      accountId: view.id,
      channel: view.channel,
      status: view.status,
      detail: view.statusDetail,
    });
    return view;
  }

  const id = randomToken(12);
  db.insert(accounts)
    .values({
      id,
      channel: input.channel,
      label: input.label,
      enabled: input.enabled ?? true,
      payloadEnc,
      status: 'ok',
      statusDetail: null,
      lastOkAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const view = getAccount(id);
  if (!view) throw new ConflictError('account_create_failed', '账号创建失败');
  eventBus.publish({
    type: 'account.status',
    accountId: view.id,
    channel: view.channel,
    status: view.status,
    detail: null,
  });
  return view;
}

export function patchAccount(
  id: string,
  patch: { label?: string; enabled?: boolean },
): AccountView {
  const existing = getAccount(id);
  if (!existing) throw new NotFoundError('账号不存在');
  if (patch.label && patch.label !== existing.label) {
    const dup = findAccountByLabel(existing.channel, patch.label);
    if (dup && dup.id !== id) throw new ConflictError('account_label_exists', '该渠道下已有同名账号');
  }
  const db = getDb();
  const next = {
    label: patch.label ?? existing.label,
    enabled: patch.enabled ?? existing.enabled,
    updatedAt: new Date().toISOString(),
  };
  // 禁用即视为 disabled 状态；重新启用回到 ok（下次同步会再验证）
  const status: AccountStatus = next.enabled ? (existing.status === 'disabled' ? 'ok' : existing.status) : 'disabled';
  db.update(accounts).set({ ...next, status }).where(eq(accounts.id, id)).run();
  const view = getAccount(id);
  if (!view) throw new NotFoundError('账号不存在');
  eventBus.publish({
    type: 'account.status',
    accountId: view.id,
    channel: view.channel,
    status: view.status,
    detail: view.statusDetail,
  });
  return view;
}

export function updateAccountPayload(id: string, payload: AccountPayload): void {
  const db = getDb();
  db.update(accounts)
    .set({ payloadEnc: encryptJson(payload), updatedAt: new Date().toISOString() })
    .where(eq(accounts.id, id))
    .run();
}

export function deleteAccount(id: string): void {
  const existing = getAccount(id);
  if (!existing) throw new NotFoundError('账号不存在');
  getDb().delete(accounts).where(eq(accounts.id, id)).run();
}

/** 更新账号状态并广播（statusDetail 必须已脱敏） */
export function setAccountStatus(
  id: string,
  status: AccountStatus,
  detail: string | null = null,
): void {
  const existing = getAccount(id);
  if (!existing) return;
  const now = new Date().toISOString();
  getDb()
    .update(accounts)
    .set({
      status,
      statusDetail: detail,
      updatedAt: now,
      ...(status === 'ok' ? { lastOkAt: now } : {}),
      ...(status === 'error' || status === 'challenge' || status === 'needs_login'
        ? { lastErrorAt: now }
        : {}),
    })
    .where(eq(accounts.id, id))
    .run();
  eventBus.publish({
    type: 'account.status',
    accountId: id,
    channel: existing.channel,
    status,
    detail,
  });
}
