import type { FastifyRequest } from 'fastify';

/**
 * 审计日志：只记录动作与主体标识，绝不记录凭据、Cookie、请求体。
 * 写入 stdout（由 systemd journal 收集）。
 */
export function audit(
  req: FastifyRequest | null,
  action: string,
  meta: Record<string, unknown> = {},
): void {
  const entry = {
    level: 'info',
    time: new Date().toISOString(),
    audit: true,
    action,
    ip: req?.ip ?? null,
    userId: req?.auth?.user.id ?? null,
    ...meta,
  };
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}
