const PICKUP_RE =
  /(取件码|取货码|提货码|自提码|驿站码|取件验证码|开柜码)[:：\s为是]*[「【（(\[]?([A-Za-z0-9][A-Za-z0-9-]{1,12})/;

/** 从文本中解析取件码；无则 null（对齐 GoodsPresentation.pickupCodeFrom） */
export function pickupCodeFrom(text: string | null | undefined): string | null {
  if (!text) return null;
  const m = PICKUP_RE.exec(text);
  return m?.[2] ?? null;
}

export function pickupCodeFromParts(parts: Array<string | null | undefined>): string | null {
  for (const p of parts) {
    const c = pickupCodeFrom(p);
    if (c) return c;
  }
  return null;
}

/** 丰巢柜机编号/位置与取件码分别解析；不猜测未返回的柜号。 */
export function fengchaoCabinetFrom(text: string | null | undefined): string | null {
  return text && /丰巢/.test(text) ? pickupCabinetFrom(text) : null;
}

export function pickupCabinetFrom(text: string | null | undefined): string | null {
  if (!text || !/柜|丰巢/.test(text)) return null;
  const numbered = /(?:柜机编号|快递柜编号|柜机号|柜号|柜编号)\s*[:：为是]?\s*[「【（(\[]?([A-Za-z0-9][A-Za-z0-9-]{0,31})/i.exec(text);
  if (numbered) return numbered[1] ?? null;
  const named = /丰巢(?:智能|快递)?柜?\s*[（(【]?\s*([A-Za-z0-9一二三四五六七八九十]+(?:区[A-Za-z0-9一二三四五六七八九十]+)?号柜)/.exec(text);
  if (named) return named[1] ?? null;
  const location = /(?:放入|存入|存放在|投递至|投递到|送至|送达|位于|放在)\s*[【「]?([^，。；！\n]{1,60}?丰巢(?:智能|快递)?柜)/.exec(text);
  const value = location?.[1]?.trim();
  return value && !/^丰巢(?:智能|快递)?柜$/.test(value) ? value : null;
}

/** 只用最新动态判断仍待取，避免从历史投柜轨迹复活已取走的包裹。 */
export function isWaitingPickup(item: { latestText: string; state: number; stateNum: number; stateName?: string }): boolean {
  const text = item.latestText;
  if (item.state === 4 || (item.stateNum >= 108 && item.stateNum <= 111)) return false;
  if (/已领取|已提货|已取出|已取走|取件成功|本人签收|收件人已签收|已完成取件|拒收|退回|丢失/.test(text)) return false;
  if (/等待快递员取件|请.*快递员.*取件|上门取件|预约取件/.test(text) && !/丰巢|快递柜|驿站/.test(text)) return false;
  if (/取件码|取货码|自提码|提货码/.test(text) && /快递柜|驿站|代收点|自提点/.test(text)) return true;
  if (item.stateName && /待取件|待取货|待领取|待自提/.test(item.stateName)) return true;
  if (/待取件|等待取件|待取货|待领取|请.*取件|凭.*取件|待自提/.test(text)) return true;
  if (/丰巢/.test(text) && /已放入|已存入|已入柜|存放|取件码|取货码/.test(text)) return true;
  return item.stateNum === 106 && item.state !== 3;
}
