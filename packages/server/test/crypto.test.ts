import { describe, expect, it } from 'vitest';
import { mtopSign } from '../src/scrapers/taobao/mtop.js';

describe('淘宝 mtop 签名', () => {
  it('固定向量：md5(token&t&appKey&dataRaw) 小写', () => {
    expect(mtopSign('abc', '1700000000000', '{"data":{"page":1}}')).toBe(
      'abe3e95cff3db65874e61d8aa843d880',
    );
  });

  it('dataRaw 不做 URL 编码', () => {
    const raw = '{"data":{"q":"中文 & 空格"}}';
    expect(mtopSign('tok', '1', raw)).toBe(mtopSign('tok', '1', raw));
    expect(mtopSign('tok', '1', raw)).toHaveLength(32);
    expect(mtopSign('tok', '1', encodeURIComponent(raw))).not.toBe(mtopSign('tok', '1', raw));
  });
});
