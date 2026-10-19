import { isWaitingPickup } from './pickup.js';
import type { ExpressItem } from '../model/item.js';

/** 与 Android `progressFor` 完全一致 */
export function progressForState(stateNum: number, state: number): number {
  switch (stateNum) {
    case 101:
      return 5;
    case 102:
      return 15;
    case 103:
      return 25;
    case 104:
      return 55;
    case 105:
      return 85;
    case 106:
      return 95;
    case 107:
      return 100;
    case 108:
    case 109:
    case 110:
    case 111:
      return 0;
    default:
      switch (state) {
        case 1:
          return 25;
        case 3:
          return 100;
        case 5:
          return 85;
        case 0:
          return 55;
        default:
          return 0;
      }
  }
}

export function progressFor(item: ExpressItem): number {
  return progressForState(item.stateNum, item.state);
}

/** 物理签收：与 `partitionOverride` 无关 */
export function isReceivedState(state: number, stateNum: number): boolean {
  return state === 3 || stateNum === 107;
}

/** 异常/终止：state 4 或 stateNum 108..111 */
export function isAbnormalState(state: number, stateNum: number): boolean {
  return state === 4 || (stateNum >= 108 && stateNum <= 111);
}

/** 校验并收敛 AI 进度：负数无效；0% 仅在未发货阶段合理；超过 100 截断 */
function normalizedAiProgress(stateNum: number, aiProgress: number): number {
  if (!Number.isFinite(aiProgress) || aiProgress < 0) return -1;
  if (aiProgress === 0 && !(stateNum >= 101 && stateNum <= 103)) return -1;
  return Math.min(100, Math.max(0, aiProgress));
}

/**
 * 展示用进度：AI 结果 0% 只在"未发货/已揽收"阶段合理；
 * 已签收直接 100；无效 AI 值返回 -1 交给默认映射。
 */
export function displayProgress(item: ExpressItem): number {
  if (isReceivedState(item.state, item.stateNum)) return 100;
  const p = item.aiProgress;
  if (p < 0) return -1;
  if (p === 0 && !(item.stateNum >= 101 && item.stateNum <= 103)) return -1;
  return normalizedAiProgress(item.stateNum, p);
}

/** 最终渲染进度：AI 有效则用 AI，否则回落到规则进度 */
export function effectiveProgress(item: ExpressItem): number {
  const ai = displayProgress(item);
  return ai >= 0 ? ai : progressFor(item);
}

/**
 * 进度环的展示状态。
 * - `done`：已签收（物理签收，不受手动分区影响）
 * - `abnormal`：异常/已终止，不能渲染成误导性的 0%
 * - `unknown`：状态未知（手工件还没有任何物流信息、或 state 尚未同步）
 * - `progress`：正常 0–100
 */
export type ProgressViewKind = 'progress' | 'done' | 'abnormal' | 'unknown';

export interface ProgressView {
  kind: ProgressViewKind;
  /** 仅 `kind === 'progress'` 时有意义；其余情况为 0 */
  value: number;
}

export function progressViewOf(state: number, stateNum: number, aiProgress = -1): ProgressView {
  if (isReceivedState(state, stateNum)) return { kind: 'done', value: 100 };
  if (isAbnormalState(state, stateNum)) return { kind: 'abnormal', value: 0 };
  // createEmptyItem 的初始态：状态尚未同步
  if (stateNum === 0 && state < 0) return { kind: 'unknown', value: 0 };

  const ai = normalizedAiProgress(stateNum, aiProgress);
  return {
    kind: 'progress',
    value: ai >= 0 ? ai : progressForState(stateNum, state),
  };
}

export function progressView(item: ExpressItem): ProgressView {
  if (isWaitingPickup(item)) return { kind: 'progress', value: 95 };
  // 手工添加的包裹在渠道抓到数据前只有默认的 state=0/stateNum=105，
  // 直接套规则会显示 85%，误导用户以为已在派送。
  if (item.manual && item.latestText.trim() === '') return { kind: 'unknown', value: 0 };
  return progressViewOf(item.state, item.stateNum, item.aiProgress);
}
