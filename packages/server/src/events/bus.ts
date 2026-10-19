import type { EventEnvelope, ServerEvent } from '@ea/shared';

type Listener = (env: EventEnvelope) => void;

const RING_SIZE = 500;

/**
 * 进程内事件总线：SSE 推送 + Last-Event-ID 重放。
 * 单进程部署，无需 Redis；重启后 id 从 1 重新开始（前端收到断流会重新拉全量）。
 */
class EventBus {
  private nextId = 1;
  private ring: EventEnvelope[] = [];
  private listeners = new Set<Listener>();

  publish(event: ServerEvent): EventEnvelope {
    const env: EventEnvelope = {
      id: this.nextId++,
      event,
      at: new Date().toISOString(),
    };
    this.ring.push(env);
    if (this.ring.length > RING_SIZE) this.ring.shift();
    for (const l of this.listeners) {
      try {
        l(env);
      } catch {
        // 单个订阅者异常不影响其他订阅者
      }
    }
    return env;
  }

  /** 返回 id > lastId 的缓冲事件；lastId 缺失时返回空（客户端应全量拉取） */
  replaySince(lastId: number | null): EventEnvelope[] {
    if (lastId === null) return [];
    return this.ring.filter((e) => e.id > lastId);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get listenerCount(): number {
    return this.listeners.size;
  }

  /** 测试用 */
  reset(): void {
    this.nextId = 1;
    this.ring = [];
    this.listeners.clear();
  }
}

export const eventBus = new EventBus();
