import { and, eq } from 'drizzle-orm';
import type { ItemSource, DetailPoint } from '@ea/shared';
import { getDb } from '../../db/client.js';
import { traces } from '../../db/schema.js';

export interface CachedTrace {
  points: DetailPoint[];
  eta: string;
  fetchedAt: string;
  done: boolean;
}

export function getTrace(mailNo: string, source: ItemSource): CachedTrace | null {
  const row = getDb()
    .select()
    .from(traces)
    .where(and(eq(traces.mailNo, mailNo), eq(traces.source, source)))
    .get();
  if (!row) return null;
  let points: DetailPoint[] = [];
  try {
    const parsed: unknown = JSON.parse(row.points);
    if (Array.isArray(parsed)) points = parsed as DetailPoint[];
  } catch {
    points = [];
  }
  return { points, eta: row.eta, fetchedAt: row.fetchedAt, done: row.done };
}

export function saveTrace(
  mailNo: string,
  source: ItemSource,
  points: DetailPoint[],
  eta: string,
  done: boolean,
): CachedTrace {
  const db = getDb();
  const fetchedAt = new Date().toISOString();
  const payload = { points: JSON.stringify(points), eta, done, fetchedAt };
  const existing = db
    .select({ id: traces.id })
    .from(traces)
    .where(and(eq(traces.mailNo, mailNo), eq(traces.source, source)))
    .get();
  if (existing) {
    db.update(traces).set(payload).where(eq(traces.id, existing.id)).run();
  } else {
    db.insert(traces)
      .values({ id: `${source}:${mailNo}`, mailNo, source, ...payload })
      .run();
  }
  return { points, eta, fetchedAt, done };
}

/** 批量读取 PDD 轨迹（合并时回填 prompt-only 文案） */
export function pddTracesMap(): Map<string, DetailPoint[]> {
  const rows = getDb().select().from(traces).where(eq(traces.source, 'pdd')).all();
  const map = new Map<string, DetailPoint[]>();
  for (const row of rows) {
    try {
      const parsed: unknown = JSON.parse(row.points);
      if (Array.isArray(parsed) && parsed.length > 0) map.set(row.mailNo, parsed as DetailPoint[]);
    } catch {
      // 忽略损坏缓存
    }
  }
  return map;
}
