// Checkpoint store: persists migration progress for resumable runs.
// MemoryCheckpoint (tests) / FileCheckpoint (production dry-run/run state).
export class MemoryCheckpoint {
  constructor() {
    this.state = {};
  }
  async load() {
    return this.state;
  }
  async save(patch) {
    this.state = { ...this.state, ...patch };
    return this.state;
  }
  async reset() {
    this.state = {};
  }
}

export class FileCheckpoint {
  constructor(path) {
    this.path = path;
    // NOTE(DEFECT-WP3-01): cached module handle MUST NOT be named `_fs`,
    // because `_fs()` is also a prototype method; an own property named `_fs`
    // shadows the method and makes `this._fs()` throw TypeError.
    this._fsModule = null;
  }
  async _fs() {
    if (!this._fsModule) this._fsModule = await import('node:fs');
    return this._fsModule.promises;
  }
  async load() {
    try {
      const { readFile } = await this._fs();
      const raw = await readFile(this.path, 'utf8');
      return JSON.parse(raw);
    } catch {
      return {};
    }
  }
  async save(patch) {
    const { writeFile } = await this._fs();
    const cur = await this.load();
    const next = { ...cur, ...patch };
    await writeFile(this.path, JSON.stringify(next, null, 2), 'utf8');
    return next;
  }
  async reset() {
    const { writeFile } = await this._fs();
    await writeFile(this.path, '{}', 'utf8');
  }
}
