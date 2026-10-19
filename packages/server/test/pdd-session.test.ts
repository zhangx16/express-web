import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserContext, Page } from 'playwright';
import type { AccountRecord } from '../src/services/accounts/repo.js';

vi.mock('../src/browser/pool.js', () => ({
  acquireContext: vi.fn(),
  withBrowserSlot: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock('../src/services/accounts/repo.js', () => ({
  getAccountRecord: vi.fn(),
  setAccountStatus: vi.fn(),
  updateAccountPayload: vi.fn(),
}));

import { acquireContext } from '../src/browser/pool.js';
import { getAccountRecord, updateAccountPayload } from '../src/services/accounts/repo.js';
import { assertPddPageReady, hasPddLogin, isPddChallengeUrl, persistPddSession, safePddVerificationUrl, snapshotPddSession, watchPddPage, withPddSession } from '../src/scrapers/pdd/session.js';

const cookie = 'PDDAccessToken=test-token; pdduid=123';
const browserState = {
  cookies: [{ name: 'PDDAccessToken', value: 'test-token', domain: '.yangkeduo.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'Lax' as const }],
  origins: [{ origin: 'https://mobile.yangkeduo.com', localStorage: [{ name: 'device-state', value: 'unchanged' }] }],
};

function account(status: AccountRecord['status'] = 'ok'): AccountRecord {
  return { id: 'pdd-test', channel: 'pdd', enabled: true, status, payload: { cookie, browserState } } as AccountRecord;
}

function context() {
  return {
    cookies: vi.fn().mockResolvedValue([
      { name: 'PDDAccessToken', value: 'test-token' }, { name: 'pdduid', value: '123' },
    ]),
    storageState: vi.fn().mockResolvedValue(browserState),
    addCookies: vi.fn(),
  } as unknown as BrowserContext;
}

beforeEach(() => { vi.resetAllMocks(); });

describe('PDD session continuity', () => {
  it('requires a token and an identity, accepting the original Android identity variants', () => {
    expect(hasPddLogin('pdduid=123')).toBe(false);
    expect(hasPddLogin('PDDAccessToken=; pdduid=123')).toBe(false);
    for (const name of ['pdduid', 'PASS_ID', 'pdd_user_id', 'pdd_user_uin']) {
      expect(hasPddLogin(`PDDAccessToken=abc==; ${name}=123`)).toBe(true);
    }
  });

  it('saves cookie attributes and site storage, including IndexedDB', async () => {
    const ctx = context();
    const result = await snapshotPddSession(ctx);
    expect(result.browserState).toEqual(browserState);
    expect(ctx.storageState).toHaveBeenCalledWith({ indexedDB: true });
    expect(hasPddLogin(result.cookie)).toBe(true);
  });

  it('does not overwrite valid credentials with anonymous state', async () => {
    const ctx = context();
    vi.mocked(ctx.cookies).mockResolvedValue([]);
    await persistPddSession(ctx, account());
    expect(updateAccountPayload).not.toHaveBeenCalled();
  });

  it('preserves payload metadata when persisting refreshed state', async () => {
    const record = account();
    record.payload.identity = '123';
    await persistPddSession(context(), record);
    expect(updateAccountPayload).toHaveBeenCalledWith(record.id, expect.objectContaining({ identity: '123', browserState }));
  });

  it('restores full state once and never reinjects flattened cookies', async () => {
    const ctx = context();
    const record = account();
    vi.mocked(getAccountRecord).mockReturnValue(record);
    vi.mocked(acquireContext).mockResolvedValue(ctx);
    const first = await withPddSession(record, async (value) => value);
    await withPddSession(record, async () => undefined);
    expect(first).toBe(ctx);
    expect(acquireContext).toHaveBeenCalledWith(record.id, browserState);
    expect(ctx.addCookies).not.toHaveBeenCalled();
  });

  it('stops before opening a browser for challenged or expired accounts', async () => {
    for (const status of ['challenge', 'needs_login'] as const) {
      vi.mocked(getAccountRecord).mockReturnValue(account(status));
      await expect(withPddSession(account(), async () => undefined)).rejects.toThrow();
    }
    expect(acquireContext).not.toHaveBeenCalled();
  });

  it('requires re-login for legacy cookie-only accounts rather than replaying cookies', async () => {
    const record = account();
    delete record.payload.browserState;
    const ctx = context();
    vi.mocked(ctx.cookies).mockResolvedValue([]);
    vi.mocked(getAccountRecord).mockReturnValue(record);
    vi.mocked(acquireContext).mockResolvedValue(ctx);
    await expect(withPddSession(record, async () => undefined)).rejects.toThrow('完整会话');
    expect(ctx.addCookies).not.toHaveBeenCalled();
  });

  it('serializes list and trace work for the same account and rechecks status after waiting', async () => {
    const record = account();
    vi.mocked(getAccountRecord).mockReturnValue(record);
    vi.mocked(acquireContext).mockResolvedValue(context());
    let finish!: () => void;
    let started!: () => void;
    const firstStarted = new Promise<void>((resolve) => { started = resolve; });
    const first = withPddSession(record, async () => {
      started();
      await new Promise<void>((resolve) => { finish = resolve; });
      vi.mocked(getAccountRecord).mockReturnValue(account('challenge'));
    });
    await firstStarted;
    const secondFn = vi.fn();
    const second = withPddSession(record, secondFn);
    const assertion = expect(second).rejects.toThrow('人工验证');
    expect(secondFn).not.toHaveBeenCalled();
    finish();
    await first;
    await assertion;
    expect(secondFn).not.toHaveBeenCalled();
  });
});

describe('PDD challenge detection', () => {
  it('recognizes validation routes without treating ordinary order URLs as challenges', () => {
    for (const path of ['login.html', 'verify.html', 'captcha/index.html', 'psnl_verification.html']) {
      expect(isPddChallengeUrl(`https://mobile.yangkeduo.com/${path}`)).toBe(true);
    }
    expect(isPddChallengeUrl('https://mobile.yangkeduo.com/orders.html?refer=login')).toBe(false);
  });

  it('stops on validation content before further scrolling', async () => {
    const page = { url: () => 'https://mobile.yangkeduo.com/orders.html', evaluate: vi.fn().mockResolvedValue(true) } as unknown as Page;
    await expect(assertPddPageReady(page)).rejects.toThrow('安全验证');
  });

  it('stops on API rate limits even if the page URL has not changed', async () => {
    let respond!: (response: { url: () => string; status: () => number }) => void;
    const page = { url: () => 'https://mobile.yangkeduo.com/orders.html', evaluate: vi.fn().mockResolvedValue(false), on: vi.fn((_event, listener) => { respond = listener; }) } as unknown as Page;
    watchPddPage(page);
    respond({ url: () => 'https://mobile.yangkeduo.com/proxy/api/api/aristotle/order_list_v4', status: () => 429 });
    await expect(assertPddPageReady(page)).rejects.toThrow('HTTP 429');
  });
});


it('does not classify HTTP 403 as a security challenge', async () => {
  let respond!: (response: { url: () => string; status: () => number }) => void;
  const page = {
    url: () => 'https://mobile.yangkeduo.com/orders.html',
    evaluate: vi.fn().mockResolvedValue(false),
    on: vi.fn((_event, listener) => { respond = listener; }),
  } as unknown as Page;
  watchPddPage(page);
  respond({ url: () => 'https://mobile.yangkeduo.com/proxy/api/order_list', status: () => 403 });
  await expect(assertPddPageReady(page)).rejects.toMatchObject({ name: 'NetworkError' });
});

it('ignores unrelated API permission errors', async () => {
  let respond!: (response: { url: () => string; status: () => number }) => void;
  const page = {
    url: () => 'https://mobile.yangkeduo.com/orders.html',
    evaluate: vi.fn().mockResolvedValue(false),
    on: vi.fn((_event, listener) => { respond = listener; }),
  } as unknown as Page;
  watchPddPage(page);
  respond({ url: () => 'https://mobile.yangkeduo.com/proxy/api/recommendation', status: () => 403 });
  await expect(assertPddPageReady(page)).resolves.toBeUndefined();
});

it('classifies login redirects as expired authentication', async () => {
  const page = { url: () => 'https://mobile.yangkeduo.com/login.html' } as unknown as Page;
  await expect(assertPddPageReady(page)).rejects.toMatchObject({ name: 'AuthExpiredError' });
});

it('preserves the first challenge reason when later requests are paused', async () => {
  const record = account('challenge');
  record.statusDetail = '订单页出现安全验证';
  vi.mocked(getAccountRecord).mockReturnValue(record);
  await expect(withPddSession(record, async () => undefined)).rejects.toThrow('订单页出现安全验证');
  expect(acquireContext).not.toHaveBeenCalled();
});

it('honors cooldown without visiting the platform', async () => {
  const record = account('error');
  record.payload.pddRetryAfter = new Date(Date.now() + 60_000).toISOString();
  record.statusDetail = '平台限流';
  vi.mocked(getAccountRecord).mockReturnValue(record);
  await expect(withPddSession(record, async () => undefined)).rejects.toThrow('平台限流');
  expect(acquireContext).not.toHaveBeenCalled();
});

it('only allows platform origins for the verification entry', () => {
  expect(safePddVerificationUrl('https://mobile.yangkeduo.com/verify.html')).toBe('https://mobile.yangkeduo.com/verify.html');
  for (const url of ['https://evil.example/verify', 'javascript:alert(1)', 'https://user:pass@mobile.yangkeduo.com/verify.html']) {
    expect(safePddVerificationUrl(url)).toBe('https://mobile.yangkeduo.com/orders.html');
  }
});
