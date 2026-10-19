import type { BrowserContext, Page } from 'playwright';
import pLimit from 'p-limit';
import { acquireContext, withBrowserSlot } from '../../browser/pool.js';
import { getAccountRecord, setAccountStatus, updateAccountPayload, type AccountRecord, type CookieAccountPayload } from '../../services/accounts/repo.js';
import { collectCookies, parseCookieHeader } from '../browser/cookies.js';
import { AuthExpiredError, RiskChallengeError, NetworkError, RateLimitedError, safeMessage } from '../browser/errors.js';
import { PDD_COOKIE_HOSTS } from './capture.js';

/** 同一账号的列表、详情共用会话并串行执行，避免并发改变登录态。 */
const locks = new Map<string, ReturnType<typeof pLimit>>();
const initialized = new WeakSet<BrowserContext>();

export function hasPddLogin(cookie: string): boolean {
  const pairs = new Map(parseCookieHeader(cookie).map(({ name, value }) => [name, value]));
  return Boolean(pairs.get('PDDAccessToken')) &&
    ['pdduid', 'PASS_ID', 'pdd_user_id', 'pdd_user_uin'].some((key) => Boolean(pairs.get(key)));
}

export async function snapshotPddSession(context: BrowserContext): Promise<CookieAccountPayload> {
  const cookie = await collectCookies(context, PDD_COOKIE_HOSTS);
  const browserState = await context.storageState({ indexedDB: true });
  return { cookie, browserState };
}

export async function persistPddSession(context: BrowserContext, account: AccountRecord): Promise<void> {
  const payload = await snapshotPddSession(context);
  // 安全验证/登录跳转中的匿名 Cookie 不覆盖最后一次有效登录态。
  if (!hasPddLogin(payload.cookie)) return;
  updateAccountPayload(account.id, { ...account.payload, ...payload });
}

export async function withPddSession<T>(account: AccountRecord, fn: (context: BrowserContext) => Promise<T>): Promise<T> {
  let lock = locks.get(account.id);
  if (!lock) {
    lock = pLimit(1);
    locks.set(account.id, lock);
  }
  try {
    return await lock(() => withBrowserSlot(async () => {
      const current = getAccountRecord(account.id);
      if (!current || !current.enabled || current.status === 'needs_login') {
        throw new AuthExpiredError('拼多多登录态不可用，请重新登录');
      }
      if (current.status === 'challenge') {
        throw new RiskChallengeError(current.statusDetail || '拼多多需要人工验证，请在设置中点击“完成安全验证”');
      }
      if (Date.parse(current.payload.pddRetryAfter || '') > Date.now()) {
        throw new RateLimitedError(current.statusDetail || '拼多多请求暂时受限，请稍后再试');
      }
      if (!hasPddLogin(current.payload.cookie)) {
        throw new AuthExpiredError('拼多多登录态不完整，请重新登录');
      }
      const context = await acquireContext(account.id, current.payload.browserState);
      if (!initialized.has(context)) {
        // 旧版本仅 Cookie 的凭据无法恢复站点存储，要求重新登录而非跨域回灌。
        const live = await collectCookies(context, PDD_COOKIE_HOSTS);
        if (!hasPddLogin(live)) {
          throw new AuthExpiredError('拼多多浏览器登录态缺失，请重新登录以保存完整会话');
        }
        initialized.add(context);
      }
      try {
        return await fn(context);
      } catch (err) {
        // 在释放账号锁之前记录验证状态，阻止排队中的详情请求继续访问平台。
        if (err instanceof PddChallengeError) {
          const latest = getAccountRecord(account.id);
          if (latest) updateAccountPayload(account.id, { ...latest.payload, verificationUrl: safePddVerificationUrl(err.verificationUrl) });
        }
        if (err instanceof RateLimitedError || err instanceof NetworkError) {
          const latest = getAccountRecord(account.id);
          const cooldown = err instanceof RateLimitedError ? 15 * 60_000 : 60_000;
          if (latest) updateAccountPayload(account.id, { ...latest.payload, pddRetryAfter: new Date(Date.now() + cooldown).toISOString() });
          setAccountStatus(account.id, 'error', safeMessage(err));
        }
        if (err instanceof RiskChallengeError) setAccountStatus(account.id, 'challenge', err.message);
        if (err instanceof AuthExpiredError) setAccountStatus(account.id, 'needs_login', err.message);
        throw err;
      }
    }));
  } finally {
    if (lock.activeCount === 0 && lock.pendingCount === 0 && locks.get(account.id) === lock) locks.delete(account.id);
  }
}

export function isPddChallengeUrl(url: string): boolean {
  try {
    const { pathname } = new URL(url);
    return /(?:^|\/)(?:login|passport|verify|verification|captcha|risk|psnl_verification)(?:[\/._-]|$)/i.test(pathname);
  } catch {
    return false;
  }
}

export class PddChallengeError extends RiskChallengeError {
  constructor(message: string, readonly verificationUrl: string) {
    super(message);
  }
}

/** 只允许拼多多站点作为人工验证入口，拒绝外部地址和 URL 凭据。 */
export function safePddVerificationUrl(raw?: string): string {
  try {
    const url = new URL(raw || '');
    if (url.protocol === 'https:' && !url.username && !url.password &&
        PDD_COOKIE_HOSTS.some((host) => new URL(host).origin === url.origin)) return url.href;
  } catch {
    // 无有效入口时打开订单页，由平台显示当前账号所需的验证。
  }
  return 'https://mobile.yangkeduo.com/orders.html';
}

const blockedPages = new WeakMap<Page, number>();

/** 仅观察订单/物流业务接口；HTTP 拒绝与限流不等同于账号安全验证。 */
export function watchPddPage(page: Page): void {
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith('/proxy/api/') && /order|logistic|express|track|parcel/i.test(url.pathname) &&
        (response.status() === 403 || response.status() === 429)) {
      blockedPages.set(page, response.status());
    }
  });
}

/** 只读检测已出现的验证页面，不自动点击或尝试通过验证。 */
export async function assertPddPageReady(page: Page): Promise<void> {
  const url = page.url();
  if (isPddChallengeUrl(url)) {
    if (/\/(?:login|passport)(?:[\/._-]|$)/i.test(new URL(url).pathname)) {
      throw new AuthExpiredError('拼多多跳转到登录页，登录态已失效');
    }
    throw new PddChallengeError('拼多多显示安全验证页面，请在设置中点击“完成安全验证”', url);
  }
  const challenged = await page.evaluate(() => {
    const text = document.body?.innerText ?? '';
    return /请完成.{0,8}(?:安全)?验证|请通过.{0,8}验证|拖动滑块|滑动滑块|账号存在风险/.test(text);
  }).catch(() => false);
  if (challenged) throw new PddChallengeError('拼多多页面要求安全验证，请在设置中点击“完成安全验证”', url);
  const status = blockedPages.get(page);
  if (status === 429) throw new RateLimitedError('拼多多订单/物流接口请求过于频繁（HTTP 429），暂停15分钟后可重试');
  if (status === 403) throw new NetworkError('拼多多订单/物流接口拒绝访问（HTTP 403），暂停1分钟后可重试');
}
