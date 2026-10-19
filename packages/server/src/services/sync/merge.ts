import { pddStatusFromText } from '../../scrapers/pdd/status.js';
import {
  MERGE_PRIORITY,
  PDD_PROMPT_ONLY_TEXTS,
  PDD_TRACE_TEXT_MAX,
  pickupCodeFrom,
  fengchaoCabinetFrom,
  type Channel,
  type DetailPoint,
  type ExpressItem,
} from '@ea/shared';

export interface ChannelFetchResult {
  /** null = 该渠道本次未启用/未执行；[] = 执行成功但 0 条 */
  items: ExpressItem[] | null;
}

export interface MergeInput {
  /** 本次各渠道抓取结果（键缺失等价于 null） */
  fresh: Partial<Record<Channel, ExpressItem[] | null>>;
  /** 旧库全部条目（按 mailNo） */
  oldItems: Map<string, ExpressItem>;
  /** 已缓存的 PDD 轨迹，用于 prompt-only 文本回填 */
  pddTraces?: Map<string, DetailPoint[]>;
  /** 用户手动隐藏的单号 */
  hiddenMailNos?: Set<string>;
}

export interface MergeResult {
  items: ExpressItem[];
  /** 各渠道最终条数（用于 SSE / 同步记录） */
  counts: Record<Channel, number>;
}

/**
 * 防误清：抓取失败或成功但 0 条时保留该渠道旧数据。
 * 新账号首次同步（无旧数据）才允许写入空结果。
 */
function preserveOld(
  channel: Channel,
  fresh: ExpressItem[] | null | undefined,
  oldItems: Map<string, ExpressItem>,
): ExpressItem[] {
  if (fresh && fresh.length > 0) return fresh;
  const old = [...oldItems.values()].filter((i) => i.source === channel);
  if (old.length > 0) return old;
  return fresh ?? [];
}

/**
 * 跨渠道合并，严格对齐 Android `SyncEngine.run`：
 * 优先级 京东 > 淘宝 > 拼多多（先写入者胜出），PDD 使用单调并集。
 */
export function mergeItems(input: MergeInput): MergeResult {
  const { fresh, oldItems } = input;
  const merged = new Map<string, ExpressItem>();

  for (const channel of ['jd', 'taobao'] as const) {
    for (const item of preserveOld(channel, fresh[channel], oldItems)) {
      if (!merged.has(item.mailNo)) merged.set(item.mailNo, item);
    }
  }

  // PDD 单调并集：本次新抓 + 历史旧数据，按 mailNo 去重（新数据在前）
  const pddUnion = new Map<string, ExpressItem>();
  const freshOrders = new Set((fresh.pdd ?? []).map((item) => item.queryChannel).filter(Boolean));
  const oldPddOrders = new Map([...oldItems.values()].filter((item) => item.source === 'pdd' && item.queryChannel).map((item) => [item.queryChannel, item]));
  for (const item of preserveOld('pdd', fresh.pdd, oldItems)) pddUnion.set(item.mailNo, item);
  for (const item of oldItems.values()) {
    if (item.source === 'pdd' && !pddUnion.has(item.mailNo) && !freshOrders.has(item.queryChannel)) pddUnion.set(item.mailNo, item);
  }
  for (const item of pddUnion.values()) {
    if (!merged.has(item.mailNo)) merged.set(item.mailNo, item);
  }

  // 手工添加：渠道抓取不到也必须保留（Android 侧是合并写入、从不删除）。
  // 放在最后，避免手工条目遮蔽同单号的真实渠道数据。
  for (const item of oldItems.values()) {
    if (item.manual && !merged.has(item.mailNo)) merged.set(item.mailNo, item);
  }

  // 逐条保留用户字段与 PDD 特例
  const preserved: ExpressItem[] = [];
  for (const item of merged.values()) {
    const old = oldItems.get(item.mailNo) ?? (item.source === 'pdd' ? oldPddOrders.get(item.queryChannel) : undefined);
    if (!old) {
      preserved.push(item);
      continue;
    }
    preserved.push(applyPreservation(item, old));
  }

  // 聚合取件码：从最新轨迹文本解析
  const withPickup = preserved.map((item) => {
    return { ...item, pickupCode: item.pickupCode || pickupCodeFrom(item.latestText) || '', pickupCabinet: fengchaoCabinetFrom(item.latestText) || item.pickupCabinet || '' };
  });

  // PDD：列表只有状态提示时，用已缓存的物流轨迹回填卡片文案
  const traces = input.pddTraces ?? new Map<string, DetailPoint[]>();
  const withTrace = withPickup.map((item) => {
    if (item.source !== 'pdd' || !PDD_PROMPT_ONLY_TEXTS.has(item.latestText)) return item;
    const pts = traces.get(item.mailNo) ?? traces.get(item.queryChannel);
    const last = pts?.at(-1);
    if (!last) return item;
    return {
      ...item,
      latestText: last.context.slice(0, PDD_TRACE_TEXT_MAX) || item.latestText,
      latestTime: last.time || item.latestTime,
      pickupCode: item.pickupCode || pickupCodeFrom(last.context) || '',
      pickupCabinet: fengchaoCabinetFrom(last.context) || item.pickupCabinet || '',
    };
  });

  // 隐藏过滤：已移除的快递不因并集/重抓复活
  const hidden = input.hiddenMailNos ?? new Set<string>();
  const finalItems = hidden.size === 0 ? withTrace : withTrace.filter((i) => !hidden.has(i.mailNo) && !(i.source === 'pdd' && hidden.has(i.queryChannel)));

  const counts: Record<Channel, number> = { jd: 0, taobao: 0, pdd: 0 };
  for (const item of finalItems) {
    if (item.source !== 'manual') counts[item.source] += 1;
  }

  return { items: finalItems, counts };
}

/** 用户字段保留 + PDD prompt-only 保护 + PDD 完成自愈 */
export function applyPreservation(item: ExpressItem, old: ExpressItem): ExpressItem {
  const pddPromptOnly = item.source === 'pdd' && PDD_PROMPT_ONLY_TEXTS.has(item.latestText);
  const latestText = pddPromptOnly ? old.latestText || item.latestText : item.latestText;
  const latestTime = pddPromptOnly ? old.latestTime || item.latestTime : item.latestTime;

  const pddStatus = item.source === 'pdd' ? pddStatusFromText(item.stateName) : null;
  const keepReceived = item.source === 'pdd' && old.state === 3 && item.state !== 3 && item.state !== 4 && pddStatus?.state !== 4;

  return {
    ...item,
    state: keepReceived ? 3 : pddStatus?.state ?? item.state,
    stateNum: keepReceived ? 107 : pddStatus?.stateNum ?? item.stateNum,
    stateName: keepReceived ? old.stateName : item.stateName,
    tracked: old.tracked,
    phone: old.phone || item.phone,
    ...(old.provider === 'kuaidi100' ? { companyCode: old.companyCode, companyName: old.companyName, provider: old.provider } : {}),
    notifiedText: old.notifiedText,
    notifiedTime: old.notifiedTime,
    stateOverride: old.stateOverride,
    partitionOverride: old.partitionOverride,
    aiProgress: old.aiProgress,
    aiEta: old.aiEta,
    aiProgressAt: old.aiProgressAt,
    latestText,
    latestTime,
    addressId: old.addressId,
    pickupCode: item.pickupCode || old.pickupCode,
    pickupCabinet: item.pickupCabinet || old.pickupCabinet || '',
    // 渠道后来也抓到了同单号：保留手工标记，渠道再次缺失时仍不会丢
    manual: old.manual,
  };
}

/** 合并优先级（用于文档/测试断言） */
export const PRIORITY = MERGE_PRIORITY;
