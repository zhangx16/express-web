import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/services/logistics/poll.js', () => ({ pollCarrierTraces: vi.fn() }));
vi.mock('../src/services/notify/pickup.js', () => ({ notifyPendingPickups: vi.fn() }));
vi.mock('../src/config.js', () => ({ config: { DISABLE_SCHEDULER: false } }));
vi.mock('../src/services/sync/orchestrator.js', () => ({ maybeRunPeriodicSync: vi.fn() }));
vi.mock('../src/services/reports/scheduler.js', () => ({ runDueReportSchedules: vi.fn() }));
vi.mock('../src/services/maintenance/cleanup.js', () => ({ cleanupExpired: vi.fn() }));
vi.mock('../src/services/maintenance/backup.js', () => ({ backupDaily: vi.fn() }));

import { maybeRunPeriodicSync } from '../src/services/sync/orchestrator.js';
import { runDueReportSchedules } from '../src/services/reports/scheduler.js';
import { cleanupExpired } from '../src/services/maintenance/cleanup.js';
import { backupDaily } from '../src/services/maintenance/backup.js';
import { getSchedulerState, startScheduler, stopScheduler } from '../src/scheduler/scheduler.js';

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetAllMocks();
});

afterEach(() => {
  stopScheduler();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('scheduler lifecycle', () => {
  it('cancels the startup tick when stopped and permits a clean restart', async () => {
    startScheduler();
    stopScheduler();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(maybeRunPeriodicSync).not.toHaveBeenCalled();
    expect(getSchedulerState()).toBe(false);
    startScheduler();
    startScheduler();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(maybeRunPeriodicSync).toHaveBeenCalledTimes(1);
    expect(backupDaily).toHaveBeenCalledTimes(1);
  });

  it('runs maintenance even when periodic sync fails, then recovers on the next tick', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(maybeRunPeriodicSync).mockRejectedValueOnce(new Error('sync failed'));
    startScheduler();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(runDueReportSchedules).toHaveBeenCalledTimes(1);
    expect(cleanupExpired).toHaveBeenCalledTimes(1);
    expect(backupDaily).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(backupDaily).toHaveBeenCalledTimes(2);
  });

  it('skips overlapping ticks while a slow task is pending', async () => {
    let finish!: () => void;
    vi.mocked(maybeRunPeriodicSync).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    startScheduler();
    await vi.advanceTimersByTimeAsync(130_000);
    expect(maybeRunPeriodicSync).toHaveBeenCalledTimes(1);
    finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(backupDaily).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(maybeRunPeriodicSync).toHaveBeenCalledTimes(2);
  });

  it('does not start further tasks after stopping during an active tick', async () => {
    let finish!: () => void;
    vi.mocked(maybeRunPeriodicSync).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    startScheduler();
    await vi.advanceTimersByTimeAsync(10_000);
    stopScheduler();
    finish();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(runDueReportSchedules).not.toHaveBeenCalled();
    expect(backupDaily).not.toHaveBeenCalled();
  });
});
