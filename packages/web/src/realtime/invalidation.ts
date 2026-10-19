import type { QueryClient } from '@tanstack/react-query';

function affectedQueries(type: string): string[] {
  switch (type) {
    case 'item.updated': return ['items', 'item', 'trace'];
    case 'sync.partial': return ['items'];
    case 'sync.channel.done':
    case 'sync.done': return ['items', 'item', 'trace', 'sync'];
    case 'sync.error': return ['items', 'sync'];
    case 'sync.started': return ['sync'];
    case 'account.status': return ['accounts'];
    case 'login.status': return ['accounts', 'login'];
    case 'report.created': return ['reports'];
    case 'notification.sent': return ['items'];
    default: return [];
  }
}

/** 一批事件只刷新一次对应缓存，避免每个渠道完成时重复取消/重发请求。 */
export function createEventInvalidator(qc: QueryClient) {
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = (): void => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    const keys = [...pending];
    pending.clear();
    for (const key of keys) void qc.invalidateQueries({ queryKey: [key] });
  };
  return {
    handle(type: string): void {
      for (const key of affectedQueries(type)) pending.add(key);
      if (pending.size && !timer) timer = setTimeout(flush, 400);
    },
    reconnect(): void {
      for (const key of ['items', 'item', 'trace', 'accounts', 'sync', 'reports']) pending.add(key);
      if (!timer) timer = setTimeout(flush, 400);
    },
    dispose(): void {
      if (timer) clearTimeout(timer);
      timer = undefined;
      pending.clear();
    },
  };
}
