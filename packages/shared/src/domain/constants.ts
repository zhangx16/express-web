/** 业务常量，全部与 Android 实现对齐 */

export const MAX_SHORT_NAME_LEN = 12;

/** PDD 列表接口只有状态提示，不能覆盖物流页回写的真实轨迹文本 */
export const PDD_PROMPT_ONLY_TEXTS = new Set([
  '交易成功',
  '待评价',
  '已评价',
  '待发货',
  '待收货',
  '待成团',
  '待付款',
  '已取消',
  '退款成功',
  '交易关闭',
]);

/** PDD 完成语义自愈关键词 */
export const PDD_DONE_MARKERS = ['已评价', '交易成功', '待评价', '已完成', '已签收', '签收'];

/** 状态跳过（各平台列表解析通用） */
export const CANCELLED_STATUS_MARKERS = ['取消', '关闭', '退款', '售后', '待付款', '未支付'];

/** 轨迹缓存 TTL（毫秒） */
export const TRACE_TTL = {
  pddActive: 60 * 60 * 1000,
  pddDone: Number.POSITIVE_INFINITY,
  jdActive: 60 * 60 * 1000,
  jdDone: 24 * 60 * 60 * 1000,
  taobaoActive: 60 * 60 * 1000,
  taobaoDone: 24 * 60 * 60 * 1000,
} as const;

export const NOTIFICATION_BODY_MAX = 80;
export const PDD_TRACE_TEXT_MAX = 220;

export const REPORT_REPEAT = {
  ONCE: 0,
  DAILY: 1,
  WEEKDAYS: 2,
  WEEKENDS: 3,
  CUSTOM: 4,
} as const;

/**
 * 星期位：周一=bit0 ... 周日=bit6，与 Android `ReportSchedule.MON..SUN` 一致。
 * 入参是 JS 的「周日=0」星期序号。
 *
 * 注意：不能直接照搬 Kotlin 的 `1 shl ((dow + 5) % 7)` —— Android
 * `Calendar.DAY_OF_WEEK` 是「周日=1」，而 JS `getDay()` 是「周日=0」，
 * 直接套用会让所有星期位整体错一天。
 */
export function weekdayBitFromSunday(dow: number): number {
  return 1 << ((dow + 6) % 7);
}

export function weekdayBit(date: Date): number {
  return weekdayBitFromSunday(date.getDay());
}

export const MOBILE_UA =
  'Mozilla/5.0 (Linux; Android 16; 25102RKBEC Build/BP2A.250605.031.A3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
