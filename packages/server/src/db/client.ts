import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { config } from '../config.js';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;

let sqlite: Database.Database | null = null;
let db: Db | null = null;

export function openDb(path = config.dbPath): { db: Db; sqlite: Database.Database } {
  if (db && sqlite) return { db, sqlite };

  mkdirSync(dirname(path), { recursive: true });
  const conn = new Database(path);
  conn.pragma('journal_mode = WAL');
  conn.pragma('synchronous = NORMAL');
  conn.pragma('foreign_keys = ON');
  conn.pragma('busy_timeout = 5000');
  conn.pragma('temp_store = MEMORY');

  sqlite = conn;
  db = drizzle(conn, { schema });
  return { db, sqlite };
}

export function getDb(): Db {
  return openDb().db;
}

export function getSqlite(): Database.Database {
  return openDb().sqlite;
}

export function closeDb(): void {
  sqlite?.close();
  sqlite = null;
  db = null;
}

export function dbHealthy(): boolean {
  try {
    getSqlite().prepare('SELECT 1').get();
    return true;
  } catch {
    return false;
  }
}

/** 在线备份（SQLite backup API），返回目标路径 */
export async function backupTo(target: string): Promise<string> {
  mkdirSync(dirname(target), { recursive: true });
  await getSqlite().backup(target);
  return target;
}
