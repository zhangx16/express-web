import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { extractEta, type DetailPoint, type ExpressItem } from '@ea/shared';
import { getSettings, getSecret } from '../../db/repositories/settings.js';
import { getDb } from '../../db/client.js';
import { settings } from '../../db/schema.js';
import { UpstreamError } from '../../http/errors.js';

export const MIN_QUERY_MS = 31 * 60_000;
const carriers: Record<string, string> = {
  '顺丰': 'shunfeng', '顺丰速运': 'shunfeng', '顺丰快运': 'shunfengkuaiyun',
  '中通': 'zhongtong', '中通快递': 'zhongtong', '圆通': 'yuantong', '圆通速递': 'yuantong',
  '圆通快递': 'yuantong', '极兔快递': 'jtexpress', '韵达速递': 'yunda',
  '申通': 'shentong', '申通快递': 'shentong', '韵达': 'yunda', '韵达快递': 'yunda',
  '极兔': 'jtexpress', '极兔速递': 'jtexpress', '邮政': 'youzhengguonei', '邮政快递包裹': 'youzhengguonei',
  '中国邮政': 'youzhengguonei', 'EMS': 'ems', '京东物流': 'jd', '京东快递': 'jd',
  '德邦快递': 'debangkuaidi', '德邦物流': 'debangwuliu', '百世快递': 'huitongkuaidi', '菜鸟速递': 'danniao',
};
export function carrierCode(item: Pick<ExpressItem, 'companyCode' | 'companyName'>): string | null {
  const code = item.companyCode.trim().toLowerCase();
  // 平台内部代码不作为快递100编码；优先使用明确的公司名称。
  return carriers[item.companyName.trim()] ??
    (Object.values(carriers).includes(code) ? code : null);
}
export function logisticsEnabled(): boolean { return getSettings().kuaidi100Enabled; }
export function usesCarrier(item: ExpressItem): boolean {
  return logisticsEnabled() && (item.source === 'manual' || (item.source === 'pdd' && item.mailNo !== item.queryChannel && Boolean(carrierCode(item)) && /^[A-Za-z0-9-]{6,32}$/.test(item.mailNo) && !item.mailNo.startsWith('PO-')));
}

export function statusFromCode(code: string): Pick<ExpressItem, 'state' | 'stateNum' | 'stateName'> {
  if (code === '3') return { state: 3, stateNum: 107, stateName: '已签收' };
  if (['2', '4', '6', '13', '14'].includes(code)) return { state: 4, stateNum: 108, stateName: '物流异常' };
  if (code === '5') return { state: 5, stateNum: 105, stateName: '派送中' };
  if (['0', '1', '7', '8', '10', '11', '12'].includes(code)) return { state: 2, stateNum: 104, stateName: '运输中' };
  return { state: -1, stateNum: 0, stateName: '状态待确认' };
}
const responseSchema = z.object({
  status: z.union([z.string(), z.number()]).optional(),
  returnCode: z.union([z.string(), z.number()]).optional(),
  state: z.union([z.string(), z.number()]).optional(),
  nu: z.string().optional(), com: z.string().optional(),
  data: z.array(z.object({ context: z.string().max(8000), time: z.string().max(128), ftime: z.string().max(128).optional() })).max(2000).optional(),
});
export function parseCarrierResponse(raw: unknown, expectedNo: string) {
  const parsed = responseSchema.safeParse(raw);
  if (!parsed.success) throw new UpstreamError('logistics_invalid_response', '快递100返回格式异常，请稍后再试');
  const data = parsed.data;
  const code = String(data.returnCode ?? data.status ?? '');
  if (code !== '200' || !data.data?.length) {
    const messages: Record<string, string> = {
      '400': '请检查快递公司、账号服务及余额', '401': '快递公司编码不支持，请修改快递公司',
      '408': '查件手机号验证失败，请在编辑包裹中填写正确号码', '500': '暂未查到物流，请确认单号与快递公司后稍后查询',
      '503': '快递100签名验证失败，请检查 Customer 和 Key', '504': '快递100限制查询频率，该单暂停查询24小时',
      '601': '快递100服务已到期或额度不足，请检查账户',
    };
    throw new UpstreamError('logistics_query_failed', messages[code] ?? '快递100查询失败，请稍后再试');
  }
  if (data.nu && data.nu.toLowerCase() !== expectedNo.toLowerCase()) throw new UpstreamError('logistics_wrong_number', '返回的运单号不匹配，已忽略结果');
  // 显式请求倒序，统一翻转为旧→新；不使用 UTC 解析中国物流时间。
  const points: DetailPoint[] = data.data.filter(p => p.context.trim() && p.time.trim()).reverse().map(p => ({ context: p.context, time: p.time, formattedTime: p.ftime || p.time }));
  if (!points.length) throw new UpstreamError('logistics_empty', '暂无有效物流轨迹');
  return { points, eta: extractEta(...points.map(p => p.context)), status: statusFromCode(String(data.state ?? '')) };
}

function rateKey(com: string, no: string): string {
  return 'kuaidi100.retry.' + createHash('sha256').update(`${com}:${no.toLowerCase()}`).digest('hex');
}
function retryAt(key: string): number {
  const row = getDb().select().from(settings).where(eq(settings.key, key)).get();
  return Number(row?.value ?? 0) || 0;
}
function setRetry(key: string, at: number): void {
  const row = { key, value: String(at), updatedAt: new Date().toISOString() };
  getDb().insert(settings).values(row).onConflictDoUpdate({ target: settings.key, set: row }).run();
}
export async function fetchCarrierTrace(item: ExpressItem) {
  const s = getSettings();
  const key = getSecret('kuaidi100_key');
  if (!s.kuaidi100Enabled || !s.kuaidi100Customer || !key) throw new UpstreamError('logistics_not_configured', '请先在设置中启用快递100并填写 Customer 和 Key', 409);
  const com = carrierCode(item);
  if (!com) throw new UpstreamError('logistics_carrier_missing', '请在编辑包裹中选择支持的快递公司', 409);
  if (!/^[A-Za-z0-9-]{6,32}$/.test(item.mailNo) || item.mailNo.startsWith('PO-')) throw new UpstreamError('logistics_number_invalid', '快递100需要6–32位真实运单号，不能使用订单号', 409);
  const phone = (item.phone ?? '').trim();
  if (['shunfeng', 'shunfengkuaiyun', 'zhongtong'].includes(com) && (!phone || phone.includes('*'))) throw new UpstreamError('logistics_phone_required', '该快递公司需要查件手机号，请在编辑包裹中填写；虚拟号码填写横线后的四位', 409);
  const rate = rateKey(com, item.mailNo);
  const next = retryAt(rate);
  if (Date.now() < next) throw new UpstreamError('logistics_rate_limited', `该单查询间隔至少31分钟，请约${Math.ceil((next - Date.now()) / 60_000)}分钟后再试`, 429);
  const param = JSON.stringify({ com, num: item.mailNo, ...(phone ? { phone } : {}), show: '0', order: 'desc' });
  const sign = createHash('md5').update(param + key + s.kuaidi100Customer).digest('hex').toUpperCase();
  setRetry(rate, Date.now() + MIN_QUERY_MS); // 请求发出前持久化，失败与重启也不会连续重试。
  let raw: unknown;
  try {
    const res = await fetch('https://poll.kuaidi100.com/poll/query.do', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ customer: s.kuaidi100Customer, sign, param }),
      signal: AbortSignal.timeout(15_000), redirect: 'error',
    });
    if (!res.ok) throw new Error('upstream');
    raw = await res.json();
  } catch { throw new UpstreamError('logistics_network_error', '快递100连接失败，请稍后重试'); }
  if (raw && typeof raw === 'object' && String((raw as Record<string, unknown>).returnCode ?? (raw as Record<string, unknown>).status) === '504') setRetry(rate, Date.now() + 24 * 60 * 60_000);
  return parseCarrierResponse(raw, item.mailNo);
}
