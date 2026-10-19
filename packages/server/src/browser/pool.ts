import { chromium, type Browser, type BrowserContext } from 'playwright';
import pLimit from 'p-limit';
import { config } from '../config.js';
import { MOBILE_UA } from '@ea/shared';

export type BrowserState = 'ok' | 'starting' | 'down';

interface PooledContext {
  context: BrowserContext;
  lastUsed: number;
  accountId: string;
}

const IDLE_TTL_MS = 10 * 60 * 1000;
const VIEWPORT = { width: 390, height: 844 };

let browser: Browser | null = null;
let starting: Promise<Browser> | null = null;
let state: BrowserState = 'down';
let lastLaunchError: string | null = null;

const pool = new Map<string, PooledContext>();
/** 全局并发闸：浏览器任务最多 2 个同时进行 */
const gate = pLimit(config.BROWSER_MAX_CONTEXTS);

export function getBrowserState(): BrowserState {
  return state;
}

export function getLastLaunchError(): string | null {
  return lastLaunchError;
}

export async function ensureBrowser(): Promise<Browser> {
  if (browser?.isConnected()) return browser;
  if (starting) return starting;

  starting = (async () => {
    state = 'starting';
    try {
      const args = [
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--renderer-process-limit=2',
        '--disable-features=Translate,MediaRouter',
        '--lang=zh-CN',
      ];
      const launched = await chromium.launch({
        headless: config.headless,
        args,
        ...(config.CHROMIUM_PATH ? { executablePath: config.CHROMIUM_PATH } : {}),
      });
      launched.on('disconnected', () => {
        browser = null;
        state = 'down';
        pool.clear();
      });
      browser = launched;
      state = 'ok';
      lastLaunchError = null;
      return launched;
    } catch (err) {
      state = 'down';
      lastLaunchError = err instanceof Error ? err.message : String(err);
      throw err;
    } finally {
      starting = null;
    }
  })();

  return starting;
}

/** 移动端上下文默认参数（与 Android WebView 一致） */
export function contextOptions(): Parameters<Browser["newContext"]>[0] {
  return {
    viewport: VIEWPORT,
    screen: VIEWPORT,
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 2,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    userAgent: MOBILE_UA,
    extraHTTPHeaders: { 'Accept-Language': 'zh-CN,zh;q=0.9' },
  };
}

/** 去掉自动化特征 */
export async function applyStealth(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    // 常见指纹补全
    Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh'] });
    Object.defineProperty(navigator, 'platform', { get: () => 'Linux armv8l' });

    /*
     * 记录页面创建的 shadow root。
     *
     * 拼多多的滑块验证码（type 22）渲染在一个 attachShadow({mode:'closed'})
     * 的容器里：document.querySelector / element.shadowRoot 都拿不到，
     * 而验证码的 touch 事件只认 #slide-button 本身。不保留引用就完全无法
     * 从外部驱动滑块。这里只在本进程的登录/抓取上下文里记录引用，
     * 不改变 attachShadow 的返回值与行为。
     */
    const origAttachShadow = Element.prototype.attachShadow;
    const roots: Array<{ mode: string | undefined; host: Element; root: ShadowRoot }> = [];
    Object.defineProperty(window, '__eaShadowRoots', { value: roots, configurable: true });
    Element.prototype.attachShadow = function (init: ShadowRootInit): ShadowRoot {
      const root = origAttachShadow.call(this, init);
      try {
        roots.push({ mode: init?.mode, host: this, root });
      } catch {
        // 记录失败不影响页面
      }
      return root;
    };
    const origQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
    window.navigator.permissions.query = ((params: PermissionDescriptor) =>
      params.name === 'notifications'
        ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
        : origQuery(params)) as typeof window.navigator.permissions.query;
  });
}

/** 取或创建账号专属上下文；超出上限时淘汰最久未用的空闲上下文 */
export async function acquireContext(
  accountId: string,
  storageState?: Awaited<ReturnType<BrowserContext['storageState']>>,
): Promise<BrowserContext> {
  const existing = pool.get(accountId);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing.context;
  }

  evictIdle();

  if (pool.size >= config.BROWSER_MAX_CONTEXTS) {
    // 淘汰最久未用者（不区分是否忙碌：单用户场景下任务已由 gate 串行化）
    let oldest: [string, PooledContext] | null = null;
    for (const entry of pool.entries()) {
      if (!oldest || entry[1].lastUsed < oldest[1].lastUsed) oldest = entry;
    }
    if (oldest) {
      const [id, entry] = oldest;
      pool.delete(id);
      await entry.context.close().catch(() => undefined);
    }
  }

  const b = await ensureBrowser();
  const context = await b.newContext({ ...contextOptions(), ...(storageState ? { storageState } : {}) });
  await applyStealth(context);
  pool.set(accountId, { context, lastUsed: Date.now(), accountId });
  return context;
}

/** 登录完成后把原上下文交给账号，保留 Cookie、站点存储及当前会话。 */
export async function adoptLoginContext(loginId: string, accountId: string): Promise<void> {
  const entry = pool.get(loginId);
  if (!entry) throw new Error('登录上下文已关闭，请重新登录');
  await dropContext(accountId);
  pool.delete(loginId);
  pool.set(accountId, { ...entry, accountId, lastUsed: Date.now() });
}

export function releaseContext(accountId: string): void {
  const entry = pool.get(accountId);
  if (entry) entry.lastUsed = Date.now();
}

/** 关闭并移除某账号上下文（账号删除/重新登录时调用） */
export async function dropContext(accountId: string): Promise<void> {
  const entry = pool.get(accountId);
  if (!entry) return;
  pool.delete(accountId);
  await entry.context.close().catch(() => undefined);
}

function evictIdle(): void {
  const now = Date.now();
  for (const [id, entry] of pool) {
    if (now - entry.lastUsed > IDLE_TTL_MS) {
      pool.delete(id);
      void entry.context.close().catch(() => undefined);
    }
  }
}

/** 所有浏览器任务经此执行，保证 ≤ BROWSER_MAX_CONTEXTS 并发 */
export function withBrowserSlot<T>(fn: () => Promise<T>): Promise<T> {
  return gate(fn);
}

export function poolSize(): number {
  return pool.size;
}

export async function shutdownBrowser(): Promise<void> {
  for (const [, entry] of pool) {
    await entry.context.close().catch(() => undefined);
  }
  pool.clear();
  if (browser) {
    await browser.close().catch(() => undefined);
    browser = null;
  }
  state = 'down';
}

/** 定时清理空闲上下文 */
export function startContextJanitor(): NodeJS.Timeout {
  return setInterval(evictIdle, 60_000).unref();
}
