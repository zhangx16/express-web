/** 可登录/同步的渠道 */
export type Channel = 'jd' | 'taobao' | 'pdd';

export const CHANNELS: readonly Channel[] = ['jd', 'taobao', 'pdd'] as const;

/** 条目来源：渠道同步，或用户手工添加 */
export type ItemSource = Channel | 'manual';

export const CHANNEL_NAMES: Record<ItemSource, string> = {
  jd: '京东',
  taobao: '淘宝',
  pdd: '拼多多',
  manual: '手工',
};

/** 合并优先级：先写入者胜出（京东 > 淘宝 > 拼多多） */
export const MERGE_PRIORITY: readonly Channel[] = ['jd', 'taobao', 'pdd'] as const;

export interface JumpLink {
  link: string;
  type: string;
}

export interface JdGoods {
  name: string;
  imageUrl: string;
  count: string;
  /** AI 优化后的短名（厂商+产品名，卡片一行） */
  shortName: string;
}

/** 与 Android ExpressItem 字段一一对应 */
export interface ExpressItem {
  id: string;
  companyCode: string;
  companyName: string;
  mailNo: string;
  latestText: string;
  latestTime: string;
  state: number;
  stateName: string;
  phone: string | null;
  provider: string;
  stateNum: number;
  queryChannel: string;
  iconUrl: string;
  originalName: string;
  eta: string;
  tracked: boolean;
  notifiedText: string;
  notifiedTime: string;
  stateOverride: string;
  partitionOverride: string;
  aiProgress: number;
  aiEta: string;
  aiProgressAt: string;
  /** JSON 字符串（保持与 App 一致），Web 侧用 parseJumpLinks 解析 */
  jumpLinks: string;
  source: ItemSource;
  accountId: string;
  accountLabel: string;
  addressId: string;
  pickupCode: string;
  pickupCabinet: string;
  /** 用户手工添加（渠道列表里没有），同步时不会被清空 */
  manual: boolean;
}

export interface DetailPoint {
  context: string;
  time: string;
  formattedTime: string;
}

export interface ExpressDetail {
  mailNo: string;
  companyName: string;
  state: number;
  /** 与 state 配套的平台状态码（107=签收、108..111=终止） */
  stateNum: number;
  isReceived: boolean;
  data: DetailPoint[];
  eta: string;
}

export interface BoundAccount {
  id: string;
  label: string;
  enabled: boolean;
  channel: Channel;
  /** 平台私有 JSON（服务端加密存储，绝不出现在 API 响应中） */
  payload?: string;
}

export interface HomeAddress {
  id: string;
  label: string;
  address: string;
}

export type SectionKey = 'delivering' | 'shipped' | 'notshipped' | 'done' | 'abnormal';

export const SECTION_ORDER: readonly SectionKey[] = [
  'delivering',
  'shipped',
  'notshipped',
  'done',
  'abnormal',
] as const;

export const SECTION_TITLES: Record<SectionKey, string> = {
  delivering: '派送中',
  shipped: '运输中',
  notshipped: '待发货',
  done: '已签收',
  abnormal: '异常',
};

export type AccountStatus = 'ok' | 'needs_login' | 'challenge' | 'error' | 'disabled';

export interface AccountView {
  id: string;
  channel: Channel;
  label: string;
  enabled: boolean;
  status: AccountStatus;
  statusDetail: string | null;
  lastOkAt: string | null;
  lastErrorAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export function createEmptyItem(overrides: Partial<ExpressItem> & Pick<ExpressItem, 'mailNo'>): ExpressItem {
  const base: ExpressItem = {
    id: overrides.id ?? overrides.mailNo,
    companyCode: '',
    companyName: '',
    mailNo: overrides.mailNo,
    latestText: '',
    latestTime: '',
    state: -1,
    stateName: '',
    phone: null,
    provider: '',
    stateNum: 0,
    queryChannel: '',
    iconUrl: '',
    originalName: '',
    eta: '',
    tracked: false,
    notifiedText: '',
    notifiedTime: '',
    stateOverride: '',
    partitionOverride: '',
    aiProgress: -1,
    aiEta: '',
    aiProgressAt: '',
    jumpLinks: '',
    source: 'manual',
    accountId: '',
    accountLabel: '',
    addressId: '',
    pickupCode: '',
    pickupCabinet: '',
    manual: false,
  };
  return { ...base, ...overrides };
}

export function parseJumpLinks(raw: string): JumpLink[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (x): x is JumpLink =>
        typeof x === 'object' && x !== null && typeof (x as JumpLink).link === 'string',
    );
  } catch {
    return [];
  }
}
