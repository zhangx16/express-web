import { notifyPendingPickups } from '../services/notify/pickup.js';
import { config } from '../config.js';
import { cleanupExpired } from '../services/maintenance/cleanup.js';
import { backupDaily } from '../services/maintenance/backup.js';
import { runDueReportSchedules } from '../services/reports/scheduler.js';
import { maybeRunPeriodicSync } from '../services/sync/orchestrator.js';

import { pollCarrierTraces } from '../services/logistics/poll.js';

const TICK_MS = 60_000;

let timer: NodeJS.Timeout | null = null;
let running = false;
let startupTimer: NodeJS.Timeout | null = null;
let ticking = false;
let lastTickAt: string | null = null;

export function getSchedulerState(): boolean {
  return running;
}

export function lastSchedulerTick(): string | null {
  return lastTickAt;
}

async function tick(): Promise<void> {
  if (!running || ticking) return;
  ticking = true;
  lastTickAt = new Date().toISOString();
  try {
    const tasks = [notifyPendingPickups, maybeRunPeriodicSync, pollCarrierTraces, runDueReportSchedules, cleanupExpired, backupDaily];
    for (const task of tasks) {
      if (!running) break;
      try {
        await task();
      } catch (err) {
        // 各任务独立失败，避免同步异常阻断日报、清理和备份。
        console.error('[scheduler] task failed', task.name, err);
      }
    }
  } finally {
    ticking = false;
  }
}

export function startScheduler(): void {
  if (config.DISABLE_SCHEDULER || running) return;
  running = true;
  // 启动 10 秒后先跑一次，之后每分钟
  startupTimer = setTimeout(() => {
    startupTimer = null;
    void tick();
  }, 10_000);
  startupTimer.unref();
  timer = setInterval(() => void tick(), TICK_MS);
  timer.unref();
}

export function stopScheduler(): void {
  if (startupTimer) clearTimeout(startupTimer);
  startupTimer = null;
  if (timer) clearInterval(timer);
  timer = null;
  running = false;
}
