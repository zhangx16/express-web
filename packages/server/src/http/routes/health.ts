import type { FastifyInstance } from 'fastify';
import type { HealthResponse } from '@ea/shared';
import { dbHealthy } from '../../db/client.js';
import { config } from '../../config.js';
import { getBrowserState } from '../../browser/pool.js';
import { getSchedulerState } from '../../scheduler/scheduler.js';
import { readFileSync } from 'node:fs';

const startedAt = Date.now();

function version(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const VERSION = version();

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  const handler = async (): Promise<HealthResponse> => {
    const db = dbHealthy();
    const browser = getBrowserState();
    const scheduler = getSchedulerState();
    return {
      ok: db,
      db,
      browser: config.DISABLE_BROWSER ? 'down' : browser,
      scheduler: config.DISABLE_SCHEDULER ? false : scheduler,
      version: VERSION,
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
    };
  };

  app.get('/health', handler);
  app.get('/api/health', handler);
}
