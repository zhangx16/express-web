import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/**
 * 时间统一存 ISO-8601 UTC 字符串（text），与平台原始时间字符串分开：
 * latest_time 保留平台原文，latest_time_ms 仅用于排序。
 */

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    username: text('username').notNull(),
    passwordHash: text('password_hash').notNull(),
    totpSecretEnc: text('totp_secret_enc'),
    totpEnabled: integer('totp_enabled', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('users_username_uq').on(t.username)],
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** SHA-256(token)，绝不存明文 */
    tokenHash: text('token_hash').notNull(),
    userAgent: text('user_agent'),
    ip: text('ip'),
    createdAt: text('created_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    revokedAt: text('revoked_at'),
  },
  (t) => [
    uniqueIndex('sessions_token_uq').on(t.tokenHash),
    index('sessions_user_idx').on(t.userId),
    index('sessions_expires_idx').on(t.expiresAt),
  ],
);

export const accounts = sqliteTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    channel: text('channel').notNull(),
    label: text('label').notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    /** AES-256-GCM 信封：enc:v1:<keyId>:<iv>:<tag>:<ct> */
    payloadEnc: text('payload_enc').notNull(),
    /** 已脱敏，可安全展示 */
    statusDetail: text('status_detail'),
    status: text('status').notNull().default('ok'),
    lastOkAt: text('last_ok_at'),
    lastErrorAt: text('last_error_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('accounts_channel_label_uq').on(t.channel, t.label),
    index('accounts_channel_idx').on(t.channel),
  ],
);

export const items = sqliteTable(
  'items',
  {
    mailNo: text('mail_no').primaryKey(),
    companyCode: text('company_code').notNull().default(''),
    companyName: text('company_name').notNull().default(''),
    latestText: text('latest_text').notNull().default(''),
    latestTime: text('latest_time').notNull().default(''),
    latestTimeMs: integer('latest_time_ms').notNull().default(0),
    state: integer('state').notNull().default(-1),
    stateName: text('state_name').notNull().default(''),
    phone: text('phone'),
    provider: text('provider').notNull().default(''),
    stateNum: integer('state_num').notNull().default(0),
    queryChannel: text('query_channel').notNull().default(''),
    iconUrl: text('icon_url').notNull().default(''),
    originalName: text('original_name').notNull().default(''),
    eta: text('eta').notNull().default(''),
    tracked: integer('tracked', { mode: 'boolean' }).notNull().default(false),
    notifiedText: text('notified_text').notNull().default(''),
    notifiedTime: text('notified_time').notNull().default(''),
    stateOverride: text('state_override').notNull().default(''),
    partitionOverride: text('partition_override').notNull().default(''),
    aiProgress: integer('ai_progress').notNull().default(-1),
    aiEta: text('ai_eta').notNull().default(''),
    aiProgressAt: text('ai_progress_at').notNull().default(''),
    jumpLinks: text('jump_links').notNull().default(''),
    source: text('source').notNull(),
    accountId: text('account_id').notNull().default(''),
    accountLabel: text('account_label').notNull().default(''),
    addressId: text('address_id').notNull().default(''),
    pickupCode: text('pickup_code').notNull().default(''),
    pickupCabinet: text('pickup_cabinet').notNull().default(''),
    /** 用户手工添加（渠道抓取不到），同步时始终保留 */
    manual: integer('manual', { mode: 'boolean' }).notNull().default(false),
    /** 平台原始条目 JSON（可能含 PII，绝不写日志） */
    raw: text('raw'),
    firstSeenAt: text('first_seen_at').notNull(),
    lastSyncedAt: text('last_synced_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    index('items_source_idx').on(t.source),
    index('items_tracked_idx').on(t.tracked),
    index('items_account_idx').on(t.accountId),
    index('items_time_idx').on(t.latestTimeMs),
  ],
);

export const goods = sqliteTable('goods', {
  mailNo: text('mail_no').primaryKey(),
  name: text('name').notNull().default(''),
  imageUrl: text('image_url').notNull().default(''),
  count: text('count').notNull().default(''),
  shortName: text('short_name').notNull().default(''),
  updatedAt: text('updated_at').notNull(),
});

export const traces = sqliteTable(
  'traces',
  {
    id: text('id').primaryKey(),
    mailNo: text('mail_no').notNull(),
    source: text('source').notNull(),
    fetchedAt: text('fetched_at').notNull(),
    done: integer('done', { mode: 'boolean' }).notNull().default(false),
    points: text('points').notNull().default('[]'),
    eta: text('eta').notNull().default(''),
  },
  (t) => [
    uniqueIndex('traces_mail_source_uq').on(t.mailNo, t.source),
    index('traces_fetched_idx').on(t.fetchedAt),
  ],
);

export const hidden = sqliteTable(
  'hidden',
  {
    mailNo: text('mail_no').primaryKey(),
    hiddenAt: text('hidden_at').notNull(),
    /** 隐藏时条目快照 JSON，用于恢复 */
    snapshot: text('snapshot').notNull(),
  },
  (t) => [index('hidden_at_idx').on(t.hiddenAt)],
);

export const addresses = sqliteTable('addresses', {
  id: text('id').primaryKey(),
  label: text('label').notNull(),
  address: text('address').notNull(),
  active: integer('active', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const secrets = sqliteTable('secrets', {
  name: text('name').primaryKey(),
  valueEnc: text('value_enc').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const reports = sqliteTable(
  'reports',
  {
    id: text('id').primaryKey(),
    /** 本地日期 YYYY-MM-DD */
    date: text('date').notNull(),
    content: text('content').notNull(),
    delivered: integer('delivered', { mode: 'boolean' }).notNull().default(false),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('reports_date_idx').on(t.date)],
);

export const reportSchedules = sqliteTable('report_schedules', {
  id: text('id').primaryKey(),
  time: text('time').notNull(),
  repeat: integer('repeat').notNull().default(1),
  weekdays: integer('weekdays').notNull().default(0),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  lastRunAt: text('last_run_at'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const syncRuns = sqliteTable(
  'sync_runs',
  {
    id: text('id').primaryKey(),
    trigger: text('trigger').notNull(),
    status: text('status').notNull().default('running'),
    channels: text('channels').notNull().default('[]'),
    total: integer('total').notNull().default(0),
    error: text('error'),
    startedAt: text('started_at').notNull(),
    finishedAt: text('finished_at'),
  },
  (t) => [index('sync_runs_started_idx').on(t.startedAt)],
);

export const loginSessions = sqliteTable(
  'login_sessions',
  {
    id: text('id').primaryKey(),
    channel: text('channel').notNull(),
    accountId: text('account_id'),
    status: text('status').notNull().default('pending'),
    message: text('message'),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    finishedAt: text('finished_at'),
  },
  (t) => [index('login_sessions_expires_idx').on(t.expiresAt)],
);

export const notifications = sqliteTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    mailNo: text('mail_no').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    /** 去重键 mailNo + latestTime */
    dedupeKey: text('dedupe_key').notNull(),
    channel: text('channel').notNull(),
    sentAt: text('sent_at').notNull(),
    ok: integer('ok', { mode: 'boolean' }).notNull().default(true),
    error: text('error'),
  },
  (t) => [
    uniqueIndex('notifications_dedupe_uq').on(t.dedupeKey, t.channel),
    index('notifications_sent_idx').on(t.sentAt),
  ],
);

export const pushSubscriptions = sqliteTable('push_subscriptions', {
  id: text('id').primaryKey(),
  endpoint: text('endpoint').notNull(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  createdAt: text('created_at').notNull(),
});
