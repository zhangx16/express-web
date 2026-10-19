import type {
  AccountStatus,
  AccountView,
  BoundAccount,
  Channel,
  ExpressDetail,
  ExpressItem,
  HomeAddress,
  ItemSource,
  JdGoods,
} from '../model/item.js';
import type { SectionKey } from '../model/item.js';
import type { SyncChannelProgress, SyncTrigger } from '../events.js';

/** 列表查询参数 */
export interface ItemsQuery {
  section?: SectionKey;
  q?: string;
  source?: ItemSource;
  tracked?: boolean;
  accountId?: string;
  includeHidden?: boolean;
}

export interface ItemsResponse {
  items: ExpressItem[];
  counts: Record<SectionKey, number>;
  syncedAt: string | null;
}

export interface ItemPatch {
  companyCode?: string;
  companyName?: string;
  phone?: string;
  tracked?: boolean;
  stateOverride?: string;
  partitionOverride?: string;
  addressId?: string;
  originalName?: string;
  pickupCode?: string;
  pickupCabinet?: string;
}

export interface TracePointDto {
  context: string;
  time: string;
  formattedTime: string;
}

export interface TraceResponse {
  mailNo: string;
  source: ItemSource;
  points: TracePointDto[];
  eta: string;
  fetchedAt: string;
  done: boolean;
  cached: boolean;
  /** 平台暂时不可用时保留的旧轨迹，不代表本次刷新成功。 */
  stale?: boolean;
  refreshError?: string;
}

export interface GoodsDto {
  mailNo: string;
  name: string;
  imageUrl: string;
  count: string;
  shortName: string;
}

export interface SyncStartResponse {
  runId: string;
  trigger: SyncTrigger;
  channels: Channel[];
}

export interface SyncStatusResponse {
  running: boolean;
  runId: string | null;
  trigger: SyncTrigger | null;
  startedAt: string | null;
  channels: SyncChannelProgress[];
  lastFinishedAt: string | null;
  lastError: string | null;
}

export interface SyncRunDto {
  id: string;
  trigger: SyncTrigger;
  status: 'running' | 'ok' | 'partial' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  total: number;
  error: string | null;
}

export type AccountDto = AccountView;

export interface AccountPatch {
  label?: string;
  enabled?: boolean;
}

export interface LoginSessionCreate {
  channel: Channel;
  /** 可选：关联已有账号（重新登录），缺省则新建 */
  accountId?: string;
  /** 可选的登录起始 URL，默认按渠道取 */
  startUrl?: string;
}

export interface LoginSessionDto {
  sessionId: string;
  channel: Channel;
  status: 'pending' | 'running' | 'ok' | 'failed' | 'cancelled' | 'expired';
  wsUrl: string;
  expiresAt: string;
  accountId: string | null;
}

export interface SecretState {
  configured: boolean;
  maskedTail: string | null;
}

export interface NotificationSettingsDto {
  telegram: { enabled: boolean; chatId: string | null; token: SecretState };
  webPush: { enabled: boolean };
}

export interface SettingsDto {
  logistics: { enabled: boolean; customer: string; pollIntervalMin: number; key: SecretState };
  syncIntervalMin: number;
  trackedPollIntervalMin: number;
  timezone: string;
  notifications: NotificationSettingsDto;
}

export interface AddressDto extends HomeAddress {
  active: boolean;
}

export interface ReportDto {
  id: string;
  date: string;
  content: string;
  createdAt: string;
  delivered: boolean;
}

export interface ReportScheduleDto {
  id: string;
  /** 本地时间 HH:mm */
  time: string;
  repeat: number;
  /** 自定义星期位掩码，仅 repeat=4 使用 */
  weekdays: number;
  enabled: boolean;
  lastRunAt: string | null;
}

export interface HealthResponse {
  ok: boolean;
  db: boolean;
  browser: 'ok' | 'starting' | 'down';
  scheduler: boolean;
  version: string;
  uptimeSec: number;
}

export interface ApiError {
  error: string;
  message: string;
  code?: string;
}

export interface AuthMeResponse {
  user: { id: string; username: string; createdAt: string } | null;
  totpEnabled: boolean;
}

export interface DetailBundle {
  detail: ExpressDetail;
  goods: GoodsDto | null;
  account: BoundAccount | null;
}
