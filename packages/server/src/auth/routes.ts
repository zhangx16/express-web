import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { getDb } from '../db/client.js';
import { users } from '../db/schema.js';
import { hashPassword, passwordProblem, verifyPassword } from './password.js';
import {
  checkCsrf,
  checkOrigin,
  createSession,
  destroySession,
  resolveSession,
  SESSION_COOKIE,
} from './session.js';
import { AuthError, ForbiddenError, ValidationError } from '../http/errors.js';
import { audit } from '../lib/audit.js';

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(200),
});

const passwordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(1).max(200),
});

/** 登录限流：5 次 / 15 分钟 / IP，由路由级 rateLimit 配置实现 */
export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/auth/login',
    {
      config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
    },
    async (req, reply) => {
      // 登录前没有会话，无法做双提交；只校验 Origin 防跨站登录
      if (!checkOrigin(req)) throw new ForbiddenError('CSRF 校验失败');
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError('用户名或密码格式不正确');
      const { username, password } = parsed.data;

      const db = getDb();
      const user = db.select().from(users).where(eq(users.username, username)).get();

      // 用户不存在时也跑一次 Argon2，避免时序侧信道
      const ok = user
        ? await verifyPassword(user.passwordHash, password)
        : await verifyPassword(
            '$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
            password,
          ).catch(() => false);

      if (!user || !ok) {
        audit(req, 'auth.login.failed', { username });
        throw new AuthError('用户名或密码错误');
      }

      const csrf = createSession(req, reply, user.id);
      audit(req, 'auth.login.ok', { userId: user.id });
      return {
        user: { id: user.id, username: user.username, createdAt: user.createdAt },
        csrfToken: csrf,
      };
    },
  );

  app.post('/auth/logout', async (req, reply) => {
    if (!checkCsrf(req)) throw new ForbiddenError('CSRF 校验失败');
    destroySession(req, reply);
    return { ok: true };
  });

  app.get('/auth/me', async (req) => {
    if (!req.auth) return { user: null, totpEnabled: false };
    const db = getDb();
    const user = db.select().from(users).where(eq(users.id, req.auth.user.id)).get();
    return {
      user: req.auth.user,
      totpEnabled: user?.totpEnabled ?? false,
    };
  });

  app.post('/auth/password', async (req) => {
    if (!req.auth) throw new AuthError();
    if (!checkCsrf(req)) throw new ForbiddenError('CSRF 校验失败');
    const parsed = passwordSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('参数格式不正确');

    const db = getDb();
    const user = db.select().from(users).where(eq(users.id, req.auth.user.id)).get();
    if (!user) throw new AuthError();

    const ok = await verifyPassword(user.passwordHash, parsed.data.currentPassword);
    if (!ok) throw new AuthError('当前密码错误');

    const problem = passwordProblem(parsed.data.newPassword);
    if (problem) throw new ValidationError(problem);

    db.update(users)
      .set({
        passwordHash: await hashPassword(parsed.data.newPassword),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(users.id, user.id))
      .run();

    audit(req, 'auth.password.changed', { userId: user.id });
    return { ok: true };
  });

  /** 供前端启动时判断是否需要显示登录页（不泄露用户信息） */
  app.get('/auth/status', async (req) => {
    const hasCookie = Boolean(req.cookies[SESSION_COOKIE]);
    return { authenticated: Boolean(req.auth), hasCookie };
  });
}

export { resolveSession };
