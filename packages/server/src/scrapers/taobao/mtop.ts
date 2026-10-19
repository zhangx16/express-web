import { createHash } from 'node:crypto';
import { NetworkError } from '../browser/errors.js';

export const MTOP_APPKEY = '12574478';

/** 与 Android `TbOrders.UA` 完全一致 */
export const TB_UA =
  'Mozilla/5.0 (Linux; Android 12; M2102K1C) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/105.0.0.0 Mobile Safari/537.36 EdgA/105.0.1343.48';

const MTOP_TIMEOUT_MS = 20_000;

export function md5Hex(text: string): string {
  return createHash('md5').update(text, 'utf8').digest('hex');
}

/** mtop 签名：`md5(token&t&appKey&dataRaw)` 小写（dataRaw 未 URL 编码） */
export function mtopSign(token: string, t: string, dataRaw: string, appKey = MTOP_APPKEY): string {
  return md5Hex(`${token}&${t}&${appKey}&${dataRaw}`);
}

export interface MtopCallOptions {
  cookie: string;
  api: string;
  version: string;
  data: unknown;
  host?: string;
  /** 响应类型：h5api 用 jsonp，acs/cainiao 用 originaljson */
  responseType?: 'jsonp' | 'originaljson';
  origin?: string;
  referer?: string;
}

export interface MtopCallResult {
  /** 响应原文（JSONP 包裹，需解析） */
  body: string;
  /** 本次调用过程中刷新后的 Cookie（含新的 _m_h5_tk） */
  cookie: string;
  /** 响应中的 ret 数组（若可解析） */
  ret: string[];
}

const BASE_HEADERS = {
  'User-Agent': TB_UA,
  Origin: 'https://h5.m.taobao.com',
  Referer: 'https://h5.m.taobao.com/',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9',
} as const;

function replaceCookieValue(cookie: string, name: string, value: string): string {
  const re = new RegExp(`(^|[;\\s])${name}=[^;]*`);
  if (re.test(cookie)) return cookie.replace(re, `$1${name}=${value}`);
  const sep = cookie.trim() ? '; ' : '';
  return `${cookie}${sep}${name}=${value}`;
}

/** 从 Set-Cookie 集合里取 `_m_h5_tk` / `_m_h5_tk_enc` 并手工合并（绝不使用 CookieJar） */
function mergeSetCookies(cookie: string, setCookies: string[]): string {
  let ck = cookie;
  const joined = setCookies.join('\n');
  const tk = /_m_h5_tk=([^;]+)/.exec(joined)?.[1];
  const enc = /_m_h5_tk_enc=([^;]+)/.exec(joined)?.[1];
  if (tk) ck = replaceCookieValue(ck, '_m_h5_tk', tk);
  if (enc) ck = replaceCookieValue(ck, '_m_h5_tk_enc', enc);
  return ck;
}

/**
 * mtop 通用调用（与 Android `mtopCall` 一致）：
 * 1) GET 带 appKey 刷新 token；2) 计算 sign；3) JSONP 请求。
 */
export async function mtopCall(opts: MtopCallOptions): Promise<MtopCallResult> {
  const host = opts.host ?? 'h5api.m.taobao.com';
  const base = `https://${host}/h5/${opts.api}/${opts.version}/`;
  const dataRaw = JSON.stringify(opts.data);
  const headers: Record<string, string> = { ...BASE_HEADERS };
  if (opts.origin) headers.Origin = opts.origin;
  if (opts.referer) headers.Referer = opts.referer;
  let cookie = opts.cookie;

  // 1) token 刷新（失败不致命：后续可能仍拿到旧 token）
  try {
    const res = await fetch(`${base}?appKey=${MTOP_APPKEY}`, {
      headers: { ...headers, Cookie: cookie },
      signal: AbortSignal.timeout(MTOP_TIMEOUT_MS),
    });
    const setCookies = res.headers.getSetCookie();
    cookie = mergeSetCookies(cookie, setCookies);
  } catch {
    // 忽略：token 刷新失败时仍尝试使用现有 token
  }

  const token = /_m_h5_tk=([^;]+)/.exec(cookie)?.[1]?.split('_')[0];
  if (!token) {
    throw new NetworkError('淘宝登录态缺少 mtop token，请重新登录');
  }

  const t = Date.now().toString();
  const sign = mtopSign(token, t, dataRaw);
  const responseType = opts.responseType ?? 'jsonp';
  const typeParam =
    responseType === 'jsonp' ? `type=jsonp&dataType=jsonp` : `type=${responseType}`;
  const url =
    `${base}?jsv=2.3.18&appKey=${MTOP_APPKEY}&t=${t}&sign=${sign}` +
    `&${typeParam}&data=${encodeURIComponent(dataRaw)}`;

  const res = await fetch(url, {
    headers: { ...headers, Cookie: cookie },
    signal: AbortSignal.timeout(MTOP_TIMEOUT_MS),
  });
  const body = await res.text();
  if (res.status === 401 || res.status === 403) {
    throw new NetworkError(`淘宝鉴权失败 HTTP ${res.status}`);
  }
  return { body, cookie, ret: parseRet(body) };
}

/** 响应 JSONP 外壳 → 内部 JSON 文本（`callback({...})`） */
export function unwrapJsonp(body: string): string {
  const text = body.trim();
  if (text.startsWith('{') || text.startsWith('[')) return text;
  const start = text.indexOf('(');
  const end = text.lastIndexOf(')');
  if (start < 0 || end <= start) return text;
  return text.slice(start + 1, end).trim();
}

export function parseMtopJson(body: string): Record<string, unknown> | null {
  const text = unwrapJsonp(body);
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseRet(body: string): string[] {
  const root = parseMtopJson(body);
  const ret = root?.ret;
  return Array.isArray(ret) ? ret.filter((x): x is string => typeof x === 'string') : [];
}

const RETRYABLE_RET = ['FAIL_SYS_TOKEN_EXOIRED', 'FAIL_SYS_TOKEN_EXPIRED', 'FAIL_SYS_ILLEGAL_ACCESS'];

/** 带一次 token 刷新重试的 mtop 调用（对齐计划 4.2：`FAIL_SYS_*` 只重试一次） */
export async function mtopCallWithRetry(opts: MtopCallOptions): Promise<MtopCallResult> {
  const first = await mtopCall(opts);
  if (!first.ret.some((r) => RETRYABLE_RET.some((m) => r.includes(m)))) return first;
  return mtopCall({ ...opts, cookie: first.cookie });
}
