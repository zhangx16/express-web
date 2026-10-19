import type { ServerEvent } from '@ea/shared';

export interface EventStreamOptions {
  /** 收到任意服务端事件 */
  onEvent?: (event: ServerEvent) => void;
  /** 连接状态变化（用于显示「实时已断开」） */
  onStateChange?: (state: 'connecting' | 'open' | 'closed') => void;
}

/**
 * 订阅 `/api/events` SSE 流。
 *
 * - 浏览器 `EventSource` 自动重连并带 `Last-Event-ID`，服务端会重放漏掉的事件。
 * - 服务端对每种事件设置了 `event:` 名，因此按类型逐一监听。
 * - 返回取消订阅函数。
 */
export function subscribeEvents(options: EventStreamOptions = {}): () => void {
  const source = new EventSource('/api/events', { withCredentials: true });
  let closed = false;

  const state = (s: 'connecting' | 'open' | 'closed'): void => options.onStateChange?.(s);
  state('connecting');

  source.onopen = () => {
    if (!closed) state('open');
  };

  source.onerror = () => {
    if (closed) return;
    // EventSource 会自行重连；连接彻底关闭时 readyState 为 CLOSED
    state(source.readyState === EventSource.CLOSED ? 'closed' : 'connecting');
  };

  const handle = (ev: MessageEvent<string>): void => {
    if (!options.onEvent) return;
    try {
      const parsed = JSON.parse(ev.data) as ServerEvent;
      if (parsed && typeof parsed.type === 'string') options.onEvent(parsed);
    } catch {
      // 心跳/注释帧忽略
    }
  };

  const types: ServerEvent['type'][] = [
    'sync.started',
    'sync.channel.started',
    'sync.partial',
    'item.updated',
    'sync.channel.done',
    'sync.done',
    'sync.error',
    'account.status',
    'login.status',
    'notification.sent',
    'report.created',
  ];
  for (const type of types) source.addEventListener(type, handle as EventListener);

  return () => {
    closed = true;
    for (const type of types) source.removeEventListener(type, handle as EventListener);
    source.close();
    state('closed');
  };
}
