import { hash, verify } from '@node-rs/argon2';

/**
 * Argon2id 参数：约 19 MiB 内存 / 2 轮，单用户场景足够。
 * 注意：`Algorithm` 是 ambient const enum，isolatedModules 下不可用，故直接用数值 2（Argon2id）。
 */
const OPTIONS = {
  algorithm: 2,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

/** 最低密码强度：8 位以上且非纯数字 */
export function passwordProblem(password: string): string | null {
  if (password.length < 8) return '密码至少 8 位';
  if (password.length > 200) return '密码过长';
  if (/^\d+$/.test(password)) return '密码不能为纯数字';
  return null;
}
