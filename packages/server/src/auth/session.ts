import { eq, and, gt, isNull, lt } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { getDb } from '../db/client.js';
import { sessions, users } from '../db/schema.js';
import { config, isProduction } from '../config.js';
import { randomToken, sha256Hex } from '../lib/crypto.js';

export const SESSION_COOKIE = 'ea_session';
export const CSRF_COOKIE = 'ea_csrf';
export const CSRF_HEADER = 'x-csrf-token';

export interface AuthUser {
  id: string;
  username: string;
  createdAt: string;
}

export interface SessionInfo {
  sessionId: string;
  user: AuthUser;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: SessionInfo | null;
  }
}

function cookieOptions(): {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'lax';
  path: string;
  maxAge: number;
} {
  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: 'lax',
    path: '/',
    maxAge: config.SESSION_TTL_DAYS * 24 * 60 * 60,
  };
}

/** 创建会话并写 Cookie（含 CSRF 双提交 Cookie） */
export function createSession(req: FastifyRequest, reply: FastifyReply, userId: string): string {
  const db = getDb();
  const token = randomToken(32);
  const csrf = randomToken(24);
  const now = new Date();
  const expires = new Date(now.getTime() + config.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  db.insert(sessions)
    .values({
      id: randomToken(12),
      userId,
      tokenHash: sha256Hex(token),
      userAgent: req.headers['user-agent'] ?? null,
      ip: req.ip,
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      expiresAt: expires.toISOString(),
    })
    .run();

  reply.setCookie(SESSION_COOKIE, token, cookieOptions());
  // CSRF cookie 必须可被 JS 读取
  reply.setCookie(CSRF_COOKIE, csrf, { ...cookieOptions(), httpOnly: false });
  return csrf;
}

export function destroySession(req: FastifyRequest, reply: FastifyReply): void {
  const token = req.cookies[SESSION_COOKIE];
  if (token) {
    getDb()
      .update(sessions)
      .set({ revokedAt: new Date().toISOString() })
      .where(eq(sessions.tokenHash, sha256Hex(token)))
      .run();
  }
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
  reply.clearCookie(CSRF_COOKIE, { path: '/' });
}

/** 从 Cookie 解析会话；滑动续期（每 24h 更新一次 lastSeenAt） */
export function resolveSession(req: FastifyRequest): SessionInfo | null {
  const token = req.cookies[SESSION_COOKIE];
  if (!token) return null;

  const db = getDb();
  const nowIso = new Date().toISOString();
  const row = db
    .select({
      sessionId: sessions.id,
      lastSeenAt: sessions.lastSeenAt,
      userId: users.id,
      username: users.username,
      createdAt: users.createdAt,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(
      and(
        eq(sessions.tokenHash, sha256Hex(token)),
        isNull(sessions.revokedAt),
        gt(sessions.expiresAt, nowIso),
      ),
    )
    .get();

  if (!row) return null;

  const lastSeen = Date.parse(row.lastSeenAt);
  if (Number.isNaN(lastSeen) || Date.now() - lastSeen > 24 * 60 * 60 * 1000) {
    db.update(sessions)
      .set({
        lastSeenAt: nowIso,
        expiresAt: new Date(
          Date.now() + config.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000,
        ).toISOString(),
      })
      .where(eq(sessions.id, row.sessionId))
      .run();
  }

  return {
    sessionId: row.sessionId,
    user: { id: row.userId, username: row.username, createdAt: row.createdAt },
  };
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Origin 校验：拒绝跨站来源。
 * 登录前尚无 CSRF Cookie，因此登录接口只做这一层。
 */
export function checkOrigin(req: FastifyRequest): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (origin === config.PUBLIC_ORIGIN) return true;
  // 允许开发期同源代理
  const host = req.headers.host;
  try {
    if (!host || new URL(origin).host !== host) return false;
  } catch {
    return false;
  }
  return true;
}

/**
 * CSRF 校验：双提交 Cookie + Origin 检查。
 * 登录接口本身豁免双提交（无会话可劫持），但同样校验 Origin。
 */
export function checkCsrf(req: FastifyRequest): boolean {
  if (!checkOrigin(req)) return false;
  if (!UNSAFE_METHODS.has(req.method)) return true;
  const cookie = req.cookies[CSRF_COOKIE];
  const header = req.headers[CSRF_HEADER];
  if (typeof header !== 'string' || !cookie) return false;
  return timingSafeEqualStr(cookie, header);
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 清理过期会话与登录会话（调度器每日调用） */
export function cleanupSessions(): number {
  const db = getDb();
  const res = db.delete(sessions).where(lt(sessions.expiresAt, new Date().toISOString())).run();
  return res.changes;
}
