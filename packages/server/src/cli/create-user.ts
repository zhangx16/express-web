import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { eq } from 'drizzle-orm';
import { getDb, openDb } from '../db/client.js';
import { migrate } from '../db/migrate.js';
import { users } from '../db/schema.js';
import { hashPassword, passwordProblem } from '../auth/password.js';

/**
 * 创建/重置单用户账号。
 * 用法：
 *   npm run create-user -w @ea/server -- <用户名> [密码]
 * 不传密码时交互输入（不回显在 shell 历史里）。
 */
async function readPassword(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question('密码（至少 8 位，非纯数字）: ')).trim();
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const [usernameArg, passwordArg] = process.argv.slice(2);
  if (!usernameArg) {
    console.error('用法: npm run create-user -w @ea/server -- <用户名> [密码]');
    process.exit(1);
  }
  const username = usernameArg.trim();
  if (!username || username.length > 64) {
    console.error('用户名不能为空且不超过 64 字符');
    process.exit(1);
  }

  const password = (passwordArg ?? (await readPassword())).trim();
  const problem = passwordProblem(password);
  if (problem) {
    console.error(problem);
    process.exit(1);
  }

  openDb();
  migrate();
  const db = getDb();
  const passwordHash = await hashPassword(password);
  const now = new Date().toISOString();

  const existing = db.select().from(users).where(eq(users.username, username)).get();
  if (existing) {
    db.update(users).set({ passwordHash, updatedAt: now }).where(eq(users.id, existing.id)).run();
    console.log(`已重置用户 ${username} 的密码`);
  } else {
    db.insert(users)
      .values({
        id: randomUUID(),
        username,
        passwordHash,
        totpEnabled: false,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    console.log(`已创建用户 ${username}`);
  }
}

void main().catch((err: unknown) => {
  console.error('创建用户失败:', err instanceof Error ? err.message : err);
  process.exit(1);
});
