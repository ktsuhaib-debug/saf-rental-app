// Local stand-ins for Cloudflare D1, R2 and static assets, so the real Worker code runs under Node.
// Only for tests: production uses the real services.
import { DatabaseSync } from 'node:sqlite';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

class Stmt {
  constructor(db, sql, args) { this.db = db; this.sql = sql; this.args = args || []; }
  bind(...args) { return new Stmt(this.db, this.sql, args); }
  _p() { return this.db.d.prepare(this.sql); }
  async first(col) { this.db.count++; const r = this._p().get(...this.args); if (!r) return null; return col ? (r[col] === undefined ? null : r[col]) : { ...r }; }
  async all() { this.db.count++; return { results: this._p().all(...this.args).map((r) => ({ ...r })), success: true }; }
  async run() { this.db.count++; const r = this._p().run(...this.args); return { success: true, meta: { changes: r.changes } }; }
  _sync() { const p = this._p(); if (p.columns().length) return { results: p.all(...this.args).map((r) => ({ ...r })) }; p.run(...this.args); return { results: [] }; }
}

export class FakeD1 {
  constructor(file) { this.d = new DatabaseSync(file || ':memory:'); this.count = 0; this.batches = 0; this.delay = 0; }
  prepare(sql) { return new Stmt(this, sql); }
  async exec(sql) { this.count++; this.d.exec(sql); return { count: 1 }; }
  async batch(stmts) {
    this.batches++; this.count += stmts.length;
    if (this.delay) await new Promise((r) => setTimeout(r, this.delay));
    this.d.exec('BEGIN');
    try { const out = stmts.map((s) => s._sync()); this.d.exec('COMMIT'); return out; }
    catch (e) { this.d.exec('ROLLBACK'); throw new Error('D1_ERROR: ' + e.message); }
  }
}

export class FakeR2 {
  constructor() { this.m = new Map(); }
  async put(key, body, opts) {
    let bytes;
    if (body instanceof ArrayBuffer) bytes = new Uint8Array(body);
    else if (ArrayBuffer.isView(body)) bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength).slice();
    else bytes = new TextEncoder().encode(String(body));
    this.m.set(key, { bytes, httpMetadata: (opts && opts.httpMetadata) || {}, customMetadata: (opts && opts.customMetadata) || {} });
  }
  async get(key) {
    const o = this.m.get(key); if (!o) return null;
    return { body: o.bytes, httpMetadata: o.httpMetadata, customMetadata: o.customMetadata, writeHttpMetadata(h) { if (o.httpMetadata.contentType) h.set('content-type', o.httpMetadata.contentType); } };
  }
  async delete(keys) { [].concat(keys).forEach((k) => this.m.delete(k)); }
  async list({ prefix, limit }) { const objects = [...this.m.keys()].filter((k) => k.startsWith(prefix || '')).map((key) => ({ key })); return { objects: objects.slice(0, limit || 1000), truncated: false }; }
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.md': 'text/markdown' };
export function fakeAssets(dir) {
  return {
    async fetch(request) {
      let p = new URL(request.url).pathname; if (p === '/') p = '/index.html';
      try {
        const b = await readFile(path.join(dir, path.normalize(p).replace(/^(\.\.[/\\])+/, '')));
        return new Response(b, { headers: { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' } });
      } catch (e) { return new Response('Not found', { status: 404 }); }
    }
  };
}

export function makeEnv(opts) {
  opts = opts || {};
  return { DB: new FakeD1(opts.dbFile), FILES: new FakeR2(), ASSETS: fakeAssets(new URL('../public', import.meta.url).pathname), SYNC_KEY: 'k'.repeat(40) };
}
export const execCtx = () => { const jobs = []; return { jobs, waitUntil(p) { jobs.push(p); }, passThroughOnException() {} }; };
