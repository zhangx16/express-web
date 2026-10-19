import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { REPORT_REPEAT, type ReportDto, type ReportScheduleDto } from '@ea/shared';
import {
  createSchedule,
  deleteSchedule,
  getReport,
  getSchedule,
  listReports,
  listSchedules,
  patchSchedule,
} from '../../db/repositories/reports.js';
import { generateAndDeliver } from '../../services/reports/generator.js';
import { ConflictError, NotFoundError, ValidationError } from '../errors.js';
import { audit } from '../../lib/audit.js';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const scheduleCreateSchema = z
  .object({
    time: z.string().regex(TIME_RE, '时间格式应为 HH:mm'),
    repeat: z.number().int().min(0).max(4).default(REPORT_REPEAT.DAILY),
    weekdays: z.number().int().min(0).max(127).default(0),
    enabled: z.boolean().default(true),
  })
  .strict();

const schedulePatchSchema = z
  .object({
    time: z.string().regex(TIME_RE, '时间格式应为 HH:mm').optional(),
    repeat: z.number().int().min(0).max(4).optional(),
    weekdays: z.number().int().min(0).max(127).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(30),
});

/** 日报：历史、手动生成、计划 CRUD */
export async function reportsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/reports', async (req) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError('查询参数不正确');
    return { reports: listReports(parsed.data.limit) };
  });

  app.get<{ Params: { id: string } }>('/reports/:id', async (req): Promise<ReportDto> => {
    const report = getReport(req.params.id);
    if (!report) throw new NotFoundError('日报不存在');
    return report;
  });

  // 手动生成：先同步再生成，推送 Telegram（未配置则仅落库）
  app.post('/reports/generate', async (req) => {
    const result = await generateAndDeliver({ syncFirst: true });
    if (result === null) {
      throw new ConflictError('no_in_transit', '当前没有在途快递，未生成日报');
    }
    audit(req, 'report.generate', { reportId: result.report.id, delivered: result.delivered });
    return { report: result.report, delivered: result.delivered };
  });

  // ── 计划 ──

  app.get('/reports/schedules', async (): Promise<{ schedules: ReportScheduleDto[] }> => ({
    schedules: listSchedules(),
  }));

  app.post('/reports/schedules', async (req) => {
    const parsed = scheduleCreateSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('日报计划格式不正确');
    if (parsed.data.repeat === REPORT_REPEAT.CUSTOM && parsed.data.weekdays === 0) {
      throw new ValidationError('自定义重复需要至少选择一天');
    }
    const schedule = createSchedule(parsed.data);
    audit(req, 'report.schedule.create', { scheduleId: schedule.id, time: schedule.time, repeat: schedule.repeat });
    return { schedule };
  });

  app.patch<{ Params: { id: string } }>('/reports/schedules/:id', async (req) => {
    const parsed = schedulePatchSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('日报计划格式不正确');
    const existing = getSchedule(req.params.id);
    if (!existing) throw new NotFoundError('日报计划不存在');
    const next = patchSchedule(req.params.id, parsed.data);
    if (!next) throw new NotFoundError('日报计划不存在');
    if (next.repeat === REPORT_REPEAT.CUSTOM && next.weekdays === 0) {
      throw new ValidationError('自定义重复需要至少选择一天');
    }
    audit(req, 'report.schedule.patch', { scheduleId: next.id, fields: Object.keys(parsed.data) });
    return { schedule: next };
  });

  app.delete<{ Params: { id: string } }>('/reports/schedules/:id', async (req) => {
    if (!deleteSchedule(req.params.id)) throw new NotFoundError('日报计划不存在');
    audit(req, 'report.schedule.delete', { scheduleId: req.params.id });
    return { ok: true };
  });
}
