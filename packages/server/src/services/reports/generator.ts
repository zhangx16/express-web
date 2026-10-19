import { sectionKeyOf, type ExpressItem, type ReportDto } from '@ea/shared';
import { listAllItems } from '../../db/repositories/items.js';
import { getSettings } from '../../db/repositories/settings.js';
import { insertReport, markReportDelivered } from '../../db/repositories/reports.js';
import { sendTelegramMessage } from '../notify/telegram.js';
import { runSync } from '../sync/orchestrator.js';
import { eventBus } from '../../events/bus.js';
import { logger } from '../../lib/logger.js';

/** 与 Android `DailyReporter.generateReport` 一致：日报只覆盖在途分区 */
export function inTransitItems(items: ExpressItem[]): ExpressItem[] {
  return items.filter((it) => {
    const key = sectionKeyOf(it);
    return key === 'delivering' || key === 'shipped' || key === 'notshipped';
  });
}

function fallbackReport(moving: ExpressItem[]): string {
  const lines = moving.map((item) => {
    const eta = item.eta.trim() || item.aiEta.trim();
    const head = `- ${item.companyName} ${item.mailNo}：${stateText(item)}`;
    return `${head}${eta ? `，预计 ${eta}` : ''}\n  ${item.latestText}`;
  });
  return `今日在途 ${moving.length} 件：\n\n${lines.join('\n')}\n`;
}

function stateText(item: ExpressItem): string {
  if (item.stateOverride.trim() !== '') return item.stateOverride;
  if (item.stateName !== '') return item.stateName;
  switch (item.state) {
    case 0:
      return '运输中';
    case 1:
      return '已揽件';
    case 3:
      return '已签收';
    case 4:
      return '已拒签';
    case 5:
      return '派送中';
    default:
      return '未知';
  }
}

/** 生成普通模板日报；无在途件时不落库。 */
export async function generateReportText(): Promise<string | null> {
  const moving = inTransitItems(listAllItems());
  return moving.length ? fallbackReport(moving) : null;
}

/** Telegram 推送文案（同 Android `DailyReporter.notify`） */
export function reportNotification(text: string): { title: string; body: string } {
  const moving = inTransitItems(listAllItems());
  const delivering = moving.filter((it) => it.state === 5 || it.stateName.includes('派送')).length;
  const etas = [
    ...new Set(
      moving
        .map((it) => it.eta.trim())
        .filter((eta) => eta !== ''),
    ),
  ].slice(0, 2);

  const summary =
    `在途 ${moving.length} 件` +
    (delivering > 0 ? ` · 派送中 ${delivering}` : '') +
    (etas.length > 0 ? `\n预计送达：${etas.join('、')}` : '');

  const preview = text
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_`#>]/g, '')
    .trim()
    .split('\n')
    .filter((line) => line.trim() !== '')
    .slice(0, 4)
    .join('\n');

  return { title: '快递日报', body: `${summary}\n\n${preview}`.trim() };
}

function localDate(now = new Date()): string {
  return now.toLocaleDateString('sv-SE', { timeZone: getSettings().timezone });
}

export interface GenerateReportOptions {
  /** 生成前先同步（调度触发时 true；手动生成也 true） */
  syncFirst?: boolean;
  /** 是否推送 Telegram 并标记 delivered */
  deliver?: boolean;
}

export interface GenerateReportResult {
  report: ReportDto;
  text: string;
  delivered: boolean;
}

/**
 * 生成并落库一份日报。无在途件时返回 null。
 * 同步失败不影响日报生成（使用当前库内数据）。
 */
export async function generateAndDeliver(
  opts: GenerateReportOptions = {},
): Promise<GenerateReportResult | null> {
  if (opts.syncFirst) {
    try {
      await runSync({ trigger: 'report' });
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : 'unknown' }, 'pre-report sync failed');
    }
  }

  const text = await generateReportText();
  if (text === null) return null;

  let delivered = false;
  if (opts.deliver !== false) {
    const { title, body } = reportNotification(text);
    const result = await sendTelegramMessage(`${title}\n\n${body}`);
    delivered = result.ok;
    if (!result.ok && result.error !== 'telegram_disabled' && result.error !== 'telegram_not_configured') {
      logger.warn({ error: result.error }, 'report telegram send failed');
    }
  }

  const report = insertReport({ date: localDate(), content: text, delivered });
  if (delivered) markReportDelivered(report.id, true);
  eventBus.publish({
    type: 'report.created',
    reportId: report.id,
    date: report.date,
    summary: text.split('\n').find((line) => line.trim() !== '')?.slice(0, 120) ?? '',
  });

  return { report, text, delivered };
}
