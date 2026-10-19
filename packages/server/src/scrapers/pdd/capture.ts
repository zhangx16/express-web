import type { Page } from 'playwright';

/** 拼多多 H5 相关域（cookie 注入/回读） */
export const PDD_COOKIE_HOSTS = [
  'https://mobile.yangkeduo.com',
  'https://yangkeduo.com',
  'https://pinduoduo.com',
  'https://mobile.pinduoduo.com',
  'https://passport.pinduoduo.com',
] as const;

export interface PddCaptureEntry {
  url: string;
  body: string;
}

/** 捕获是否可能是拼多多业务数据（订单/物流类） */
export function looksRelevant(url: string, body: string): boolean {
  const u = url.toLowerCase();
  const b = body.toLowerCase();
  return (
    u.includes('proxy/api') &&
    (u.includes('order') ||
      u.includes('logistic') ||
      u.includes('express') ||
      u.includes('track') ||
      u.includes('parcel') ||
      u.includes('goods') ||
      b.includes('tracking_no') ||
      b.includes('logistics_no') ||
      b.includes('mailno') ||
      b.includes('order_sn') ||
      b.includes('express'))
  );
}

/* ─────────────── 候选键取值工具（字段随版本有差异，容错取值） ─────────────── */

type Json = Record<string, unknown>;

export function asObject(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

/** 与 Android `firstString` 一致：只处理 String/Number/嵌套对象 */
export function firstString(obj: Json, keys: ReadonlySet<string>): string {
  for (const k of keys) {
    if (!(k in obj)) continue;
    const v = obj[k];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
    if (typeof v === 'number') return String(v);
    const nested = asObject(v);
    if (nested) {
      const found = firstString(nested, keys);
      if (found !== '') return found;
    }
  }
  return '';
}

/** 与 Android `firstStringDeep` 一致：先查候选键，再递归所有键（含数组） */
export function firstStringDeep(obj: Json, keys: ReadonlySet<string>, depth: number): string {
  if (depth <= 0) return '';
  for (const k of keys) {
    if (!(k in obj)) continue;
    const v = obj[k];
    if (typeof v === 'string' && v.trim() !== '') return v.trim();
    const nested = asObject(v);
    if (nested) {
      const found = firstStringDeep(nested, keys, depth - 1);
      if (found !== '') return found;
    }
    if (Array.isArray(v)) {
      for (const e of v) {
        const item = asObject(e);
        if (!item) continue;
        const found = firstStringDeep(item, keys, depth - 1);
        if (found !== '') return found;
      }
    }
  }
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const nested = asObject(v);
    if (nested) {
      const found = firstStringDeep(nested, keys, depth - 1);
      if (found !== '') return found;
      continue;
    }
    if (Array.isArray(v)) {
      for (const e of v) {
        const item = asObject(e);
        if (!item) continue;
        const found = firstStringDeep(item, keys, depth - 1);
        if (found !== '') return found;
      }
    }
  }
  return '';
}

/** 与 Android `firstValueDeep` 一致：返回原始值（字符串/数字） */
export function firstValueDeep(obj: Json, keys: ReadonlySet<string>, depth: number): unknown {
  if (depth <= 0) return null;
  for (const k of keys) {
    if (!(k in obj)) continue;
    const v = obj[k];
    if (typeof v === 'string' && v.trim() !== '') return v;
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    const nested = asObject(v);
    if (nested) {
      const found = firstValueDeep(nested, keys, depth - 1);
      if (found !== null) return found;
    }
    if (Array.isArray(v) && v.length > 0) {
      for (const e of v) {
        const item = asObject(e);
        if (!item) continue;
        const found = firstValueDeep(item, keys, depth - 1);
        if (found !== null) return found;
      }
    }
  }
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    const nested = asObject(v);
    if (nested) {
      const found = firstValueDeep(nested, keys, depth - 1);
      if (found !== null) return found;
      continue;
    }
    if (Array.isArray(v)) {
      for (const e of v) {
        const item = asObject(e);
        if (!item) continue;
        const found = firstValueDeep(item, keys, depth - 1);
        if (found !== null) return found;
      }
    }
  }
  return null;
}

/** 秒/毫秒时间戳 → `yyyy-MM-dd HH:mm`（Asia/Shanghai）；其它字符串截断 30 字 */
export function timeString(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') {
    const t = value.trim();
    if (/^\d{10,13}$/.test(t)) return formatMillisSafe(Number(t));
    return t.slice(0, 30);
  }
  if (typeof value === 'number' && Number.isFinite(value)) return formatMillisSafe(value);
  return '';
}

const SHANGHAI_FMT = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function formatMillisSafe(raw: number): string {
  const ms = raw > 1_000_000_000_000 ? raw : raw * 1000;
  try {
    // sv-SE 输出 `YYYY-MM-DD HH:mm`
    return SHANGHAI_FMT.format(new Date(ms));
  } catch {
    return String(raw);
  }
}

/* ─────────────── 页面侧工具 JS ─────────────── */

const READ_AND_CLEAR_JS = `(function(){var s=window.name||'';window.name='';return s;})()`;

/** 尝试点击「加载更多 / 查看更多 / 下一页」类按钮 */
export const TRY_TAP_MORE_JS = `(function(){
  try {
    var els = document.querySelectorAll('div,span,button,a');
    for (var i = 0; i < els.length; i++) {
      var t = (els[i].innerText || '').trim();
      if (t === '加载更多' || t === '查看更多' || t === '下一页' || t === '查看全部') {
        els[i].click(); return true;
      }
    }
  } catch(e) {}
  return false;
})()`;

/** 滚动到底：页面 window + 所有可滚动容器 */
export const SCROLL_TO_BOTTOM_JS = `(function(){
  try { window.scrollTo(0, document.body ? document.body.scrollHeight : 0); } catch(e) {}
  try {
    var els = document.querySelectorAll('*');
    for (var i = 0; i < els.length; i++) {
      var e = els[i];
      if (e.scrollHeight > e.clientHeight + 100) e.scrollTop = e.scrollHeight;
    }
  } catch(e) {}
  return true;
})()`;

/** 点击「全部」tab / 「查看全部」入口（订单页默认可能停在空 tab） */
export const TRY_TAP_ALL_ORDERS_JS = `(function(){
  try {
    var els = document.querySelectorAll('div,span,button,a,li');
    var candidates = [];
    for (var i = 0; i < els.length; i++) {
      var t = (els[i].innerText || '').trim();
      if (t === '全部' || t === '全部订单' || t === '全部商品' ||
          t.indexOf('查看全部') >= 0 || t.indexOf('查看更多订单') >= 0 ||
          t.indexOf('全部订单') >= 0) {
        candidates.push(els[i]);
      }
    }
    if (candidates.length) {
      var el = candidates[0];
      el.scrollIntoView();
      el.click();
      return candidates.length;
    }
  } catch(e) {}
  return -1;
})()`;

/** 读取并清空 `window.name` 中的捕获（只回传一次，避免重复解析） */
export async function readCaptures(page: Page): Promise<PddCaptureEntry[]> {
  let raw: string;
  try {
    raw = await page.evaluate(READ_AND_CLEAR_JS);
  } catch {
    return [];
  }
  return parseCaptures(raw);
}

/** 读取但不清空（调试用） */
export async function peekRaw(page: Page): Promise<string> {
  try {
    return await page.evaluate(`(function(){return window.name?window.name:'[]';})()`);
  } catch {
    return '[]';
  }
}

export function parseCaptures(rawJsonArray: string): PddCaptureEntry[] {
  let arr: unknown;
  try {
    arr = JSON.parse(rawJsonArray);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: PddCaptureEntry[] = [];
  for (const entry of arr) {
    const o = asObject(entry);
    if (!o) continue;
    const url = typeof o.u === 'string' ? o.u : '';
    const body = typeof o.b === 'string' ? o.b : '';
    if (body !== '') out.push({ url, body });
  }
  return out;
}

export async function tryTapMore(page: Page): Promise<void> {
  await page.evaluate(TRY_TAP_MORE_JS).catch(() => undefined);
}

export async function tryTapAllOrders(page: Page): Promise<void> {
  await page.evaluate(TRY_TAP_ALL_ORDERS_JS).catch(() => undefined);
}

export async function scrollToBottom(page: Page): Promise<void> {
  await page.evaluate(SCROLL_TO_BOTTOM_JS).catch(() => undefined);
}

/** 从 Cookie 头里取 pdduid / pdd_user_id（页内 fetch 需要） */
export function pdduidFromCookie(cookieHeader: string): string {
  const m =
    /(?:^|;\s*)pdduid=([^;]+)/.exec(cookieHeader) ?? /(?:^|;\s*)pdd_user_id=([^;]+)/.exec(cookieHeader);
  return m?.[1]?.trim() ?? '';
}
