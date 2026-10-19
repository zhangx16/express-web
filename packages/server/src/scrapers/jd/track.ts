import type { DetailPoint, ExpressItem } from '@ea/shared';
import { ensureBrowser, contextOptions, applyStealth } from '../../browser/pool.js';
import { setCookiesForHosts } from '../browser/cookies.js';
import { sleep } from '../browser/touch.js';

export const JD_TRACK_COOKIE_HOSTS = [
  'https://www.jd.com',
  'https://trade.m.jd.com',
  'https://api.m.jd.com',
] as const;

const TRACK_TIMEOUT_MS = 20_000;
const RENDER_WAIT_MS = 5000;

/** 与 Android `JdTrackFetcher` 一致：优先使用列表带出的完整物流页链接 */
export function jdTrackUrl(item: Pick<ExpressItem, 'mailNo' | 'queryChannel'>): string {
  if (item.queryChannel.includes('deal_wuliu')) {
    return item.queryChannel.startsWith('//') ? `https:${item.queryChannel}` : item.queryChannel;
  }
  return `https://trade.m.jd.com/order/deal_wuliu_jdm.shtml?dealId=${encodeURIComponent(item.mailNo)}`;
}

export interface JdTrackResult {
  points: DetailPoint[];
  error: string | null;
}

/**
 * 京东轨迹：独立临时 context（不占用账号池），加载物流页后读取渲染文本。
 * 失败返回空点集，不抛异常（轨迹接口按"无数据"展示）。
 */
export async function fetchJdTrack(
  item: Pick<ExpressItem, 'mailNo' | 'queryChannel'>,
  cookie: string,
): Promise<JdTrackResult> {
  const browser = await ensureBrowser();
  const context = await browser.newContext(contextOptions());
  await applyStealth(context);
  try {
    if (cookie) await setCookiesForHosts(context, cookie, JD_TRACK_COOKIE_HOSTS);
    const page = await context.newPage();
    try {
      await page.goto(jdTrackUrl(item), { waitUntil: 'domcontentloaded', timeout: TRACK_TIMEOUT_MS });
      await sleep(RENDER_WAIT_MS);
      const text = await page.evaluate(() => (document.body ? document.body.innerText.slice(0, 20000) : ''));
      return { points: parseJdTrackText(text), error: null };
    } finally {
      await page.close().catch(() => undefined);
    }
  } catch (err) {
    return {
      points: [],
      error: err instanceof Error ? err.message : '京东轨迹加载超时',
    };
  } finally {
    await context.close().catch(() => undefined);
  }
}

const TIME_RE = /^(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?)/;
const NOISE = new Set([
  '订单跟踪',
  '联系客服',
  '复制',
  '展开详细信息',
  '仓库',
  '签',
  '派',
  '等待收货',
  '已发货',
]);
const SKIP_RE = /(订单编号|运单号|国内承运人|联系电话|^\d+件$|¥|评论|已售)/;
const KEYWORDS = [
  '快件',
  '包裹',
  '派件',
  '揽收',
  '签收',
  '发往',
  '到达',
  '转运',
  '投递',
  '取件',
  '出库',
  '配送',
  '妥投',
  '物流',
  '运输',
];

function looksLikeDesc(line: string): boolean {
  return line.includes('【') || KEYWORDS.some((kw) => line.includes(kw));
}

/**
 * 与 Android `parseDetail` 完全一致：
 * 时间行（≤25 字）提交上一条描述；描述行可跨多行，用空格拼接。
 */
export function parseJdTrackText(raw: string): DetailPoint[] {
  let text = raw.trim();
  if (text.startsWith('"') && text.endsWith('"')) {
    text = text.slice(1, -1).replace(/\\n/g, '\n');
  }
  const points: DetailPoint[] = [];
  let pending: string | null = null;

  for (const line of text.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    const m = TIME_RE.exec(l);
    if (m && l.length <= 25) {
      const t = m[1] ?? '';
      const d = (pending ?? '').trim();
      if (d.length >= 4) points.push({ context: d, time: t, formattedTime: t });
      pending = null;
      continue;
    }
    if (NOISE.has(l) || SKIP_RE.test(l)) continue;
    if (pending === null) {
      if (looksLikeDesc(l)) pending = l;
    } else {
      pending = `${pending} ${l}`;
    }
  }
  return points;
}
