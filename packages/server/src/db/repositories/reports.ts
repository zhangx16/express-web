import { randomUUID } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import type { ReportDto, ReportScheduleDto } from '@ea/shared';
import { getDb } from '../client.js';
import { reports, reportSchedules } from '../schema.js';

function toReportDto(row: typeof reports.$inferSelect): ReportDto {
  return {
    id: row.id,
    date: row.date,
    content: row.content,
    createdAt: row.createdAt,
    delivered: row.delivered,
  };
}

export function toScheduleDto(row: typeof reportSchedules.$inferSelect): ReportScheduleDto {
  return {
    id: row.id,
    time: row.time,
    repeat: row.repeat,
    weekdays: row.weekdays,
    enabled: row.enabled,
    lastRunAt: row.lastRunAt,
  };
}

export function listReports(limit = 30): ReportDto[] {
  return getDb()
    .select()
    .from(reports)
    .orderBy(desc(reports.createdAt))
    .limit(limit)
    .all()
    .map(toReportDto);
}

export function getReport(id: string): ReportDto | null {
  const row = getDb().select().from(reports).where(eq(reports.id, id)).get();
  return row ? toReportDto(row) : null;
}

export function insertReport(input: {
  date: string;
  content: string;
  delivered?: boolean;
}): ReportDto {
  const now = new Date().toISOString();
  const row = {
    id: randomUUID(),
    date: input.date,
    content: input.content,
    delivered: input.delivered ?? false,
    createdAt: now,
  };
  getDb().insert(reports).values(row).run();
  return toReportDto(row);
}

export function markReportDelivered(id: string, delivered = true): void {
  getDb().update(reports).set({ delivered }).where(eq(reports.id, id)).run();
}

export function listSchedules(): ReportScheduleDto[] {
  return getDb()
    .select()
    .from(reportSchedules)
    .orderBy(reportSchedules.time)
    .all()
    .map(toScheduleDto);
}

export function getSchedule(id: string): ReportScheduleDto | null {
  const row = getDb().select().from(reportSchedules).where(eq(reportSchedules.id, id)).get();
  return row ? toScheduleDto(row) : null;
}

export function createSchedule(input: {
  time: string;
  repeat: number;
  weekdays: number;
  enabled: boolean;
}): ReportScheduleDto {
  const now = new Date().toISOString();
  const row = {
    id: randomUUID(),
    time: input.time,
    repeat: input.repeat,
    weekdays: input.weekdays,
    enabled: input.enabled,
    lastRunAt: null,
    createdAt: now,
    updatedAt: now,
  };
  getDb().insert(reportSchedules).values(row).run();
  return toScheduleDto(row);
}

export function patchSchedule(
  id: string,
  patch: Partial<{ time: string; repeat: number; weekdays: number; enabled: boolean }>,
): ReportScheduleDto | null {
  const existing = getDb().select().from(reportSchedules).where(eq(reportSchedules.id, id)).get();
  if (!existing) return null;
  getDb()
    .update(reportSchedules)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(reportSchedules.id, id))
    .run();
  return getSchedule(id);
}

export function touchSchedule(id: string, at = new Date().toISOString()): void {
  getDb()
    .update(reportSchedules)
    .set({ lastRunAt: at, updatedAt: at })
    .where(eq(reportSchedules.id, id))
    .run();
}

export function deleteSchedule(id: string): boolean {
  const existing = getDb().select().from(reportSchedules).where(eq(reportSchedules.id, id)).get();
  if (!existing) return false;
  getDb().delete(reportSchedules).where(eq(reportSchedules.id, id)).run();
  return true;
}

export function enabledSchedules(): ReportScheduleDto[] {
  return getDb()
    .select()
    .from(reportSchedules)
    .where(eq(reportSchedules.enabled, true))
    .all()
    .map(toScheduleDto);
}
