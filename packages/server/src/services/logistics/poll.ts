import { isDone } from '@ea/shared';
import { getSettings, getSecret } from '../../db/repositories/settings.js';
import { listAllItems } from '../../db/repositories/items.js';
import { getTrace } from '../../db/repositories/traces.js';
import { getItemTrace } from '../traces/service.js';
import { MIN_QUERY_MS, usesCarrier } from './kuaidi100.js';
import { evaluateTracking } from '../tracking/evaluator.js';

let lastPoll = 0;
/** 独立于平台同步，只刷新开启追踪的已知运单。 */
export async function pollCarrierTraces(options: { manualSync?: boolean } = {}): Promise<void> {
  const s = getSettings();
  if (!s.kuaidi100Enabled || !s.kuaidi100Customer || !getSecret('kuaidi100_key')) return;
  if (!options.manualSync && Date.now() - lastPoll < s.kuaidi100PollIntervalMin * 60_000) return;
  if (!options.manualSync) lastPoll = Date.now();
  for (const item of listAllItems()) {
    const selected = item.tracked || (options.manualSync && item.source === 'manual');
    if (!selected || isDone(item) || !usesCarrier(item)) continue;
    const cached = getTrace(item.mailNo, item.source);
    if (cached && Date.now() - Date.parse(cached.fetchedAt) < (options.manualSync ? MIN_QUERY_MS : s.kuaidi100PollIntervalMin * 60_000)) continue;
    try { await getItemTrace(item); } catch { /* 单票失败不阻断其他包裹；详情页可看到明确错误。 */ }
  }
  await evaluateTracking();
}
