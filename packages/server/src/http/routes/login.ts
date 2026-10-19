import type { BrowserContext, CDPSession, Page } from 'playwright';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import type { Channel, LoginSessionDto, LoginSessionStatus } from '@ea/shared';
import { getDb } from '../../db/client.js';
import { loginSessions } from '../../db/schema.js';
import { acquireContext, adoptLoginContext, dropContext } from '../../browser/pool.js';
import { eventBus } from '../../events/bus.js';
import { randomToken } from '../../lib/crypto.js';
import { logger } from '../../lib/logger.js';
import { audit } from '../../lib/audit.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { collectCookies, parseCookieHeader } from '../../scrapers/browser/cookies.js';
import {
  getAccount,
  getAccountRecord,
  patchAccount,
  setAccountStatus,
  updateAccountPayload,
  upsertAccount,
  type CookieAccountPayload,
} from '../../services/accounts/repo.js';
import { jdLabelOf, pddLabelOf, tbLabelOf } from '../../services/accounts/labels.js';
import { JD_COOKIE_HOSTS } from '../../scrapers/jd/list.js';
import { snapshotPddSession, isPddChallengeUrl, safePddVerificationUrl, assertPddPageReady } from '../../scrapers/pdd/session.js';
import { PDD_COOKIE_HOSTS } from '../../scrapers/pdd/capture.js';

const SESSION_TTL_MS = 10 * 60 * 1000;
const POLL_MS = 2000;
const PING_MS = 25_000;
const MAX_INPUTS_PER_SEC = 60;

/** 远程登录浏览器的逻辑视口（CSS 像素）；截图帧元数据可能是 2x 物理像素，不能用它做坐标映射 */
const LOGIN_VIEWPORT = { width: 390, height: 844 };
/** 单条输入指令的超时：PDD 上 CDP 触摸命令会永久挂起，必须兜底 */
const INPUT_TIMEOUT_MS = 3000;

const START_URLS: Record<Channel, string> = {
  jd: 'https://plogin.m.jd.com/login/login?appid=300&returnurl=https%3A%2F%2Fhome.m.jd.com%2FmyJd%2Fhome.action',
  taobao: 'https://login.m.taobao.com/login.htm',
  pdd: 'https://mobile.yangkeduo.com/login.html',
};

const LOGIN_HOSTS: Record<Channel, readonly string[]> = {
  jd: [...JD_COOKIE_HOSTS, 'https://plogin.m.jd.com', 'https://m.jd.com', 'https://my.m.jd.com'],
  taobao: [
    'https://h5.m.taobao.com',
    'https://login.m.taobao.com',
    'https://www.taobao.com',
    'https://m.taobao.com',
    'https://h5api.m.taobao.com',
    'https://market.m.taobao.com',
  ],
  pdd: PDD_COOKIE_HOSTS,
};

/** 与 Android 各 LoginActivity 的轮询判定一致 */
function loginComplete(channel: Channel, cookies: string): boolean {
  const map = new Map(parseCookieHeader(cookies).map((p) => [p.name, p.value]));
  switch (channel) {
    case 'jd':
      return Boolean(map.get('pt_key')) && Boolean(map.get('pt_pin'));
    case 'taobao':
      return Boolean(map.get('cookie2')) && Boolean(map.get('unb') || map.get('cookie1'));
    case 'pdd':
      return (
        Boolean(map.get('PDDAccessToken')) &&
        Boolean(map.get('pdduid') || map.get('PASS_ID') || map.get('pdd_user_id') || map.get('pdd_user_uin'))
      );
  }
}

interface SocketLike {
  readyState: number;
  send(data: string | Buffer): void;
  close(code?: number, reason?: string): void;
  ping(): void;
  terminate(): void;
  on(event: 'message', cb: (data: unknown, isBinary: boolean) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
}

interface LoginState {
  id: string;
  channel: Channel;
  accountId: string | null;
  status: LoginSessionStatus;
  expiresAt: string;
  context: BrowserContext | null;
  page: Page | null;
  cdp: CDPSession | null;
  sockets: Set<SocketLike>;
  pollTimer: NodeJS.Timeout | null;
  expiryTimer: NodeJS.Timeout | null;
  pingTimer: NodeJS.Timeout | null;
  starting: Promise<void> | null;
  finishing: boolean;
  inputWindowStart: number;
  inputCount: number;
  /** 拼多多滑块拖拽进行中：down 命中滑块后置位，up 复位 */
  sliderDragging: boolean;
  /** 登录 Cookie 出现后等待页面完成跳转和站点存储写入。 */
  loginReadyAt: number;
  verifying: boolean;
  verificationConfirmed: boolean;

}

const sessions = new Map<string, LoginState>();

function publishStatus(state: LoginState, status: LoginSessionStatus, message?: string): void {
  state.status = status;
  eventBus.publish({
    type: 'login.status',
    sessionId: state.id,
    channel: state.channel,
    status,
    ...(message ? { message } : {}),
  });
  broadcast(state, { type: 'status', status, ...(message ? { message } : {}) });
}

function broadcast(state: LoginState, payload: unknown): void {
  const text = JSON.stringify(payload);
  for (const socket of state.sockets) {
    if (socket.readyState !== 1) continue;
    try {
      socket.send(text);
    } catch {
      // 单个连接异常不影响其他连接
    }
  }
}

function broadcastFrame(state: LoginState, data: Buffer): void {
  for (const socket of state.sockets) {
    if (socket.readyState !== 1) continue;
    try {
      socket.send(data);
    } catch {
      // 同上
    }
  }
}

function toDto(state: LoginState): LoginSessionDto {
  return {
    sessionId: state.id,
    channel: state.channel,
    status: state.status,
    wsUrl: `/api/ws/login/${state.id}`,
    expiresAt: state.expiresAt,
    accountId: state.accountId,
  };
}

function persistStatus(state: LoginState, status: LoginSessionStatus, message?: string): void {
  getDb()
    .update(loginSessions)
    .set({
      status,
      message: message ?? null,
      accountId: state.accountId,
      ...(status === 'ok' || status === 'failed' || status === 'cancelled' || status === 'expired'
        ? { finishedAt: new Date().toISOString() }
        : {}),
    })
    .where(eq(loginSessions.id, state.id))
    .run();
}

async function teardown(state: LoginState): Promise<void> {
  if (state.pollTimer) clearInterval(state.pollTimer);
  if (state.expiryTimer) clearTimeout(state.expiryTimer);
  if (state.pingTimer) clearInterval(state.pingTimer);
  state.pollTimer = null;
  state.expiryTimer = null;
  state.pingTimer = null;

  if (state.cdp) {
    try {
      await state.cdp.send('Page.stopScreencast');
    } catch {
      // 页面可能已关闭
    }
    try {
      await state.cdp.detach();
    } catch {
      // 同上
    }
    state.cdp = null;
  }
  if (state.page) {
    await state.page.close().catch(() => undefined);
    state.page = null;
  }
  await dropContext(`login:${state.id}`);
  state.context = null;
}

async function finish(
  state: LoginState,
  status: LoginSessionStatus,
  message?: string,
): Promise<void> {
  if (state.finishing) return;
  state.finishing = true;
  persistStatus(state, status, message);
  publishStatus(state, status, message);
  for (const socket of state.sockets) {
    try {
      socket.close(1000, status);
    } catch {
      // 已关闭
    }
  }
  state.sockets.clear();
  await teardown(state);
  sessions.delete(state.id);
}

async function fail(state: LoginState, err: unknown): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  // 必须带上 message：否则 journalctl 里只剩一句 "remote login failed"，
  // 无法区分 EACCES / 超时 / 风控等原因。
  logger.warn(
    { sessionId: state.id, channel: state.channel, err: message.slice(0, 200) },
    'remote login failed',
  );
  await finish(state, 'failed', message.slice(0, 200));
}

async function saveAccount(state: LoginState): Promise<string> {
  const hosts = LOGIN_HOSTS[state.channel];
  const context = state.context;
  if (!context) throw new Error('浏览器上下文已关闭');

  const cookie = await collectCookies(context, hosts);
  if (!loginComplete(state.channel, cookie)) {
    throw new Error('登录态不完整，请重试');
  }
  const payload: CookieAccountPayload = state.channel === 'pdd'
    ? await snapshotPddSession(context)
    : { cookie };
  const label =
    state.channel === 'jd' ? jdLabelOf(cookie) : state.channel === 'taobao' ? tbLabelOf(cookie) : pddLabelOf(cookie);
  return savePayload(state, payload, label);
}

function savePayload(state: LoginState, payload: CookieAccountPayload, label: string): string {
  if (state.accountId) {
    const existing = getAccount(state.accountId);
    if (existing && existing.channel === state.channel) {
      updateAccountPayload(existing.id, payload);
      setAccountStatus(existing.id, 'ok', null);
      if (existing.label !== label) {
        try {
          patchAccount(existing.id, { label });
        } catch {
          // 标签冲突时保留原标签
        }
      }
      return existing.id;
    }
  }
  const account = upsertAccount({ channel: state.channel, label, payload });
  return account.id;
}

async function startEngine(state: LoginState): Promise<void> {
  if (state.page || state.finishing) return;

  const previous = state.channel === 'pdd' && state.accountId ? getAccountRecord(state.accountId) : null;
  state.verifying = Boolean(previous?.status === 'challenge' && previous.payload.browserState);
  if (state.verifying && previous) {
    await acquireContext(previous.id, previous.payload.browserState);
    await adoptLoginContext(previous.id, `login:${state.id}`);
  }
  const context = await acquireContext(`login:${state.id}`);
  state.context = context;

  const page = await context.newPage();
  state.page = page;

  page.on('framenavigated', (frame) => {
    if (frame !== page.mainFrame()) return;
    broadcast(state, { type: 'page', url: frame.url() });
  });

  const cdp = await context.newCDPSession(page);
  state.cdp = cdp;
  cdp.on('Page.screencastFrame', (frame) => {
    void cdp
      .send('Page.screencastFrameAck', { sessionId: frame.sessionId })
      .catch(() => undefined);
    // 帧元数据里的 deviceWidth/Height 是设备像素（可能是 780x1688），
    // 而 JPEG 实际始终是 390x844。前端按逻辑视口做坐标映射，这里必须广播逻辑尺寸。
    const viewport = page.viewportSize() ?? LOGIN_VIEWPORT;
    broadcast(state, { type: 'frame', width: viewport.width, height: viewport.height });
    broadcastFrame(state, Buffer.from(frame.data, 'base64'));
  });
  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: 60,
    maxWidth: 390,
    maxHeight: 844,
    everyNthFrame: 1,
  });

  const startUrl = state.verifying
    ? safePddVerificationUrl(previous?.payload.verificationUrl)
    : START_URLS[state.channel];
  await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch((err) => {
    logger.warn({ err, sessionId: state.id }, 'remote login navigate failed');
  });
  broadcast(state, { type: 'page', url: page.url() });

  // 淘宝海外版与拼多多都默认美国区号；导航稳定后切到中国大陆 +86
  if (state.channel === 'taobao' || state.channel === 'pdd') {
    await delay(1000);
    void applyChannelDefaults(state).catch(() => undefined);
  }

  publishStatus(state, 'running', state.verifying ? '请在原会话完成安全验证，再点击“我已完成登录”' : undefined);
  persistStatus(state, 'running');

  state.pollTimer = setInterval(() => {
    void pollLogin(state);
  }, POLL_MS);
  state.pollTimer.unref?.();

  state.pingTimer = setInterval(() => {
    for (const socket of state.sockets) {
      try {
        socket.ping();
      } catch {
        // 忽略
      }
    }
  }, PING_MS);
  state.pingTimer.unref?.();
}

async function pollLogin(state: LoginState): Promise<void> {
  if (state.finishing || !state.context) return;
  try {
    const hosts = LOGIN_HOSTS[state.channel];
    const accountCookies = await collectCookies(state.context, hosts);
    if (!loginComplete(state.channel, accountCookies)) {
      state.loginReadyAt = 0;
      return;
    }
    if (state.channel === 'pdd') {
      if (!state.page || isPddChallengeUrl(state.page.url())) {
        state.loginReadyAt = 0;
        return;
      }
      try {
        await assertPddPageReady(state.page);
      } catch {
        state.loginReadyAt = 0;
        state.verificationConfirmed = false;
        return;
      }
      if (state.verifying && !state.verificationConfirmed) return;
      if (!state.loginReadyAt) state.loginReadyAt = Date.now();
      if (Date.now() - state.loginReadyAt < 4000) return;
    }

    state.finishing = true; // 防止并发重复落库
    try {
      const accountId = await saveAccount(state);
      state.accountId = accountId;
      if (state.channel === 'pdd') await adoptLoginContext(`login:${state.id}`, accountId);
      persistStatus(state, 'ok');
      publishStatus(state, 'ok');
      audit(null, 'login.ok', { channel: state.channel, accountId });
      for (const socket of state.sockets) {
        try {
          socket.close(1000, 'ok');
        } catch {
          // 已关闭
        }
      }
      state.sockets.clear();
      await teardown(state);
      sessions.delete(state.id);
    } catch (err) {
      state.finishing = false;
      throw err;
    }
  } catch (err) {
    if (!state.finishing) await fail(state, err);
  }
}

/** 输入节流：每秒最多 60 个事件 */
function allowInput(state: LoginState): boolean {
  const now = Date.now();
  if (now - state.inputWindowStart >= 1000) {
    state.inputWindowStart = now;
    state.inputCount = 0;
  }
  state.inputCount += 1;
  return state.inputCount <= MAX_INPUTS_PER_SEC;
}

interface InputMessage {
  type: 'pointer' | 'wheel' | 'key' | 'text' | 'navigate' | 'done' | 'cancel' | 'ping';
  action?: 'down' | 'up' | 'move' | 'back' | 'reload';
  x?: number;
  y?: number;
  deltaY?: number;
  key?: string;
  code?: string;
  text?: string;
  url?: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * CDP 输入指令一律加超时：拼多多的页面在部分情况下会让
 * Input.dispatchTouchEvent 永远不返回，卡住整个输入通道。
 */
async function sendCdp(cdp: CDPSession, method: string, params: Record<string, unknown>): Promise<void> {
  const send = (
    cdp.send as unknown as (m: string, p?: Record<string, unknown>) => Promise<unknown>
  )(method, params).catch(() => undefined);
  await Promise.race([send, delay(INPUT_TIMEOUT_MS)]);
}

/**
 * 拼多多页面的输入策略。
 *
 * 实测（移动 UA + 移动仿真）下拼多多会吞掉所有受信任的 CDP 输入：
 * 鼠标、触摸、滚轮、键盘都不会产生任何页面事件，dispatchTouchEvent
 * 甚至可能永久挂起。但页面内派发的合成 pointer/mouse/click 事件有效，
 * 且 Input.insertText 在 JS 聚焦输入框后能正常写入。
 *
 * 京东、淘宝的验证码依赖真实触摸序列，所以合成事件只用于拼多多。
 */
function useSyntheticInput(channel: Channel): boolean {
  return channel === 'pdd';
}

/** 在页面内派发合成 pointerdown/mousedown（down）或 pointerup/mouseup/click（up） */
async function dispatchSyntheticPointer(
  state: LoginState,
  action: 'down' | 'up',
  x: number,
  y: number,
): Promise<void> {  const page = state.page;
  if (!page || page.isClosed()) return;
  await page
    .evaluate(
      ([px, py, phase]) => {
        const hit = document.elementFromPoint(px, py);

        /*
         * 拼多多的登录协议勾选：
         *   <p class="agreement-wrap"><i class="agreement-icon"></i>
         *     <label class="agreement-label">同意</label><a class="link">服务协议与隐私政策</a></p>
         * 页面里没有真正的 checkbox，`<label for="agreement">` 指向的元素也不存在，
         * 勾选逻辑只挂在 `<i class="agreement-icon">` 上。真实点击靠冒泡能生效，
         * 但下面「向上找可点击祖先」会把点击重定向到外层 <p>，导致怎么点都勾不上。
         * 这里对协议行做特判：只要不是点在协议链接上，就一律派发到图标本身。
         */
        let wrap = hit?.closest('.agreement-wrap') ?? null;
        // 坐标偶尔会因为页面缩放/容器偏移落在元素外，导致 elementFromPoint 为 null；
        // 对协议行放宽 24px 容差，保证「同意」始终点得中。
        if (!wrap) {
          for (const candidate of document.querySelectorAll('.agreement-wrap')) {
            const rect = candidate.getBoundingClientRect();
            if (
              px >= rect.left - 24 &&
              px <= rect.right + 24 &&
              py >= rect.top - 24 &&
              py <= rect.bottom + 24
            ) {
              wrap = candidate;
              break;
            }
          }
        }
        const onAgreementLink = Boolean(hit?.closest('.agreement-wrap .link, .agreement-wrap a'));
        const icon = wrap?.querySelector('.agreement-icon') ?? null;
        if (icon && !onAgreementLink) {
          const common = { bubbles: true, cancelable: true, composed: true, view: window };
          const point = { clientX: px, clientY: py };
          if (phase === 'down') {
            icon.dispatchEvent(
              new PointerEvent('pointerdown', {
                ...common,
                ...point,
                pointerType: 'touch',
                pointerId: 1,
                isPrimary: true,
              }),
            );
            icon.dispatchEvent(
              new MouseEvent('mousedown', { ...common, ...point, button: 0, buttons: 1 }),
            );
            return;
          }
          icon.dispatchEvent(
            new PointerEvent('pointerup', {
              ...common,
              ...point,
              pointerType: 'touch',
              pointerId: 1,
              isPrimary: true,
            }),
          );
          icon.dispatchEvent(new MouseEvent('mouseup', { ...common, ...point, button: 0 }));
          icon.dispatchEvent(new MouseEvent('click', { ...common, ...point, button: 0 }));
          return;
        }

        if (!hit) return;
        /*
         * 直接在命中的元素上派发，靠冒泡让祖先的处理器收到事件 —— 这与真实点击一致。
         * 曾经这里会向上找「可点击祖先」（cursor:pointer / role=button / onclick），
         * 但拼多多的「发送验证码」是 <div id="captcha-btn" class="captcha-btn">，
         * cursor 为 auto、没有 role，整条祖先链都没有可点击标记，结果点击被一路
         * 派发到 <html> 上，按钮自己的处理器永远收不到事件，表现为「点发送验证码没反应」。
         */
        const target: Element = hit;
        const common = { bubbles: true, cancelable: true, composed: true, view: window };
        if (phase === 'down') {
          target.dispatchEvent(
            new PointerEvent('pointerdown', {
              ...common,
              pointerType: 'touch',
              pointerId: 1,
              isPrimary: true,
              clientX: px,
              clientY: py,
            }),
          );
          target.dispatchEvent(
            new MouseEvent('mousedown', { ...common, clientX: px, clientY: py, button: 0, buttons: 1 }),
          );
          if (
            target instanceof HTMLInputElement ||
            target instanceof HTMLTextAreaElement ||
            (target instanceof HTMLElement && target.isContentEditable)
          ) {
            target.focus();
          }
          return;
        }
        target.dispatchEvent(
          new PointerEvent('pointerup', {
            ...common,
            pointerType: 'touch',
            pointerId: 1,
            isPrimary: true,
            clientX: px,
            clientY: py,
          }),
        );
        target.dispatchEvent(new MouseEvent('mouseup', { ...common, clientX: px, clientY: py, button: 0 }));
        target.dispatchEvent(new MouseEvent('click', { ...common, clientX: px, clientY: py, button: 0 }));
      },
      [x, y, action] as const,
    )
    .catch(() => undefined);
}

/**
 * 拼多多的滑块验证码（type 22）渲染在 closed shadow root 里，
 * 且 touch 事件只认 #slide-button 本身，必须直接派发合成 TouchEvent。
 *
 * 说明：
 * - 页面在移动仿真下 S = 'ontouchstart' in document 为 true，React 绑定的是
 *   onTouchStart/onTouchMove/onTouchEnd，所以这里只发 touch 系列事件。
 * - 事件必须派发到 closed root 内部元素上，从 host 或 document 派发不会
 *   向下进入 shadow tree。
 * - 滑块按 clientX 差值计算位移，前端多次 WS 消息的坐标序列就是拖拽轨迹。
 * - 返回 false 表示当前页面没有滑块，调用方回退到普通合成点击。
 */
async function dispatchSyntheticTouch(
  state: LoginState,
  action: 'down' | 'move' | 'up',
  x: number,
  y: number,
): Promise<boolean> {
  const page = state.page;
  if (!page || page.isClosed()) return false;
  return page
    .evaluate(
      ([px, py, phase]) => {
        type CapturedRoot = { mode?: string; host: Element; root: ShadowRoot };
        const roots =
          (window as unknown as { __eaShadowRoots?: CapturedRoot[] }).__eaShadowRoots ?? [];
        let target: Element | null = null;
        for (const rec of roots) {
          const btn = rec.root?.querySelector?.('#slide-button');
          if (btn) {
            target = btn;
            break;
          }
        }
        if (!target) return false;

        // 只有按下落在滑块按钮上、或拖拽已经开始时才处理；点对话框其它位置
        // （关闭、刷新、遮罩）仍然走普通合成点击。24px 容差与协议行一致。
        const rect = target.getBoundingClientRect();
        const onButton =
          px >= rect.left - 24 &&
          px <= rect.right + 24 &&
          py >= rect.top - 24 &&
          py <= rect.bottom + 24;
        if (phase === 'down' && !onButton) return false;
        // 拖拽中滑块会跟着手指移动，命中判定不再可靠；用页面内状态记住是否在拖。
        const store = window as unknown as { __eaSliderDragging?: boolean };
        if (phase !== 'down' && !onButton && !store.__eaSliderDragging) return false;
        if (phase === 'down') store.__eaSliderDragging = true;
        if (phase === 'up') store.__eaSliderDragging = false;

        const touch = new Touch({
          identifier: 1,
          target,
          clientX: px,
          clientY: py,
          pageX: px,
          pageY: py,
          screenX: px,
          screenY: py,
          radiusX: 2,
          radiusY: 2,
          force: 1,
        });
        const type = phase === 'down' ? 'touchstart' : phase === 'move' ? 'touchmove' : 'touchend';
        const ended = type === 'touchend';
        target.dispatchEvent(
          new TouchEvent(type, {
            bubbles: true,
            cancelable: true,
            composed: true,
            touches: ended ? [] : [touch],
            targetTouches: ended ? [] : [touch],
            changedTouches: [touch],
          }),
        );
        return true;
      },
      [x, y, action] as const,
    )
    .catch(() => false);
}

/** 拼多多滚轮兜底：CDP 滚轮无效，直接滚动点击位置下最近的可滚动容器 */
async function dispatchSyntheticWheel(
  state: LoginState,
  x: number,
  y: number,
  deltaY: number,
): Promise<void> {
  const page = state.page;
  if (!page || page.isClosed()) return;
  await page
    .evaluate(
      ([px, py, dy]) => {
        let element = document.elementFromPoint(px, py);
        while (element && element !== document.body) {
          const style = getComputedStyle(element);
          if (
            (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
            element.scrollHeight > element.clientHeight
          ) {
            element.scrollBy(0, dy);
            return;
          }
          element = element.parentElement;
        }
        window.scrollBy(0, dy);
      },
      [x, y, deltaY] as const,
    )
    .catch(() => undefined);
}

/** 拼多多键盘兜底：CDP 按键无效；退格直接改输入框并补发 input 事件 */
async function dispatchSyntheticKey(state: LoginState, key: string, code: string): Promise<void> {
  const page = state.page;
  if (!page || page.isClosed()) return;
  await page
    .evaluate(
      ([pressedKey, pressedCode]) => {
        const active = document.activeElement;
        if (
          (pressedKey === 'Backspace' || pressedKey === 'Delete') &&
          (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)
        ) {
          const start = active.selectionStart ?? active.value.length;
          const end = active.selectionEnd ?? start;
          if (start !== end) {
            active.setRangeText('', start, end, 'end');
          } else if (pressedKey === 'Backspace' && start > 0) {
            active.setRangeText('', start - 1, start, 'end');
          } else if (pressedKey === 'Delete' && start < active.value.length) {
            active.setRangeText('', start, start + 1, 'end');
          } else {
            return;
          }
          active.dispatchEvent(
            new InputEvent('input', {
              bubbles: true,
              inputType:
                pressedKey === 'Backspace' ? 'deleteContentBackward' : 'deleteContentForward',
            }),
          );
          return;
        }
        (active ?? document.body).dispatchEvent(
          new KeyboardEvent('keydown', {
            key: pressedKey,
            code: pressedCode,
            bubbles: true,
            cancelable: true,
          }),
        );
      },
      [key, code] as const,
    )
    .catch(() => undefined);
}

/** 键盘按键的虚拟键码（insertText 之外的分支需要它） */
const VIRTUAL_KEYS: Record<string, number> = {
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Escape: 27,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Delete: 46,
};

/**
 * 登录页默认地区修正：
 * - 淘宝海外版默认美国，`<select>` 的 value 是 JSON 字符串，必须同时派发 input/change；
 * - 拼多多默认美国且区号为空，需要打开国家/地区弹层并点选「中国大陆 +86」。
 */
async function applyChannelDefaults(state: LoginState): Promise<void> {
  if (state.channel === 'pdd') {
    await applyPddChinaPrefix(state);
    return;
  }
  if (state.channel !== 'taobao') return;
  const page = state.page;
  if (!page) return;

  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (state.finishing || page.isClosed()) return;
    const applied = await page
      .evaluate(() => {
        const select = document.querySelector<HTMLSelectElement>('select.native-phone-code-select');
        if (!select) return false;
        const current = select.options[select.selectedIndex];
        try {
          const parsed = current ? (JSON.parse(current.value) as { countryCode?: string; phoneCode?: string }) : null;
          if (parsed && (parsed.countryCode === 'CN' || parsed.phoneCode === '86')) return true;
        } catch {
          // 当前值不是 JSON，继续找中国选项
        }
        for (const option of Array.from(select.options)) {
          let value: { countryCode?: string; phoneCode?: string } | null = null;
          try {
            value = JSON.parse(option.value) as { countryCode?: string; phoneCode?: string };
          } catch {
            continue;
          }
          if (value && (value.countryCode === 'CN' || value.phoneCode === '86')) {
            select.value = option.value;
            select.dispatchEvent(new Event('input', { bubbles: true }));
            select.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          }
        }
        return false;
      })
      .catch(() => false);
    if (applied) return;
    await delay(500);
  }
}

/**
 * 拼多多默认「美国」且区号为空。页面上没有原生 select，必须点开国家/地区
 * 弹层再点「中国大陆 +86」；弹层由页面内合成事件驱动（CDP 输入在 PDD 上被吞）。
 */
async function applyPddChinaPrefix(state: LoginState): Promise<void> {
  const page = state.page;
  if (!page) return;

  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (state.finishing || page.isClosed()) return;
    const applied = await page
      .evaluate(() => {
        const country = document.querySelector('.country-name')?.textContent?.trim() ?? '';
        const codeInput = document.querySelector<HTMLInputElement>('.internation-code-input');
        if (country === '中国大陆' && codeInput?.value === '86') return true;

        const fire = (target: Element): void => {
          const rect = target.getBoundingClientRect();
          const init = {
            bubbles: true,
            cancelable: true,
            composed: true,
            clientX: rect.x + rect.width / 2,
            clientY: rect.y + rect.height / 2,
            view: window,
          };
          target.dispatchEvent(
            new PointerEvent('pointerdown', {
              ...init,
              pointerType: 'touch',
              pointerId: 1,
              isPrimary: true,
            }),
          );
          target.dispatchEvent(new MouseEvent('mousedown', { ...init, button: 0, buttons: 1 }));
          target.dispatchEvent(
            new PointerEvent('pointerup', { ...init, pointerType: 'touch', pointerId: 1, isPrimary: true }),
          );
          target.dispatchEvent(new MouseEvent('mouseup', { ...init, button: 0 }));
          target.dispatchEvent(new MouseEvent('click', { ...init, button: 0 }));
        };

        // 点「国家/地区」后页面会跳转到 commercial_pre_orders.html 的弹层页，
        // 那里没有 .internation-country-wrap，只能直接找 +86 所在行。
        const list = document.querySelector('.internation_code');
        if (list) {
          const code = Array.from(list.querySelectorAll('.code')).find(
            (el) => (el.textContent ?? '').trim() === '+86',
          );
          const row = code?.closest('.item');
          if (!row) return false;
          fire(row);
          return false;
        }

        const wrap = document.querySelector('.internation-country-wrap');
        if (!wrap) return false;
        fire(wrap);
        return false;
      })
      .catch(() => false);
    if (applied) return;
    await delay(700);
  }
}

/**
 * 判断点击位置是不是输入框，并告诉前端是否需要唤起手机输入法。
 * 前端在 pointerdown 时同步聚焦一个隐藏输入框（必须在用户手势里，
 * 否则 iOS 不允许弹键盘），随后根据这里的结果决定保留还是失焦。
 */
async function reportEditable(state: LoginState, x: number, y: number): Promise<void> {
  const page = state.page;
  if (!page || page.isClosed()) return;
  const editable = await page
    .evaluate(
      ([px, py]) => {
        const element = document.elementFromPoint(px, py);
        if (!element) return false;
        const tag = element.tagName;
        if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
        if (tag === 'INPUT') {
          const type = (element as HTMLInputElement).type;
          return !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color'].includes(type);
        }
        return (element as HTMLElement).isContentEditable === true;
      },
      [x, y] as const,
    )
    .catch(() => false);
  broadcast(state, { type: 'editable', editable, x, y });
}

async function handleInput(state: LoginState, msg: InputMessage): Promise<void> {
  if (msg.type === 'done') {
    state.verificationConfirmed = true;
    await pollLogin(state);
    return;
  }
  if (msg.type === 'cancel') {
    await finish(state, 'cancelled', '用户取消');
    return;
  }
  if (msg.type === 'ping') {
    broadcast(state, { type: 'pong' });
    return;
  }
  if (!state.page || !state.cdp) return;
  if (!allowInput(state)) return;

  const cdp = state.cdp;
  const viewport = state.page.viewportSize() ?? LOGIN_VIEWPORT;
  const x = clamp(Math.round(msg.x ?? 0), 0, viewport.width - 1);
  const y = clamp(Math.round(msg.y ?? 0), 0, viewport.height - 1);

  switch (msg.type) {
    case 'pointer': {
      if (msg.action === 'down') void reportEditable(state, x, y);
      if (useSyntheticInput(state.channel)) {
        // 拼多多的滑块验证码只能靠页面内合成 touch 事件驱动。按下落在滑块上、
        // 或拖拽已开始时走 touch 序列（含 move），其它控件仍然只处理按下/抬起。
        if (msg.action === 'move') {
          if (!state.sliderDragging) return;
          if (await dispatchSyntheticTouch(state, 'move', x, y)) return;
          state.sliderDragging = false;
          return;
        }
        if (msg.action === 'down' && (await dispatchSyntheticTouch(state, 'down', x, y))) {
          state.sliderDragging = true;
          return;
        }
        if (msg.action === 'up' && state.sliderDragging) {
          state.sliderDragging = false;
          await dispatchSyntheticTouch(state, 'up', x, y);
          return;
        }
        if (msg.action === 'down' || msg.action === 'up') {
          await dispatchSyntheticPointer(state, msg.action, x, y);
        }
        return;
      }
      const type =
        msg.action === 'down' ? 'touchStart' : msg.action === 'up' ? 'touchEnd' : 'touchMove';
      const touchPoints = msg.action === 'up' ? [] : [{ x, y, id: 0 }];
      await sendCdp(cdp, 'Input.dispatchTouchEvent', { type, touchPoints });
      return;
    }
    case 'wheel':
      if (useSyntheticInput(state.channel)) {
        await dispatchSyntheticWheel(state, x, y, msg.deltaY ?? 0);
        return;
      }
      await sendCdp(cdp, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x,
        y,
        deltaX: 0,
        deltaY: msg.deltaY ?? 0,
      });
      return;
    case 'key': {
      const key = msg.key ?? '';
      const code = msg.code ?? '';
      if (useSyntheticInput(state.channel)) {
        if (msg.action !== 'up') await dispatchSyntheticKey(state, key, code);
        return;
      }
      await sendCdp(cdp, 'Input.dispatchKeyEvent', {
        type: msg.action === 'up' ? 'keyUp' : 'keyDown',
        key,
        code,
        windowsVirtualKeyCode:
          VIRTUAL_KEYS[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0),
      });
      return;
    }
    case 'text':
      if (msg.text) {
        await sendCdp(cdp, 'Input.insertText', { text: msg.text });
      }
      return;
    case 'navigate':
      if (msg.action === 'back') {
        await state.page.goBack({ timeout: 10_000 }).catch(() => undefined);
      } else if (msg.url) {
        await state.page.goto(msg.url, { waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => undefined);
      } else {
        await state.page.reload({ timeout: 30_000 }).catch(() => undefined);
      }
      return;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function attachSocket(state: LoginState, socket: SocketLike): void {
  state.sockets.add(socket);

  socket.on('message', (raw) => {
    let msg: InputMessage;
    try {
      const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
      msg = JSON.parse(text) as InputMessage;
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== 'string') return;
    void handleInput(state, msg).catch((err) => {
      logger.debug({ err, sessionId: state.id }, 'login input failed');
    });
  });

  socket.on('close', () => {
    state.sockets.delete(socket);
  });
  socket.on('error', () => {
    state.sockets.delete(socket);
  });

  if (state.page) {
    broadcast(state, { type: 'page', url: state.page.url() });
    broadcast(state, { type: 'status', status: state.status });
  }
  if (!state.starting) {
    state.starting = startEngine(state).catch((err) => {
      void fail(state, err);
    });
  }
}

export async function loginRoutes(app: FastifyInstance): Promise<void> {
  app.post('/login/sessions', async (req) => {
    const body = req.body as { channel?: string; accountId?: string; startUrl?: string };
    const channel = body?.channel;
    if (channel !== 'jd' && channel !== 'taobao' && channel !== 'pdd') {
      throw new ValidationError('渠道不存在');
    }
    if (body.startUrl) throw new ValidationError('不支持自定义登录地址');

    let accountId: string | null = null;
    if (body.accountId) {
      const account = getAccount(body.accountId);
      if (!account) throw new NotFoundError('账号不存在');
      if (account.channel !== channel) throw new ValidationError('账号渠道不匹配');
      accountId = account.id;
    }

    const id = randomToken(18);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + SESSION_TTL_MS).toISOString();

    getDb()
      .insert(loginSessions)
      .values({
        id,
        channel,
        accountId,
        status: 'pending',
        createdAt: now.toISOString(),
        expiresAt,
      })
      .run();

    const state: LoginState = {
      id,
      channel,
      accountId,
      status: 'pending',
      expiresAt,
      context: null,
      page: null,
      cdp: null,
      sockets: new Set(),
      pollTimer: null,
      expiryTimer: null,
      pingTimer: null,
      starting: null,
      finishing: false,
      inputWindowStart: Date.now(),
      inputCount: 0,
      sliderDragging: false,
      loginReadyAt: 0,
      verifying: false,
      verificationConfirmed: false,
    };
    sessions.set(id, state);

    state.expiryTimer = setTimeout(() => {
      void finish(state, 'expired', '登录会话已过期');
    }, SESSION_TTL_MS);
    state.expiryTimer.unref?.();

    audit(req, 'login.create', { sessionId: id, channel, accountId });
    return toDto(state);
  });

  app.get('/login/sessions/:sessionId', async (req) => {
    const { sessionId } = req.params as { sessionId: string };
    const state = sessions.get(sessionId);
    if (state) return toDto(state);

    const row = getDb().select().from(loginSessions).where(eq(loginSessions.id, sessionId)).get();
    if (!row) throw new NotFoundError('登录会话不存在');
    return {
      sessionId: row.id,
      channel: row.channel as Channel,
      status: row.status as LoginSessionStatus,
      wsUrl: `/api/ws/login/${row.id}`,
      expiresAt: row.expiresAt,
      accountId: row.accountId,
    } satisfies LoginSessionDto;
  });

  app.delete('/login/sessions/:sessionId', async (req) => {
    const { sessionId } = req.params as { sessionId: string };
    const state = sessions.get(sessionId);
    if (state) {
      await finish(state, 'cancelled', '用户取消');
      return { ok: true };
    }
    const row = getDb().select().from(loginSessions).where(eq(loginSessions.id, sessionId)).get();
    if (!row) throw new NotFoundError('登录会话不存在');
    return { ok: true };
  });

  app.get('/ws/login/:sessionId', { websocket: true }, (socket, req) => {
    handleUpgrade(socket as unknown as SocketLike, req);
  });
}

function handleUpgrade(socket: SocketLike, req: FastifyRequest): void {
  const { sessionId } = req.params as { sessionId: string };
  const state = sessions.get(sessionId);
  if (!state) {
    socket.close(4404, 'session_not_found');
    return;
  }
  if (state.status === 'ok' || state.status === 'failed' || state.status === 'cancelled' || state.status === 'expired') {
    socket.close(4409, 'session_finished');
    return;
  }
  if (!req.auth) {
    socket.close(4401, 'unauthorized');
    return;
  }
  attachSocket(state, socket);
}

/** 进程退出时释放所有远程登录浏览器 */
export async function closeAllLoginSessions(): Promise<void> {
  for (const state of [...sessions.values()]) {
    try {
      await finish(state, 'cancelled', '服务重启');
    } catch {
      // 忽略
    }
  }
  sessions.clear();
}
