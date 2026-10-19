import { afterEach, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('../src/browser/pool.js', () => ({ acquireContext: vi.fn(), adoptLoginContext: vi.fn(), dropContext: vi.fn() }));
vi.mock('../src/services/accounts/repo.js', () => ({ getAccount: vi.fn(), getAccountRecord: vi.fn(), patchAccount: vi.fn(), setAccountStatus: vi.fn(), updateAccountPayload: vi.fn(), upsertAccount: vi.fn() }));
vi.mock('../src/db/client.js', () => ({
  getDb: () => ({
    insert: () => ({ values: () => ({ run: vi.fn() }) }),
    update: () => ({ set: () => ({ where: () => ({ run: vi.fn() }) }) }),
  }),
}));
vi.mock('../src/events/bus.js', () => ({ eventBus: { publish: vi.fn() } }));
vi.mock('../src/lib/audit.js', () => ({ audit: vi.fn() }));

import { acquireContext, adoptLoginContext } from '../src/browser/pool.js';
import { getAccount, getAccountRecord, setAccountStatus, updateAccountPayload } from '../src/services/accounts/repo.js';
import { closeAllLoginSessions, loginRoutes } from '../src/http/routes/login.js';

afterEach(async () => {
  await closeAllLoginSessions();
  vi.useRealTimers();
  vi.resetAllMocks();
});

it('reuses the challenged account session and waits for manual confirmation before clearing challenge', async () => {
  vi.useFakeTimers();
  const browserState = { cookies: [], origins: [] };
  const record = { id: 'pdd-account', channel: 'pdd', status: 'challenge', label: 'pdd', enabled: true, payload: { cookie: 'PDDAccessToken=token; pdduid=123', browserState, verificationUrl: 'https://mobile.yangkeduo.com/orders.html' } };
  vi.mocked(getAccountRecord).mockReturnValue(record as ReturnType<typeof getAccountRecord>);
  vi.mocked(getAccount).mockReturnValue(record as ReturnType<typeof getAccount>);
  const page = {
    on: vi.fn(), viewportSize: () => ({ width: 390, height: 844 }),
    goto: vi.fn().mockResolvedValue(null), url: () => record.payload.verificationUrl,
    isClosed: () => false, evaluate: vi.fn().mockResolvedValue(false), close: vi.fn().mockResolvedValue(undefined),
  };
  const cdp = { on: vi.fn(), send: vi.fn().mockResolvedValue(undefined), detach: vi.fn().mockResolvedValue(undefined) };
  const context = {
    newPage: vi.fn().mockResolvedValue(page), newCDPSession: vi.fn().mockResolvedValue(cdp),
    cookies: vi.fn().mockResolvedValue([{ name: 'PDDAccessToken', value: 'token' }, { name: 'pdduid', value: '123' }]),
    storageState: vi.fn().mockResolvedValue(browserState),
  };
  vi.mocked(acquireContext).mockResolvedValue(context as Awaited<ReturnType<typeof acquireContext>>);
  let create!: (req: unknown) => Promise<{ sessionId: string }>;
  let connect!: (socket: unknown, req: unknown) => void;
  const app = {
    post: (_path: string, handler: typeof create) => { create = handler; },
    get: (path: string, ...args: unknown[]) => { if (path === '/ws/login/:sessionId') connect = args[1] as typeof connect; },
    delete: vi.fn(),
  };
  await loginRoutes(app as unknown as FastifyInstance);
  const session = await create({ body: { channel: 'pdd', accountId: record.id } });
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const socket = { readyState: 1, send: vi.fn(), close: vi.fn(), ping: vi.fn(), on: (event: string, listener: (...args: unknown[]) => void) => listeners.set(event, listener) };
  connect(socket, { params: { sessionId: session.sessionId }, auth: { userId: 'local-test' } });
  await vi.advanceTimersByTimeAsync(10_000);
  expect(acquireContext).toHaveBeenCalledWith(record.id, browserState);
  expect(adoptLoginContext).toHaveBeenCalledWith(record.id, `login:${session.sessionId}`);
  expect(page.goto).toHaveBeenCalledWith(record.payload.verificationUrl, expect.any(Object));
  // 已有 Cookie 不能被当作本次验证完成的证据。
  expect(updateAccountPayload).not.toHaveBeenCalled();
  listeners.get('message')?.(JSON.stringify({ type: 'done' }), false);
  await vi.advanceTimersByTimeAsync(6000);
  expect(updateAccountPayload).toHaveBeenCalledWith(record.id, expect.objectContaining({ browserState }));
  expect(setAccountStatus).toHaveBeenCalledWith(record.id, 'ok', null);
  expect(adoptLoginContext).toHaveBeenCalledWith(`login:${session.sessionId}`, record.id);
});
