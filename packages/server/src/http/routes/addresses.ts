import type { FastifyInstance } from 'fastify';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AddressDto } from '@ea/shared';
import { getDb } from '../../db/client.js';
import { addresses } from '../../db/schema.js';
import { randomToken } from '../../lib/crypto.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { audit } from '../../lib/audit.js';

const createSchema = z.object({
  label: z.string().trim().min(1).max(64),
  address: z.string().trim().min(1).max(500),
  active: z.boolean().optional(),
});

const patchSchema = z
  .object({
    label: z.string().trim().min(1).max(64).optional(),
    address: z.string().trim().min(1).max(500).optional(),
    active: z.boolean().optional(),
  })
  .strict();

function rowToDto(row: typeof addresses.$inferSelect): AddressDto {
  return { id: row.id, label: row.label, address: row.address, active: row.active };
}

function list(): AddressDto[] {
  return getDb().select().from(addresses).orderBy(asc(addresses.createdAt)).all().map(rowToDto);
}

function deactivateOthers(id: string | null): void {
  const db = getDb();
  const now = new Date().toISOString();
  for (const row of db.select().from(addresses).all()) {
    if (!row.active) continue;
    if (row.id === id) continue;
    db.update(addresses).set({ active: false, updatedAt: now }).where(eq(addresses.id, row.id)).run();
  }
}

/** 收货地址：单选 active，AI/日报用它判断「到家」件 */
export async function addressRoutes(app: FastifyInstance): Promise<void> {
  app.get('/addresses', async () => {
    const all = list();
    return { addresses: all, activeId: all.find((a) => a.active)?.id ?? null };
  });

  app.post('/addresses', async (req) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('地址格式不正确');
    const body = parsed.data;

    const db = getDb();
    const now = new Date().toISOString();
    const id = randomToken(12);
    const first = db.select().from(addresses).all().length === 0;
    const active = body.active ?? first;

    db.insert(addresses)
      .values({
        id,
        label: body.label,
        address: body.address,
        active,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    if (active) deactivateOthers(id);

    audit(req, 'address.create', { id, active });
    return { address: rowToDto(db.select().from(addresses).where(eq(addresses.id, id)).get()!) };
  });

  app.patch('/addresses/:id', async (req) => {
    const { id } = req.params as { id: string };
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError('地址格式不正确');
    const patch = parsed.data;

    const db = getDb();
    const existing = db.select().from(addresses).where(eq(addresses.id, id)).get();
    if (!existing) throw new NotFoundError('地址不存在');

    db.update(addresses)
      .set({
        ...(patch.label !== undefined ? { label: patch.label } : {}),
        ...(patch.address !== undefined ? { address: patch.address } : {}),
        ...(patch.active !== undefined ? { active: patch.active } : {}),
        updatedAt: new Date().toISOString(),
      })
      .where(eq(addresses.id, id))
      .run();
    if (patch.active) deactivateOthers(id);

    audit(req, 'address.patch', { id, fields: Object.keys(patch) });
    return { address: rowToDto(db.select().from(addresses).where(eq(addresses.id, id)).get()!) };
  });

  /** 设为默认地址 */
  app.post('/addresses/:id/activate', async (req) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const existing = db.select().from(addresses).where(eq(addresses.id, id)).get();
    if (!existing) throw new NotFoundError('地址不存在');
    deactivateOthers(id);
    db.update(addresses)
      .set({ active: true, updatedAt: new Date().toISOString() })
      .where(eq(addresses.id, id))
      .run();
    audit(req, 'address.activate', { id });
    return { address: rowToDto(db.select().from(addresses).where(eq(addresses.id, id)).get()!) };
  });

  app.delete('/addresses/:id', async (req) => {
    const { id } = req.params as { id: string };
    const db = getDb();
    const existing = db.select().from(addresses).where(eq(addresses.id, id)).get();
    if (!existing) throw new NotFoundError('地址不存在');
    db.delete(addresses).where(eq(addresses.id, id)).run();
    audit(req, 'address.delete', { id });
    return { ok: true };
  });
}
