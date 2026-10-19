import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { closeDb, getDb, openDb } from '../src/db/client.js';
import { migrate } from '../src/db/migrate.js';
import { syncRuns } from '../src/db/schema.js';
vi.mock('../src/services/logistics/poll.js', () => ({ pollCarrierTraces: vi.fn() }));
import { pollCarrierTraces } from '../src/services/logistics/poll.js';
import { getSyncStatus, runSync } from '../src/services/sync/orchestrator.js';

const directory = mkdtempSync(join(tmpdir(), 'ea-sync-status-'));
beforeAll(() => { openDb(join(directory, 'status.db')); migrate(); });
beforeEach(() => getDb().delete(syncRuns).run());
afterAll(() => { closeDb(); rmSync(directory, { recursive: true, force: true }); });

it('reports the latest partial completion instead of an older successful completion', () => {
  getDb().insert(syncRuns).values([
    { id: 'old', trigger: 'manual', status: 'ok', channels: '[]', startedAt: '2026-10-18T00:00:00Z', finishedAt: '2026-10-18T00:01:00Z' },
    { id: 'recent', trigger: 'manual', status: 'partial', channels: '[]', startedAt: '2026-10-19T00:00:00Z', finishedAt: '2026-10-19T00:01:00Z', error: 'pdd requires verification' },
    { id: 'unfinished', trigger: 'manual', status: 'running', channels: '[]', startedAt: '2026-10-19T00:02:00Z' },
  ]).run();
  expect(getSyncStatus()).toMatchObject({ lastFinishedAt: '2026-10-19T00:01:00Z', lastError: 'pdd requires verification' });
});

it('has no completion timestamp before the first run finishes', () => {
  getDb().insert(syncRuns).values({ id: 'unfinished', trigger: 'manual', status: 'running', channels: '[]', startedAt: '2026-10-19T00:02:00Z' }).run();
  expect(getSyncStatus()).toMatchObject({ lastFinishedAt: null, lastError: null });
});

it('首页同步在没有平台账号时也执行手工物流更新', async () => {
  vi.mocked(pollCarrierTraces).mockClear();
  const result = await runSync({ trigger: 'manual', channels: [] });
  expect(result).not.toBeNull();
  expect(pollCarrierTraces).toHaveBeenCalledWith({ manualSync: true });
  expect(getSyncStatus().running).toBe(false);
});
