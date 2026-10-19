/**
 * ETA 文案提取，严格对齐 Android `api/EtaParser.kt`。
 * 输入为若干文本片段（轨迹、状态提示等），输出形如 `10月3日送达` / `今天送达` / `10月3日`，无则空串。
 */

const DELIVERY_RE =
  /(?:预计)?[【[]?\s*(\d{1,2})月(\d{1,2})日\s*[】\]]?\s*(?:[（(]?周[^)）]*[)）])?\s*(送达|到达|派送)/;
const FULL_RE =
  /(?:预计)?[【[]?\s*(\d{1,2})月(\d{1,2})日\s*[】\]]?\s*(?:[（(]?周[^)）]*[)）])?\s*(前发货|发货|送达|到达|派送)?/;
const SIMPLE_RE = /(\d{1,2})月(\d{1,2})日(?:[（(]周[^)）]*[)）])?(前发货|发货|送达|到达|派送)/;
const TODAY_RE = /预计(今天|明天|后天)(送达|到达|派送)/;
const PLAIN_DATE_RE = /预计\s*(\d{1,2})月(\d{1,2})日/;

export function extractEta(...texts: Array<string | null | undefined>): string {
  const joined = texts.filter((t): t is string => typeof t === 'string' && t !== '').join(' ');
  if (joined.trim() === '') return '';

  const delivery = DELIVERY_RE.exec(joined);
  if (delivery) {
    return `${delivery[1]}月${delivery[2]}日${delivery[3]}`;
  }

  // 顺序与 Android 一致：full → simple → today
  const full = FULL_RE.exec(joined);
  if (full) {
    return `${full[1]}月${full[2]}日${full[3] ?? ''}`;
  }

  const simple = SIMPLE_RE.exec(joined);
  if (simple) {
    return `${simple[1]}月${simple[2]}日${simple[3]}`;
  }

  const today = TODAY_RE.exec(joined);
  if (today) return `${today[1]}${today[2]}`;

  const plain = PLAIN_DATE_RE.exec(joined);
  if (plain) return `${plain[1]}月${plain[2]}日`;

  return '';
}
