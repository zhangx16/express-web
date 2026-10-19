import { afterEach, expect, it, vi } from 'vitest';
import type { QueryClient } from '@tanstack/react-query';
import { createEventInvalidator } from '../../web/src/realtime/invalidation.js';

afterEach(() => vi.useRealTimers());

it('coalesces duplicate completion and partial events into one refresh per query family', async () => {
  vi.useFakeTimers();
  const invalidateQueries = vi.fn().mockResolvedValue(undefined);
  const handler = createEventInvalidator({ invalidateQueries } as unknown as QueryClient);
  for (const event of ['sync.partial', 'sync.channel.done', 'sync.channel.done', 'sync.done']) handler.handle(event);
  await vi.advanceTimersByTimeAsync(400);
  expect(invalidateQueries).toHaveBeenCalledTimes(4);
  expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['items'] });
  handler.dispose();
});

it('refreshes after reconnect and cancels queued work on logout', async () => {
  vi.useFakeTimers();
  const invalidateQueries = vi.fn().mockResolvedValue(undefined);
  const handler = createEventInvalidator({ invalidateQueries } as unknown as QueryClient);
  handler.reconnect();
  await vi.advanceTimersByTimeAsync(400);
  expect(invalidateQueries).toHaveBeenCalledTimes(6);
  handler.handle('sync.partial');
  handler.dispose();
  await vi.advanceTimersByTimeAsync(400);
  expect(invalidateQueries).toHaveBeenCalledTimes(6);
});

it('独立物流更新刷新列表、详情和轨迹缓存', async () => {
  vi.useFakeTimers();
  const invalidateQueries = vi.fn().mockResolvedValue(undefined);
  const handler = createEventInvalidator({ invalidateQueries } as unknown as QueryClient);
  handler.handle('item.updated');
  await vi.advanceTimersByTimeAsync(400);
  expect(invalidateQueries).toHaveBeenCalledTimes(3);
  expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['trace'] });
  handler.dispose();
});
