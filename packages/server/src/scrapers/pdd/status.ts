import type { DetailPoint } from '@ea/shared';

export interface PddStatus { state: number; stateNum: number; stateName: string }

/** 只使用物流语义，不把营销文案或未公开的数字枚举猜成运输状态。 */
export function pddStatusFromText(text: string): PddStatus | null {
  if (/拒收|退回|退件|物流异常|派送失败|签收失败|丢失/.test(text)) return { state: 4, stateNum: 108, stateName: '物流异常' };
  if (/快递员已取件|快递员已揽收/.test(text) && !/已签收|已领取|已提货|妥投/.test(text)) return { state: 2, stateNum: 104, stateName: '运输中' };
  if (!/未签收|待签收|等待签收|尚未签收/.test(text) && (/已签收|签收成功|已提货|已领取|已取件|取件成功|已自提|已送达|妥投|交易成功|已完成|待评价|已评价|确认收货成功/.test(text) || text.trim() === '签收')) {
    return { state: 3, stateNum: 107, stateName: '已签收' };
  }
  if (/派送|配送中|派件|送货上门中/.test(text)) return { state: 5, stateNum: 105, stateName: '派送中' };
  if (/待发货|未发货|待成团/.test(text)) return { state: 1, stateNum: 103, stateName: '待发货' };
  if (/待收货|运输|转运|分拣|已发货|已发出|揽收|出库|未签收|待签收/.test(text)) return { state: 2, stateNum: 104, stateName: '运输中' };
  return null;
}

export function pddStatusFromTrace(points: readonly DetailPoint[]): PddStatus | null {
  const latest = points.at(-1);
  return latest ? pddStatusFromText(latest.context) : null;
}
