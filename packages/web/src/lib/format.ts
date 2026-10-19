/** 时间与文本格式化工具（与后端 `parseMs` 口径一致） */

function pad(n: number): string {
  return n.toString().padStart(2, '0');
}

/** 解析平台时间串（`2026-10-18 12:00:00`、`2026/10/18 12:00` 均可） */
export function parseTime(raw: string): number {
  if (!raw) return 0;
  const normalized = raw.trim().replace(/\//g, '-').replace(' ', 'T');
  const t = Date.parse(normalized);
  return Number.isNaN(t) ? 0 : t;
}

/** 卡片时间：今天只显示时分，今年显示月日，跨年显示日期 */
export function formatTime(raw: string): string {
  const ms = parseTime(raw);
  if (!ms) return raw;
  const d = new Date(ms);
  const now = new Date();
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return hm;
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 详情页时间：始终显示完整日期时间 */
export function formatDateTime(raw: string): string {
  const ms = parseTime(raw);
  if (!ms) return raw;
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 */
export function formatRelative(raw: string): string {
  const ms = parseTime(raw);
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return formatTime(raw);
}

/** 单号尾号，卡片上只显示后 4 位 */
export function shortMailNo(mailNo: string, len = 4): string {
  if (!mailNo) return '';
  return mailNo.length <= len ? mailNo : mailNo.slice(-len);
}

/** 毫秒 → 人类可读（同步耗时） */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}
