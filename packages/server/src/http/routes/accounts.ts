import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AccountDto, AccountPatch, Channel } from '@ea/shared';
import { CHANNELS } from '@ea/shared';
import {
  deleteAccount,
  getAccount,
  getAccountRecord,
  listAccounts,
  patchAccount,
  setAccountStatus,
} from '../../services/accounts/repo.js';
import { hasPddLogin } from '../../scrapers/pdd/session.js';
import { dropContext } from '../../browser/pool.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { audit } from '../../lib/audit.js';

const CHANNEL_SET = new Set<string>(CHANNELS);

const patchSchema = z.object({
  label: z.string().trim().min(1).max(64).optional(),
  enabled: z.boolean().optional(),
});

function toDto(id: string): AccountDto {
  const view = getAccount(id);
  if (!view) throw new NotFoundError('账号不存在');
  return view;
}

export async function accountRoutes(app: FastifyInstance): Promise<void> {
  app.get('/accounts', async (req) => {
    const { channel } = req.query as { channel?: string };
    if (channel !== undefined && !CHANNEL_SET.has(channel)) throw new ValidationError('渠道不存在');
    const list = listAccounts(channel ? (channel as Channel) : undefined);
    return { accounts: list.map((a) => toDto(a.id)) };
  });

  app.get('/accounts/:id', async (req) => {
    const { id } = req.params as { id: string };
    return { account: toDto(id) };
  });

  app.patch('/accounts/:id', async (req) => {
    const { id } = req.params as { id: string };
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('参数格式不正确');
    const patch: AccountPatch = parsed.data;
    const account = patchAccount(id, patch);
    audit(req, 'account.patch', { id, fields: Object.keys(patch) });
    return { account: toDto(account.id) };
  });

  app.delete('/accounts/:id', async (req) => {
    const { id } = req.params as { id: string };
    const view = getAccount(id);
    if (!view) throw new NotFoundError('账号不存在');
    deleteAccount(id);
    await dropContext(id);
    audit(req, 'account.delete', { id, channel: view.channel });
    return { ok: true };
  });

  /** 校验登录态：只检查关键 Cookie 是否存在（真实校验在下一次同步） */
  app.post('/accounts/:id/verify', async (req) => {
    const { id } = req.params as { id: string };
    const record = getAccountRecord(id);
    if (!record) throw new NotFoundError('账号不存在');

    if (record.channel === 'pdd' && (record.status === 'challenge' || record.status === 'needs_login')) {
      return { ok: false, account: toDto(id) };
    }
    const cookie = record.payload.cookie ?? '';
    const marker =
      record.channel === 'jd' ? 'pt_key=' : record.channel === 'taobao' ? 'cookie2=' : 'PDDAccessToken=';
    const ok = record.channel === 'pdd' ? hasPddLogin(cookie) : cookie.includes(marker);
    setAccountStatus(id, ok ? 'ok' : 'needs_login', ok ? null : '登录态缺失，请重新登录');
    return { ok, account: toDto(id) };
  });
}
