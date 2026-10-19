import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import { config, isProduction } from '../config.js';
import { loggerOptions } from '../lib/logger.js';
import { AppError } from './errors.js';
import { authRoutes, resolveSession } from '../auth/routes.js';
import { checkCsrf } from '../auth/session.js';
import { healthRoutes } from './routes/health.js';
import { eventRoutes } from './routes/events.js';
import { itemRoutes } from './routes/items.js';
import { syncRoutes } from './routes/sync.js';
import { accountRoutes } from './routes/accounts.js';
import { loginRoutes } from './routes/login.js';
import { settingsRoutes } from './routes/settings.js';
import { addressRoutes } from './routes/addresses.js';
import { reportsRoutes } from './routes/reports.js';
import { publicApiRoutes } from './routes/public-api.js';

const PUBLIC_PATHS = new Set([
  '/health',
  '/api/health',
  '/api/auth/login',
  '/api/auth/status',
  '/api/auth/logout',
]);

function isPublic(req: { url: string; method: string }): boolean {
  const path = req.url.split('?')[0] ?? req.url;
  if (PUBLIC_PATHS.has(path)) return true;
  // 静态资源与 SPA 路由交给前端；API 一律鉴权
  if (!path.startsWith('/api/') && !path.startsWith('/ws/')) return true;
  if (path.startsWith('/api/v1/')) return true; // Bearer token，由路由自身校验
  return false;
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: loggerOptions,
    trustProxy: config.trustProxy,
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
      },
    },
    hsts: isProduction ? { maxAge: 31536000, includeSubDomains: false } : false,
    referrerPolicy: { policy: 'no-referrer' },
  });

  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    allowList: (req) => req.url === '/health' || req.url === '/api/health',
  });

  // 会话解析：所有请求
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req) => {
    req.auth = resolveSession(req);
  });

  // 鉴权 + CSRF
  app.addHook('onRequest', async (req) => {
    if (isPublic(req)) return;
    if (!req.auth) {
      throw new AppError(401, 'unauthorized', '未登录或会话已过期');
    }
    if (!checkCsrf(req)) {
      throw new AppError(403, 'csrf_failed', 'CSRF 校验失败');
    }
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({
        error: err.code,
        message: err.message,
      });
    }
    const statusCode = (err as { statusCode?: number } | null)?.statusCode;
    const message = err instanceof Error ? err.message : '请求失败';
    if (statusCode && statusCode < 500) {
      return reply.status(statusCode).send({
        error: 'request_error',
        message,
      });
    }
    req.log.error({ err }, 'unhandled error');
    // 生产环境不回传堆栈
    return reply.status(500).send({
      error: 'internal_error',
      message: '服务器内部错误',
    });
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) {
      return reply.status(404).send({ error: 'not_found', message: '接口不存在' });
    }
    // 带 hash 的静态资源缺失时不要回落到 index.html，否则浏览器会因 MIME 不符而静默白屏
    if (req.url.startsWith('/assets/')) {
      return reply.status(404).send({ error: 'not_found', message: '资源不存在' });
    }
    // SPA 兜底
    const indexPath = join(config.dataDir, 'web', 'index.html');
    if (existsSync(indexPath)) {
      return reply.type('text/html').sendFile('index.html');
    }
    return reply.status(404).send({ error: 'not_found', message: '页面不存在' });
  });

  // 静态前端（构建产物复制到 DATA_DIR/web）
  const webRoot = join(config.dataDir, 'web');
  if (existsSync(webRoot)) {
    await app.register(fastifyStatic, {
      root: webRoot,
      prefix: '/',
      // 必须用通配路由：wildcard:false 会在启动时按文件名逐个注册，
      // 重新部署后新的 hash 文件名要等重启才可访问（否则落到 SPA 兜底返回 HTML）
      wildcard: true,
      index: ['index.html'],
      cacheControl: true,
      maxAge: '1h',
      setHeaders(reply, path) {
        if (path.endsWith('index.html') || path.endsWith('sw.js')) {
          reply.header('Cache-Control', 'no-store');
        } else if (path.includes('/assets/')) {
          reply.header('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    });
  }

  // 路由
  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: '/api' });
  await app.register(eventRoutes, { prefix: '/api' });
  await app.register(itemRoutes, { prefix: '/api' });
  await app.register(syncRoutes, { prefix: '/api' });
  await app.register(accountRoutes, { prefix: '/api' });
  // 远程登录截图/输入转发（WS），需在 loginRoutes 之前注册
  await app.register(websocket, {
    options: { maxPayload: 256 * 1024, clientTracking: false },
  });
  await app.register(loginRoutes, { prefix: '/api' });
  await app.register(settingsRoutes, { prefix: '/api' });
  await app.register(addressRoutes, { prefix: '/api' });
  await app.register(reportsRoutes, { prefix: '/api' });
  await app.register(publicApiRoutes);

  return app;
}
