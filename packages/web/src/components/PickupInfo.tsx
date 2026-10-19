import { fengchaoCabinetFrom, isWaitingPickup, pickupCodeFromParts, type ExpressItem } from '@ea/shared';
export default function PickupInfo({ item, texts = [] }: { item: ExpressItem; texts?: string[] }) {
  const parts = [item.latestText, ...texts];
  const fengchao = Boolean(item.pickupCabinet) || parts.some(text => /丰巢/.test(text));
  const waiting = isWaitingPickup(item) || (!item.latestText.trim() && item.state !== 3 && item.state !== 4 && item.stateNum !== 107 && Boolean(item.pickupCabinet));
  if (!fengchao || !waiting) return null;
  const cabinet = item.pickupCabinet || parts.map(fengchaoCabinetFrom).find(Boolean);
  const code = item.pickupCode || pickupCodeFromParts(parts);
  return <div className="mt-2 space-y-1 rounded-xl bg-amber-50 p-2.5 text-xs text-amber-900" aria-label="丰巢待取件信息">
    <p className="font-semibold">丰巢快递柜 · 待取件</p>
    <p>柜号 / 位置：<span className="font-medium">{cabinet || '物流未提供，可在编辑包裹中补填'}</span></p>
    <p>取件码：<span className="font-mono font-semibold">{code || '物流未提供，请查看丰巢通知'}</span></p>
  </div>;
}
