import { isWaitingPickup } from './pickup.js';
import type { ExpressItem, SectionKey } from '../model/item.js';

/**
 * 分区判定，严格对齐 Android `data/Express.kt:85`。
 * 注意顺序：partitionOverride 优先；105/106/state 5 先于 done 判定（106 因此不可达）。
 */
export function sectionKeyOf(item: ExpressItem): SectionKey {
  if (item.partitionOverride.trim() !== '') {
    return item.partitionOverride as SectionKey;
  }
  if (isWaitingPickup(item)) return 'delivering';
  if (item.stateNum === 105 || item.stateNum === 106 || item.state === 5) return 'delivering';
  if ((item.stateNum >= 106 && item.stateNum <= 107) || item.state === 3) return 'done';
  if ((item.stateNum >= 108 && item.stateNum <= 111) || item.state === 4) return 'abnormal';
  if (item.stateNum === 101 || item.stateNum === 103 || item.state === 1) return 'notshipped';
  return 'shipped';
}

export function isDone(item: ExpressItem): boolean {
  return sectionKeyOf(item) === 'done';
}

export function isAbnormal(item: ExpressItem): boolean {
  return sectionKeyOf(item) === 'abnormal';
}

/**
 * 物理签收：state 3 或 stateNum 107。
 * 与 `isDone` 不同，这里不看 `partitionOverride`——手动把在途包裹拖进
 * 「已签收」分区不应被当成真的签收。
 */
export function isReceived(item: ExpressItem): boolean {
  return !isWaitingPickup(item) && (item.state === 3 || item.stateNum === 107);
}

/** 是否属于"在途"（用于追踪轮询与日报） */
export function isTransport(item: ExpressItem): boolean {
  if (item.state < 0 && item.stateNum === 0) return false;
  const section = sectionKeyOf(item);
  if (section === 'done' || section === 'abnormal') return false;
  if (isWaitingPickup(item)) return true;
  if (item.state === 3 || item.state === 4) return false;
  if (item.stateNum >= 106 && item.stateNum <= 111) return false;
  return true;
}

export function stateLabel(item: ExpressItem): string {
  if (item.stateOverride.trim() !== '') return item.stateOverride;
  if (isWaitingPickup(item)) return '待取件';
  if (item.stateName !== '') return item.stateName;
  switch (item.state) {
    case 0:
      return '运输中';
    case 1:
      return '已揽件';
    case 3:
      return '已签收';
    case 4:
      return '已拒签';
    case 5:
      return '派送中';
    default:
      return '未知';
  }
}
