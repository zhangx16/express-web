import type { JdGoods } from '@ea/shared';
import { ensureBrowser, contextOptions, applyStealth } from '../../browser/pool.js';
import { setCookiesForHosts } from '../browser/cookies.js';
import { sleep } from '../browser/touch.js';
import { JD_COOKIE_HOSTS } from './list.js';

const ORDER_CENTER = 'https://wqs.jd.com/order/orderlist_merge.shtml';

const SCRAPE_JS = `(function(){
  var imgs=[].slice.call(document.querySelectorAll('img')).map(function(i){return i.src;}).filter(function(s){return s.indexOf('360buyimg')>=0;});
  var lines=document.body.innerText.split('\\n').map(function(s){return s.trim();}).filter(function(s){return s.length>0;});
  return JSON.stringify({url:location.href,imgs:imgs,lines:lines});
})()`;

/**
 * 京东商品溯源：按单号搜索订单中心，从结果卡解析商品名/图/数量。
 * 与 Android `JdOrderResolver` 一致：以第一个「实付」行为界。
 */
export async function resolveJdGoods(mailNo: string, cookie: string): Promise<JdGoods | null> {
  if (!mailNo) return null;
  const browser = await ensureBrowser();
  const context = await browser.newContext(contextOptions());
  await applyStealth(context);
  try {
    if (cookie) await setCookiesForHosts(context, cookie, JD_COOKIE_HOSTS);
    const page = await context.newPage();
    try {
      await page.goto(ORDER_CENTER, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await sleep(1500);
      const searchUrl =
        'https://trade.m.jd.com/order/orderlist_jdm.shtml?orderType=search&searchKey=' +
        `${encodeURIComponent(mailNo)}&sceneval=`;
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await sleep(4000);
      const raw = await page.evaluate(SCRAPE_JS);
      return parseJdGoods(typeof raw === 'string' ? raw : '', mailNo);
    } finally {
      await page.close().catch(() => undefined);
    }
  } catch {
    return null;
  } finally {
    await context.close().catch(() => undefined);
  }
}

export function parseJdGoods(raw: string, mailNo: string): JdGoods | null {
  let root: { url?: unknown; imgs?: unknown; lines?: unknown };
  try {
    root = JSON.parse(raw) as typeof root;
  } catch {
    return null;
  }
  const url = typeof root.url === 'string' ? root.url : '';
  if (!url.includes(mailNo)) return null;
  const lines = Array.isArray(root.lines) ? root.lines.filter((x): x is string => typeof x === 'string') : [];
  const imgs = Array.isArray(root.imgs) ? root.imgs.filter((x): x is string => typeof x === 'string') : [];

  const priceIdx = lines.findIndex((l) => l.includes('实付'));
  if (priceIdx < 0) return null;

  let name = '';
  let count = '';
  for (const rawLine of lines.slice(0, priceIdx + 1)) {
    const line = rawLine.trim();
    if (/^x\d+$/.test(line) && !count) {
      count = line;
      continue;
    }
    if (
      line.length >= 6 &&
      line.length <= 120 &&
      line.length > name.length &&
      !line.includes('实付') &&
      !line.includes('¥') &&
      !line.includes('￥')
    ) {
      name = line;
    }
  }

  const img =
    imgs.find((s) => s.includes('/n0/') || s.includes('/n1/') || s.includes('/n2/')) ??
    imgs.find((s) => s.length > 40 && !s.includes('storage.')) ??
    '';

  if (!name) return null;
  return { name, imageUrl: img, count, shortName: '' };
}
