import { parseCookieHeader } from '../../scrapers/browser/cookies.js';

/** 与 Android `Store.kt` 的标签规则逐字对齐 */

function cookieValue(raw: string, name: string): string {
  const pair = parseCookieHeader(raw).find((p) => p.name === name);
  return pair?.value ?? '';
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function jdLabelOf(cookie: string): string {
  const pin = safeDecode(cookieValue(cookie, 'pt_pin')).slice(0, 16);
  return `京东账号 · ${pin || '账号'}`;
}

export function tbLabelOf(cookie: string): string {
  const unb = cookieValue(cookie, 'unb');
  const key = unb || cookieValue(cookie, 'cookie1').slice(0, 6);
  if (key.trim() !== '') return `淘宝账号 · 尾号${key.slice(-6)}`;
  return '淘宝账号 · 账号';
}

export function pddLabelOf(cookie: string): string {
  const uid = cookieValue(cookie, 'pdd_user_id') || cookieValue(cookie, 'pdduid');
  if (uid.trim() !== '') return `拼多多账号 · 账号${uid.slice(-6)}`;
  return '拼多多账号 · 账号';
}
