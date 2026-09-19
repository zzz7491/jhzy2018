// Adapters: source (1.0 MySQL) and target (2.0 D1) + archive sink.
// Frozen target model: INTEGER PK (auto) + public_id ULID + INTEGER epoch time.
// Production topology (client access) is NOT touched by this toolkit.

// ---------- SOURCE ----------
// SourceAdapter interface:
//   async listTables() -> [srcKey]
//   getColumns(srcKey) -> [col]
//   async *streamRows(srcKey) -> yields source rows

// In-memory fixture source (tests).
export class FixtureSource {
  constructor(tables = {}) {
    this.tables = tables; // { 'api.users': [row,...], ... }
  }
  async listTables() {
    return Object.keys(this.tables);
  }
  getColumns(srcKey) {
    const rows = this.tables[srcKey] || [];
    return rows[0] ? Object.keys(rows[0]) : [];
  }
  async *streamRows(srcKey) {
    for (const row of this.tables[srcKey] || []) yield row;
  }
}

// File-based dump source (production): 1.0 exported to JSON per table.
export class DumpSource {
  constructor(dir, fsMod) {
    this.dir = dir;
    this.fs = fsMod; // node:fs (passed in to avoid static import in browser/worker)
    this.cache = {};
  }
  _file(srcKey) {
    return `${this.dir}/${srcKey.replace(/\W/g, '__')}.json`;
  }
  async listTables() {
    const { readdir } = this.fs;
    const files = await readdir(this.dir);
    return files
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/__/g, '.').replace(/\.json$/, ''));
  }
  getColumns(srcKey) {
    const rows = this.cache[srcKey] || [];
    return rows[0] ? Object.keys(rows[0]) : [];
  }
  async *streamRows(srcKey) {
    if (!this.cache[srcKey]) {
      const { readFile } = this.fs;
      const raw = await readFile(this._file(srcKey), 'utf8');
      this.cache[srcKey] = JSON.parse(raw);
    }
    for (const row of this.cache[srcKey]) yield row;
  }
}

// ---------- TARGET ----------
// TargetAdapter interface:
//   async insert(table, row|row[]) -> {id, row}
//   async lookupIdMap(sourceSystem, sourceTable, legacyId) -> rec|null
//   async writeIdMap(rec)
//   async writeIssue(rec)
//   async archive(sourceSystem, sourceTable, legacyId, payload)
//   async query(table, where) -> [row]
//   count(table) -> number

// In-memory target (tests). Mirrors D1 insert semantics (auto INTEGER id).
export class MemoryTarget {
  constructor() {
    this.tables = new Map();
    this.archiveStore = [];
    this.idmaps = [];
    this.issues = [];
  }
  _t(name) {
    if (!this.tables.has(name)) this.tables.set(name, { rows: [], nextId: 1 });
    return this.tables.get(name);
  }
  async insert(table, row) {
    if (row == null) return null;
    if (Array.isArray(row)) {
      let last = null;
      for (const r of row) last = await this.insert(table, r);
      return last;
    }
    const t = this._t(table);
    const id = row.id != null ? row.id : t.nextId++;
    const stored = { ...row, id };
    t.rows.push(stored);
    return { id, row: stored };
  }
  async lookupIdMap(sourceSystem, sourceTable, legacyId) {
    return (
      this.idmaps.find(
        (m) =>
          m.source_system === sourceSystem &&
          m.source_table === sourceTable &&
          String(m.legacy_id) === String(legacyId)
      ) || null
    );
  }
  async writeIdMap(rec) {
    this.idmaps.push(rec);
    return rec;
  }
  async writeIssue(rec) {
    this.issues.push(rec);
    return rec;
  }
  async archive(sourceSystem, sourceTable, legacyId, payload) {
    const rec = {
      source_system: sourceSystem,
      source_table: sourceTable,
      legacy_id: legacyId,
      payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
    };
    this.archiveStore.push(rec);
    return rec;
  }
  query(table, where = {}) {
    const t = this.tables.get(table);
    if (!t) return [];
    return t.rows.filter((r) => Object.entries(where).every(([k, v]) => r[k] === v));
  }
  count(table) {
    return this.tables.get(table)?.rows.length ?? 0;
  }
  allIdMaps() {
    return this.idmaps;
  }
  allIssues() {
    return this.issues;
  }
  allArchive() {
    return this.archiveStore;
  }
}

// Production adapter: Cloudflare D1 binding (env.DB). Same interface; not executed here.
// D1 enforces INTEGER PK auto-increment + public_id ULID + epoch (per D1-DATABASE-DESIGN).
export class D1Target {
  constructor(db) {
    this.db = db; // D1Database
  }
  async insert(table, row) {
    const rows = Array.isArray(row) ? row : [row];
    let lastId = null;
    // D1 batch for atomicity where supported; single inserts otherwise.
    for (const r of rows) {
      const cols = Object.keys(r);
      const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols
        .map(() => '?')
        .join(',')})`;
      const info = await this.db.prepare(sql).bind(...cols.map((c) => r[c])).run();
      lastId = info.meta?.last_row_id ?? null;
    }
    return { id: lastId, row: rows[rows.length - 1] };
  }
  async lookupIdMap(ss, st, lid) {
    const r = await this.db
      .prepare(
        'SELECT * FROM legacy_id_maps WHERE source_system=? AND source_table=? AND legacy_id=?'
      )
      .bind(ss, st, String(lid))
      .first();
    return r || null;
  }
  async writeIdMap(rec) {
    return this.insert('legacy_id_maps', rec);
  }
  async writeIssue(rec) {
    return this.insert('migration_issues', rec);
  }
  async archive(ss, st, lid, payload) {
    return this.insert('migration_archive', {
      source_system: ss,
      source_table: st,
      legacy_id: lid,
      payload: JSON.stringify(payload),
    });
  }
  async query(table, where = {}) {
    const clauses = Object.keys(where).map((k) => `${k}=?`);
    const sql = `SELECT * FROM ${table}${clauses.length ? ' WHERE ' + clauses.join(' AND ') : ''}`;
    return this.db.prepare(sql).bind(...Object.values(where)).all();
  }
  count(table) {
    return this.db.prepare(`SELECT COUNT(*) c FROM ${table}`).first().c;
  }
}
