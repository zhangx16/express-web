import { beforeEach, expect, it, vi } from 'vitest';
import type { AccountRecord } from '../src/services/accounts/repo.js';

vi.mock('../src/services/accounts/repo.js', () => ({ enabledAccounts: vi.fn(), setAccountStatus: vi.fn() }));
vi.mock('../src/scrapers/pdd/session.js', () => ({ withPddSession: vi.fn() }));
vi.mock('../src/db/repositories/goods.js', () => ({ upsertGoods: vi.fn() }));

import { enabledAccounts, setAccountStatus } from '../src/services/accounts/repo.js';
import { withPddSession } from '../src/scrapers/pdd/session.js';
import { fetchPddOrders } from '../src/scrapers/pdd/list.js';

beforeEach(() => vi.resetAllMocks());

it.each(['challenge', 'needs_login'] as const)('does not retry %s accounts or clear their status', async (status) => {
  vi.mocked(enabledAccounts).mockReturnValue([{ id: 'paused', status, statusDetail: '请完成安全验证' } as AccountRecord]);
  for (let i = 0; i < 2; i++) {
    expect(await fetchPddOrders()).toEqual({ items: null, error: '请完成安全验证' });
  }
  expect(withPddSession).not.toHaveBeenCalled();
  expect(setAccountStatus).not.toHaveBeenCalled();
});

it('continues syncing other accounts while preserving paused account data', async () => {
  vi.mocked(enabledAccounts).mockReturnValue([
    { id: 'paused', status: 'challenge', statusDetail: '请完成安全验证' } as AccountRecord,
    { id: 'ready', status: 'ok' } as AccountRecord,
  ]);
  vi.mocked(withPddSession).mockResolvedValue({ items: [], goods: new Map() });
  const result = await fetchPddOrders();
  expect(withPddSession).toHaveBeenCalledTimes(1);
  expect(withPddSession).toHaveBeenCalledWith(expect.objectContaining({ id: 'ready' }), expect.any(Function));
  expect(result).toEqual({ items: null, error: '请完成安全验证' });
});
