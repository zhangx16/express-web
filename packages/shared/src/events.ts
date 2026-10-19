import type { Channel, ExpressItem, AccountStatus } from './model/item.js';

/** 同步触发来源 */
export type SyncTrigger = 'manual' | 'schedule' | 'startup' | 'report' | 'tracking';

export type SyncChannelState = 'pending' | 'running' | 'ok' | 'failed' | 'skipped';

export interface SyncChannelProgress {
  channel: Channel;
  state: SyncChannelState;
  count: number;
  error?: string;
}

/** 远程登录会话状态 */
export type LoginSessionStatus = 'pending' | 'running' | 'ok' | 'failed' | 'cancelled' | 'expired';

export interface SyncStartedEvent {
  type: 'sync.started';
  runId: string;
  trigger: SyncTrigger;
  channels: Channel[];
  startedAt: string;
}

export interface SyncChannelStartedEvent {
  type: 'sync.channel.started';
  runId: string;
  channel: Channel;
  accountId: string;
  accountLabel: string;
}

/** 增量条目：前端按批合并进列表，不必等整轮结束 */
export interface SyncPartialEvent {
  type: 'sync.partial';
  runId: string;
  channel: Channel;
  items: ExpressItem[];
  /** 该渠道累计已抓取条数 */
  count: number;
}

export interface SyncChannelDoneEvent {
  type: 'sync.channel.done';
  runId: string;
  channel: Channel;
  state: SyncChannelState;
  count: number;
  error?: string;
  durationMs: number;
}

export interface SyncDoneEvent {
  type: 'sync.done';
  runId: string;
  total: number;
  channels: SyncChannelProgress[];
  durationMs: number;
}

export interface SyncErrorEvent {
  type: 'sync.error';
  runId: string;
  channel?: Channel;
  message: string;
  code?: string;
}

export interface AccountStatusEvent {
  type: 'account.status';
  accountId: string;
  channel: Channel;
  status: AccountStatus;
  detail: string | null;
}

export interface LoginStatusEvent {
  type: 'login.status';
  sessionId: string;
  channel: Channel;
  status: LoginSessionStatus;
  message?: string;
}

export interface NotificationSentEvent {
  type: 'notification.sent';
  mailNo: string;
  title: string;
  body: string;
  channel: 'telegram' | 'webpush';
}

export interface ReportCreatedEvent {
  type: 'report.created';
  reportId: string;
  date: string;
  summary: string;
}

/** SSE / WS 推送事件联合类型 */
export type ServerEvent =
  | { type: 'item.updated'; mailNo: string }
  | SyncStartedEvent
  | SyncChannelStartedEvent
  | SyncPartialEvent
  | SyncChannelDoneEvent
  | SyncDoneEvent
  | SyncErrorEvent
  | AccountStatusEvent
  | LoginStatusEvent
  | NotificationSentEvent
  | ReportCreatedEvent;

export type ServerEventType = ServerEvent['type'];

/** SSE 事件 id：单调递增，配合 Last-Event-ID 重放 */
export interface EventEnvelope {
  id: number;
  event: ServerEvent;
  at: string;
}
