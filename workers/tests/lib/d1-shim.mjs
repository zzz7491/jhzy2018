/**
 * D1-compat shim over node:sqlite（TEST-ONLY）。
 *
 * 目的：让真实的 Participation repository / service（使用 D1 API：
 *   db.prepare(sql).bind(...).all()/.first()/.run() + db.batch([stmt,...])）
 * 能在离线 node:sqlite 上运行，无需 wrangler dev / 网络 / 重置真实 D1。
 *
 * 方法签名严格对齐 Cloudflare D1：
 *   stmt.bind(...params)        -> this（链式）
 *   stmt.all()                  -> { results: T[] }
 *   stmt.first()                -> T | null
 *   stmt.run()                  -> { success, meta: { changes, last_row_id } }
 *   db.batch([stmt0, stmt1])    -> [ runResult0, runResult1 ]（事务原子）
 */

import { DatabaseSync } from 'node:sqlite';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** 生成 26 位 Crockford ULID（与 src/utils/crypto.ts::generateUlid 同字符集）。 */
export function generateUlid() {
  let s = '';
  for (let i = 0; i < 26; i++) s += CROCKFORD[Math.floor(Math.random() * 32)];
  return s;
}
export const isUlid = (v) =>
  typeof v === 'string' && v.length === 26 && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(v);

class D1Statement {
  constructor(db, sql) {
    this._db = db;
    this._sql = sql;
    this._params = [];
  }
  bind(...params) {
    this._params = params;
    return this;
  }
  _exec(method) {
    const stmt = this._db.prepare(this._sql);
    return stmt[method](...this._params);
  }
  async all() {
    const rows = this._exec('all');
    return { results: rows ?? [] };
  }
  async first() {
    const row = this._exec('get');
    return row ?? null;
  }
  async run() {
    const info = this._exec('run');
    return {
      success: true,
      meta: {
        changes: Number(info?.changes ?? 0),
        last_row_id: Number(info?.lastInsertRowid ?? 0),
      },
    };
  }
  // 兼容潜在调用；返回原始数组。
  async raw() {
    return this._exec('all');
  }
}

export class D1Database {
  constructor(sqliteDb) {
    this._db = sqliteDb;
  }
  prepare(sql) {
    return new D1Statement(this._db, sql);
  }
  /**
   * 原子批处理：D1 batch 在事务内全部成功或整体回滚。
   * 输入为已 prepare+bind 的 D1Statement（来自 repository 的 this.db.prepare().bind()）。
   */
  async batch(stmts) {
    this._db.exec('BEGIN');
    try {
      const out = [];
      for (const s of stmts) out.push(await s.run());
      this._db.exec('COMMIT');
      return out;
    } catch (e) {
      try {
        this._db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw e;
    }
  }
  exec(sql) {
    this._db.exec(sql);
  }
}

/**
 * 打开一个临时 D1 兼容数据库（file-backed，便于调试；调用方负责删除）。
 * @param {string} path  sqlite 文件路径
 * @param {boolean} [fk=true] 是否开启外键约束
 */
export function openD1(path, fk = true) {
  const sqlite = new DatabaseSync(path);
  if (fk) sqlite.exec('PRAGMA foreign_keys = ON;');
  return new D1Database(sqlite);
}

export { DatabaseSync };
