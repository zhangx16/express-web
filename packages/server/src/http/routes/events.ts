import type { FastifyInstance } from 'fastify';
import { eventBus } from '../../events/bus.js';

const HEARTBEAT_MS = 15_000;

/** SSE 事件流：支持 Last-Event-ID 重放，15 秒心跳穿过 Cloudflare/nginx */
export async function eventRoutes(app: FastifyInstance): Promise<void> {
  app.get('/events', async (req, reply) => {
    const raw = req.headers['last-event-id'];
    const lastId = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : null;

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(': connected\n\n');

    const write = (id: number, event: string, data: unknown): void => {
      reply.raw.write(`id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    for (const env of eventBus.replaySince(lastId)) {
      write(env.id, env.event.type, env.event);
    }

    const unsubscribe = eventBus.subscribe((env) => {
      write(env.id, env.event.type, env.event);
    });

    const heartbeat = setInterval(() => {
      reply.raw.write(': ping\n\n');
    }, HEARTBEAT_MS);

    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);

    // 保持连接直到客户端断开
    await new Promise<void>((resolve) => {
      req.raw.on('close', resolve);
    });
  });
}
