import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';

/**
 * 生成 AES-256 主密钥（base64，32 字节），写入 MASTER_KEY_FILE（0600）。
 * 已存在时默认拒绝覆盖——主密钥丢失/更换会导致所有已存凭据不可读。
 * 用法：node dist/cli/gen-key.js [--force]
 */
const path = config.MASTER_KEY_FILE;
const force = process.argv.includes('--force');

if (existsSync(path) && !force) {
  console.error(`主密钥已存在: ${path}`);
  console.error('如需轮换请先备份，再使用 --force（旧密文将无法解密）');
  process.exit(1);
}

mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, randomBytes(32).toString('base64') + '\n', { mode: 0o600 });
chmodSync(path, 0o600);
console.log(`已写入主密钥: ${path}`);
console.log('请离线备份该文件；丢失后所有平台凭据需重新登录。');
