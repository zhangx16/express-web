import pino from 'pino';
import { config } from '../config.js';

/**
 * pino 配置：脱敏所有凭据字段，且永不记录请求体。
 * 注意 Fastify 默认的 request 日志只含 method/url/status，不含 body。
 */
export const loggerOptions = {
  level: config.LOG_LEVEL,
  redact: {
    paths: [
      'req.headers.cookie',
      'req.headers.authorization',
      'req.headers["x-csrf-token"]',
      'res.headers["set-cookie"]',
      '*.cookie',
      '*.authorization',
      '*.token',
      '*.serviceToken',
      '*.pt_key',
      '*.pt_pin',
      '*.apiKey',
      '*.password',
      '*.passwordHash',
      '*.PDDAccessToken',
      '*.payload',
      '*.payloadEnc',
      '*.valueEnc',
    ],
    censor: '[REDACTED]',
  },
  serializers: {
    req(req: { method: string; url: string; ip?: string }) {
      return { method: req.method, url: req.url, ip: req.ip };
    },
  },
  transport:
    config.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' } }
      : undefined,
};

/** 独立 logger（抓取器/服务层使用；Fastify 自己会用它生成 loggerOptions 对应的实例） */
export const logger = pino(loggerOptions);
