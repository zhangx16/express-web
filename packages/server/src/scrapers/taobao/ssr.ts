import type { DetailPoint } from '@ea/shared';
import { TB_UA } from './mtop.js';

const SSR_BASE = 'https://pages-g.m.taobao.com/wow/z/app/mtb/logisticsV2/h5-detail';
const SSR_TIMEOUT_MS = 15_000;
const MARKER = "__ICE_SUSPENSE_LOADER__']['undefined'] = ";

export interface TbParcel {
  mailNo: string;
  cpName: string;
  stateLabel: string;
  latestText: string;
  latestTime: string;
  orderId: string;
}

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

function asArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

/**
 * 从标记位置截取一个完整 JSON 对象（等价 org.json.JSONTokener.nextValue 的括号平衡扫描）。
 * 字符串内的括号/转义必须忽略，否则富文本里出现 `{` 会截断。
 */
export function extractJsonObjectAt(text: string, start: number): Json | null {
  let i = start;
  while (i < text.length && /\s/.test(text[i] ?? '')) i += 1;
  if (text[i] !== '{') return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  const begin = i;

  for (; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed: unknown = JSON.parse(text.slice(begin, i + 1));
          return asObject(parsed);
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 从 SSR HTML 中取物流 fields（newLogistics 优先，其次 logisticsDetailH5） */
export function ssrLogistics(html: string): Json | null {
  const idx = html.indexOf(MARKER);
  if (idx < 0) return null;
  const root = extractJsonObjectAt(html, idx + MARKER.length);
  if (!root) return null;
  const data = asObject(asObject(root.result)?.data);
  if (!data) return null;
  const newLogistics = asObject(asObject(data.newLogistics)?.fields);
  if (newLogistics) return newLogistics;
  return asObject(asObject(data.logisticsDetailH5)?.fields);
}

/** 阶段文案：richContent[].text 拼接 → labelDesc.text → 原始 labelDesc（非 JSON）→ stage.text */
export function stageText(stage: Json): string {
  const parts: string[] = [];
  const labelDesc = stage.labelDesc;
  const ld = asObject(labelDesc);
  if (ld) {
    const rich = asArray(ld.richContent);
    if (rich) {
      for (const r of rich) parts.push(asString(asObject(r)?.text));
    } else {
      parts.push(asString(ld.text));
    }
  }
  let out = parts.join('');
  if (out === '') {
    const raw = asString(labelDesc);
    if (!raw.startsWith('{')) out = raw;
  }
  if (out === '') out = asString(stage.text);
  return out;
}

export function parseSsrDetail(html: string, orderId: string): TbParcel | null {
  const logistics = ssrLogistics(html);
  if (!logistics) return null;
  const company = asObject(logistics.logisticCompany);
  if (!company) return null;
  const mailNo = asString(logistics.mailNo) || asString(company.mailNo);
  const cpName = asString(company.name);
  if (!mailNo) return null;

  let stateLabel = '';
  let latestText = '';
  let latestTime = '';
  const stages = asArray(logistics.multiStage);
  if (stages && stages.length > 0) {
    const first = asObject(stages[0]);
    if (first) {
      stateLabel = asString(first.title);
      latestTime = asString(first.subtitle) || asString(first.time);
      latestText = stageText(first);
    }
  }
  return { mailNo, cpName, stateLabel, latestText, latestTime, orderId };
}

/** 全部物流节点（顺序与页面一致：新 → 旧） */
export function parseSsrTraces(html: string): DetailPoint[] | null {
  const logistics = ssrLogistics(html);
  if (!logistics) return null;
  const stages = asArray(logistics.multiStage);
  if (!stages) return null;
  const points: DetailPoint[] = [];
  for (const raw of stages) {
    const st = asObject(raw);
    if (!st) continue;
    const time = asString(st.subtitle) || asString(st.time);
    const desc = stageText(st);
    if (desc.trim() !== '') points.push({ context: desc, time, formattedTime: time });
  }
  return points;
}

async function fetchSsrHtml(cookie: string, orderId: string): Promise<string> {
  const url = `${SSR_BASE}?x-ssr=true&bizOrderId=${encodeURIComponent(orderId)}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': TB_UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Cookie: cookie,
    },
    signal: AbortSignal.timeout(SSR_TIMEOUT_MS),
  });
  return res.text();
}

/** 订单的 SSR 物流详情（失败返回 null，与 Android 一致不抛） */
export async function fetchSsrDetail(cookie: string, orderId: string): Promise<TbParcel | null> {
  if (!cookie) return null;
  try {
    return parseSsrDetail(await fetchSsrHtml(cookie, orderId), orderId);
  } catch {
    return null;
  }
}

/** 订单的 SSR 轨迹（失败返回 null） */
export async function fetchSsrTraces(cookie: string, orderId: string): Promise<DetailPoint[] | null> {
  if (!cookie) return null;
  try {
    return parseSsrTraces(await fetchSsrHtml(cookie, orderId));
  } catch {
    return null;
  }
}
