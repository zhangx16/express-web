import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createGzip } from 'node:zlib';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { config } from '../../config.js';
import { backupTo } from '../../db/client.js';

const KEEP_DAILY = 7;
const KEEP_WEEKLY = 4;
let lastRunDay: string | null = null;

function backupDir(): string {
  const dir = join(config.dataDir, 'backups');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 每日 03:30 在线备份（SQLite backup API，非 cp） */
export async function backupDaily(): Promise<void> {
  const now = new Date();
  const localDay = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const localHour = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false }).format(now),
  );
  const localMinute = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', minute: '2-digit' }).format(now),
  );
  if (lastRunDay === localDay) return;
  if (localHour !== 3 || localMinute < 30) return;

  await runBackup();
  lastRunDay = localDay;
}

export async function runBackup(): Promise<string> {
  const dir = backupDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tmp = join(dir, `app-${stamp}.db`);
  const gz = `${tmp}.gz`;
  await backupTo(tmp);
  await pipeline(createReadStream(tmp), createGzip(), createWriteStream(gz));
  chmodSync(gz, 0o600);
  unlinkSync(tmp);
  prune(dir);
  return gz;
}

/** 保留最近 7 份日备份 + 4 份周备份（周日备份额外保留） */
function prune(dir: string): void {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.db.gz'))
    .map((f) => ({ name: f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);

  const daily = files.slice(0, KEEP_DAILY);
  const weekly = files
    .filter((f) => new Date(f.mtime).getDay() === 0)
    .slice(0, KEEP_WEEKLY);
  const keep = new Set([...daily, ...weekly].map((f) => f.name));

  for (const f of files) {
    if (!keep.has(f.name)) {
      const p = join(dir, f.name);
      if (existsSync(p)) unlinkSync(p);
    }
  }
}

/** 测试/运维用：把备份还原到指定路径（服务需停止） */
export function restoreHint(gzPath: string): string {
  const target = `${gzPath.replace(/\.gz$/, '')}.restored`;
  renameSync(gzPath, target);
  return `请停止服务后执行: gunzip -c ${gzPath} > ${config.dbPath}`;
}
