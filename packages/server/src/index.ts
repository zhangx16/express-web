import { config } from './config.js';
import { closeDb, openDb } from './db/client.js';
import { migrate } from './db/migrate.js';
import { buildApp } from './http/app.js';
import { logger } from './lib/logger.js';
import { startScheduler, stopScheduler } from './scheduler/scheduler.js';
import { closeAllLoginSessions } from './http/routes/login.js';
import { shutdownBrowser, startContextJanitor } from './browser/pool.js';

async function main(): Promise<void> {
  openDb();
  const applied = migrate();
  if (applied.length > 0) logger.info({ migrations: applied }, 'migrations applied');

  const app = await buildApp();

  try {
    await app.listen({ host: config.HOST, port: config.PORT });
  } catch (err) {
    logger.error({ err }, 'failed to listen');
    closeDb();
    process.exit(1);
  }

  const janitor = config.DISABLE_BROWSER ? null : startContextJanitor();
  if (!config.DISABLE_SCHEDULER) startScheduler();

  logger.info(
    {
      host: config.HOST,
      port: config.PORT,
      dataDir: config.dataDir,
      dbPath: config.dbPath,
      headless: config.headless,
      scheduler: !config.DISABLE_SCHEDULER,
    },
    'expressassistant started',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    // 先停止新任务，再释放浏览器与连接
    stopScheduler();
    if (janitor) clearInterval(janitor);

    const force = setTimeout(() => {
      logger.warn('graceful shutdown timed out, exiting');
      process.exit(1);
    }, 15_000);
    force.unref();

    try {
      await app.close();
      await closeAllLoginSessions();
      await shutdownBrowser();
      closeDb();
    } catch (err) {
      logger.error({ err }, 'shutdown error');
    }
    clearTimeout(force);
    logger.info('bye');
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ reason }, 'unhandled rejection');
  });
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'uncaught exception');
    void shutdown('uncaughtException');
  });
}

void main().catch((err: unknown) => {
  logger.fatal({ err }, 'startup failed');
  process.exit(1);
});
