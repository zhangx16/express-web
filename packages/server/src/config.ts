import { existsSync } from 'node:fs';
import { z } from 'zod';

/** 开发期从 .env 载入；生产由 systemd EnvironmentFile 注入，不读文件 */
function loadDotEnv(): void {
  const path = new URL('../../../.env', import.meta.url).pathname;
  if (existsSync(path) && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(path);
  }
}

loadDotEnv();

const boolFromEnv = z
  .string()
  .optional()
  .transform((v) => v === '1' || v === 'true' || v === 'yes');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('production'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  DATA_DIR: z.string().default('/var/lib/expressassistant'),
  DB_PATH: z.string().optional(),
  MASTER_KEY_FILE: z.string().default('/etc/expressassistant/master.key'),

  PUBLIC_ORIGIN: z.string().default('http://127.0.0.1:3000'),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  TRUST_PROXY: z.string().default('loopback'),

  /** 浏览器：auto = 有 DISPLAY 用有头，否则无头 */
  CHROMIUM_PATH: z.string().optional(),
  DISPLAY: z.string().optional(),
  BROWSER_HEADLESS: z.enum(['auto', '0', '1']).default('auto'),
  BROWSER_MAX_CONTEXTS: z.coerce.number().int().min(1).max(4).default(2),

  /** 测试用：禁用调度器与浏览器 */
  DISABLE_SCHEDULER: boolFromEnv,
  DISABLE_BROWSER: boolFromEnv,
});

export type Config = z.infer<typeof envSchema> & {
  dbPath: string;
  dataDir: string;
  headless: boolean;
  trustProxy: boolean | string;
};

function parseConfig(): Config {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`配置无效: ${detail}`);
  }
  const env = parsed.data;
  const dataDir = env.DATA_DIR;
  const headless =
    env.BROWSER_HEADLESS === '1' ? true : env.BROWSER_HEADLESS === '0' ? false : !env.DISPLAY;
  const trustProxy =
    env.TRUST_PROXY === 'true' ? true : env.TRUST_PROXY === 'false' ? false : env.TRUST_PROXY;

  return {
    ...env,
    dataDir,
    dbPath: env.DB_PATH ?? `${dataDir}/app.db`,
    headless,
    trustProxy,
  };
}

export const config = parseConfig();

export const isProduction = config.NODE_ENV === 'production';
export const isTest = config.NODE_ENV === 'test';
