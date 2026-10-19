import type { BrowserContext } from 'playwright';

export interface CookiePair {
  name: string;
  value: string;
}

/** 解析 `a=1; b=2` 形式的 Cookie 头（值里允许出现 `=`） */
export function parseCookieHeader(raw: string): CookiePair[] {
  const out: CookiePair[] = [];
  for (const part of raw.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf('=');
    if (idx <= 0) continue;
    const name = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (!name) continue;
    out.push({ name, value });
  }
  return out;
}

/** 把 Cookie 头写进指定 host 列表（与 Android CookieManager 行为一致） */
export async function setCookiesForHosts(
  context: BrowserContext,
  cookieHeader: string,
  hosts: readonly string[],
): Promise<void> {
  const pairs = parseCookieHeader(cookieHeader);
  if (pairs.length === 0) return;
  const cookies = [];
  for (const host of hosts) {
    for (const { name, value } of pairs) {
      cookies.push({
        name,
        value,
        domain: host.replace(/^https?:\/\//, ''),
        path: '/',
        // 会话 Cookie：由持久化 payload 负责跨进程保存，不依赖浏览器过期时间
        expires: -1,
      });
    }
  }
  await context.addCookies(cookies);
}

/** 从 context 汇总指定 URL 的 Cookie（同名后者覆盖前者，保证最新） */
export async function collectCookies(
  context: BrowserContext,
  urls: readonly string[],
): Promise<string> {
  const merged = new Map<string, string>();
  for (const url of urls) {
    let cookies;
    try {
      cookies = await context.cookies(url);
    } catch {
      continue;
    }
    for (const c of cookies) merged.set(c.name, c.value);
  }
  return [...merged.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

/** 清除指定 host 上某组 Cookie（切换账号/重新登录前） */
export async function clearCookies(
  context: BrowserContext,
  hosts: readonly string[],
  names?: readonly string[],
): Promise<void> {
  const existing = await context.cookies();
  const cookies = [];
  for (const c of existing) {
    if (names && !names.includes(c.name)) continue;
    const matches = hosts.some((h) => {
      const host = h.replace(/^https?:\/\//, '');
      return c.domain === host || c.domain.endsWith(`.${host}`) || host.endsWith(c.domain.replace(/^\./, ''));
    });
    if (!matches) continue;
    cookies.push({ name: c.name, value: '', domain: c.domain, path: c.path, expires: 0 });
  }
  if (cookies.length > 0) await context.addCookies(cookies);
}

/** 登录态是否具备（JD 用 pt_key） */
export function hasLoginCookie(cookieHeader: string, name: string): boolean {
  return parseCookieHeader(cookieHeader).some((p) => p.name === name && p.value !== '');
}
