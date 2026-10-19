import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';

/**
 * AES-256-GCM 信封加密。
 * 格式：enc:v1:<keyId>:<iv-b64>:<tag-b64>:<ct-b64>
 * keyId = 主密钥 SHA-256 的前 8 个 hex 字符，轮换后旧密文仍可识别。
 */

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;

let cachedKey: Buffer | null = null;
let cachedKeyId = '';

function loadMasterKey(): Buffer {
  if (cachedKey) return cachedKey;
  const path = config.MASTER_KEY_FILE;
  if (!existsSync(path)) {
    // 开发/测试：自动生成；生产要求显式提供（见 create-user / docs/OPERATIONS.md）
    if (config.NODE_ENV === 'production') {
      throw new Error(
        `主密钥不存在: ${path}。请运行 \`node dist/cli/gen-key.js\` 生成并妥善备份。`,
      );
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, randomBytes(32).toString('base64') + '\n', { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  const raw = readFileSync(path, 'utf8').trim();
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(`主密钥长度必须为 32 字节（当前 ${key.length}）: ${path}`);
  }
  cachedKey = key;
  cachedKeyId = createHash('sha256').update(key).digest('hex').slice(0, 8);
  return key;
}

export function keyId(): string {
  loadMasterKey();
  return cachedKeyId;
}

export function encrypt(plaintext: string): string {
  const key = loadMasterKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:v1:${cachedKeyId}:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

export function decrypt(envelope: string): string {
  if (!envelope.startsWith('enc:v1:')) {
    throw new Error('密文格式无效');
  }
  const parts = envelope.split(':');
  if (parts.length !== 6) throw new Error('密文格式无效');
  const [, , id, ivB64, tagB64, ctB64] = parts;
  const key = loadMasterKey();
  if (id !== cachedKeyId) {
    throw new Error(
      `密文使用了密钥 ${id}，当前主密钥为 ${cachedKeyId}；请先恢复旧主密钥或运行 rotate-key`,
    );
  }
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64!, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64!, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64!, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

export function encryptJson(value: unknown): string {
  return encrypt(JSON.stringify(value));
}

export function decryptJson<T>(envelope: string): T {
  return JSON.parse(decrypt(envelope)) as T;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** 脱敏：只保留末尾 4 位 */
export function maskTail(secret: string): string {
  if (secret.length <= 4) return '****';
  return `****${secret.slice(-4)}`;
}
