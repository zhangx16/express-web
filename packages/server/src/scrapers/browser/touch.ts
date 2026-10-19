import type { Page } from 'playwright';

/**
 * 真实触摸上滑（CDP Input.dispatchTouchEvent），与 Android `swipeUp` 一致：
 * 从视口 90% 高度滑到 8%，8 段、每段 30ms。
 */
export async function swipeUp(page: Page, fromRatio = 0.9, toRatio = 0.08): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { width, height } = page.viewportSize() ?? { width: 390, height: 844 };
    const x = Math.round(width / 2);
    const fromY = Math.round(height * fromRatio);
    const toY = Math.round(height * toRatio);
    const steps = 8;
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x, y: fromY }],
    });
    for (let i = 1; i <= steps; i += 1) {
      const y = Math.round(fromY - ((fromY - toY) * i) / steps);
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y }],
      });
      await sleep(30);
    }
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

/** 点击一个点（远程登录/页面内按钮兜底用） */
export async function tapAt(page: Page, x: number, y: number): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: Math.round(x), y: Math.round(y) }],
    });
    await sleep(60);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
