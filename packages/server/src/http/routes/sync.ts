import type { FastifyInstance } from 'fastify';
import { desc } from 'drizzle-orm';
import type { SyncRunDto, SyncStartResponse, SyncStatusResponse, SyncTrigger } from '@ea/shared';
import { getDb } from '../../db/client.js';
import { syncRuns } from '../../db/schema.js';
import { getSyncStatus, startSync } from '../../services/sync/orchestrator.js';
import { audit } from '../../lib/audit.js';

/** 同步：触发后立即返回 runId，进度经 SSE 推送（避免 Cloudflare 100 秒请求上限） */
export async function syncRoutes(app: FastifyInstance): Promise<void> {
  app.post('/sync', async (req): Promise<SyncStartResponse> => {
    const { runId, channels } = startSync({ trigger: 'manual' });
    audit(req, 'sync.start', { runId, channels });
    return { runId, trigger: 'manual', channels };
  });

  app.get('/sync/status', async (): Promise<SyncStatusResponse> => getSyncStatus());

  app.get('/sync/runs', async (req) => {
    const { limit } = req.query as { limit?: string };
    const parsed = Number(limit);
    const take = Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, 100) : 20;

    const rows = getDb().select().from(syncRuns).orderBy(desc(syncRuns.startedAt)).limit(take).all();
    const runs: SyncRunDto[] = rows.map((row) => ({
      id: row.id,
      trigger: row.trigger as SyncTrigger,
      status: row.status as SyncRunDto['status'],
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      total: row.total,
      error: row.error,
    }));
    return { runs };
  });
}
