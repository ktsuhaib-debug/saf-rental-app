// D1 storage. Each request loads every table in ONE query, works on the rows in memory
// (so the business rules read exactly like the old Apps Script code), then saves all of its
// changes in ONE all-or-nothing batch. A revision number guards against two partners saving
// at the same moment: the second save is retried on fresh data instead of overwriting the first.
import { SCHEMA, DEFAULT_SETTINGS, sqlType, q, normalize, toDb, fromDb } from './schema.mjs';

export const TABLES = Object.keys(SCHEMA).filter((n) => n !== 'Activity');
export const SCHEMA_VERSION = 1;
const CHUNK_BYTES = 800000; // keep each bound JSON parameter well under D1's size limit

export class ConflictError extends Error {
  constructor() { super('Someone else saved at the same moment. Trying again.'); this.code = 'CONFLICT'; }
}

let schemaReady = false;

function createSql() {
  const lines = [
    'CREATE TABLE IF NOT EXISTS _meta (k TEXT PRIMARY KEY, v);',
    'CREATE TABLE IF NOT EXISTS _kv (k TEXT PRIMARY KEY, v TEXT, exp INTEGER);',
    'CREATE TABLE IF NOT EXISTS _guard (x INTEGER CHECK (x = 0));',
    "INSERT OR IGNORE INTO _meta (k, v) VALUES ('revision', 0);"
  ];
  Object.keys(SCHEMA).forEach((t) => {
    const cols = SCHEMA[t].map((c) => q(c) + (sqlType(t, c) ? ' ' + sqlType(t, c) : '')).join(', ');
    lines.push(`CREATE TABLE IF NOT EXISTS ${q(t)} (_rid INTEGER PRIMARY KEY AUTOINCREMENT, ${cols});`);
    lines.push(`CREATE INDEX IF NOT EXISTS ${q('idx_' + t)} ON ${q(t)} (${q(SCHEMA[t][0])});`);
  });
  // One row per default setting, read from a JSON list (D1 allows only a few UNION terms in one SELECT).
  const json = JSON.stringify(DEFAULT_SETTINGS).replace(/'/g, "''");
  lines.push(`INSERT INTO "Settings" ("Key", "Value", "Notes") SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]') FROM json_each('${json}') WHERE NOT EXISTS (SELECT 1 FROM "Settings");`);
  lines.push(`INSERT OR REPLACE INTO _meta (k, v) VALUES ('schema', ${SCHEMA_VERSION});`);
  return lines.join('\n');
}

/** Create the tables on first use. Costs one small query per worker start once they exist. */
export async function ensureSchema(db) {
  if (schemaReady) return;
  let v = null;
  try { v = await db.prepare("SELECT v FROM _meta WHERE k = 'schema'").first('v'); } catch (e) { v = null; }
  if (Number(v) !== SCHEMA_VERSION) await db.exec(createSql());
  schemaReady = true;
}

/** One batch (a single round trip): every table, the key/value store and the revision. */
export async function loadStore(db) {
  await ensureSchema(db);
  const stmts = TABLES.map((t) => db.prepare(`SELECT * FROM ${q(t)} ORDER BY _rid`));
  stmts.push(db.prepare('SELECT k, v, exp FROM _kv'));
  stmts.push(db.prepare("SELECT v FROM _meta WHERE k = 'revision'"));
  const res = await db.batch(stmts);
  const data = { tables: {} };
  TABLES.forEach((t, i) => { data.tables[t] = res[i].results || []; });
  data.kv = res[TABLES.length].results || [];
  data.revision = Number(((res[TABLES.length + 1].results || [])[0] || {}).v || 0);
  return new Store(db, data);
}

/** Last rows of the activity log, newest first. */
export async function recentActivity(db, n) {
  const r = await db.prepare('SELECT * FROM "Activity" ORDER BY _rid DESC LIMIT ?').bind(n).all();
  return (r.results || []).map((x) => { const o = {}; SCHEMA.Activity.forEach((c) => { o[c] = fromDb(x[c], c); }); return o; });
}

export class Store {
  constructor(db, data) {
    this.db = db;
    this.revision = data.revision;
    this.rows = {};
    this.dirty = {};
    this.deleted = {};
    TABLES.forEach((t) => {
      const cols = SCHEMA[t];
      this.rows[t] = data.tables[t].map((x) => {
        const o = { _rid: x._rid };
        cols.forEach((c) => { o[c] = fromDb(x[c], c); });
        return o;
      });
      this.deleted[t] = [];
    });
    const now = Date.now();
    this.kv = {};
    data.kv.forEach((a) => { if (!a.exp || a.exp > now) this.kv[a.k] = { v: a.v, exp: a.exp || null }; });
    this.kvChanged = {};
    this.activity = [];
  }

  /* ----- tables ----- */
  key(name) { return SCHEMA[name][0]; }
  live(name) { const k = this.key(name); return this.rows[name].filter((r) => r[k] !== '' && r[k] !== null); }
  copy(r) { const o = {}; Object.keys(r).forEach((k) => { if (k !== '_rid' && k !== '_new' && k !== '_changed') o[k] = r[k]; }); return o; }
  /** Fresh copies, like reading the sheet: changing them does not change the table. */
  read(name) { return this.live(name).map((r) => this.copy(r)); }
  rawFind(name, id) { const k = this.key(name); return this.rows[name].find((r) => r[k] !== '' && String(r[k]) === String(id)) || null; }
  find(name, id) { const r = this.rawFind(name, id); return r ? this.copy(r) : null; }

  append(name, objs) {
    (objs || []).forEach((obj) => {
      const r = { _rid: null, _new: true };
      SCHEMA[name].forEach((c) => { r[c] = normalize(obj[c], c, name); });
      this.rows[name].push(r);
    });
    if (objs && objs.length) this.dirty[name] = true;
  }

  update(name, id, patch) {
    const r = this.rawFind(name, id);
    if (!r) throw new Error(name + ' record ' + id + ' was not found. It may have been deleted.');
    Object.keys(patch).forEach((k) => { if (SCHEMA[name].indexOf(k) > -1) r[k] = normalize(patch[k], k, name); });
    r._changed = true;
    this.dirty[name] = true;
    return this.copy(r);
  }

  remove(name, id) {
    const r = this.rawFind(name, id);
    if (!r) return false;
    this.rows[name].splice(this.rows[name].indexOf(r), 1);
    if (r._rid) this.deleted[name].push(r._rid);
    this.dirty[name] = true;
    return true;
  }

  log(obj) {
    const r = {};
    SCHEMA.Activity.forEach((c) => { r[c] = normalize(obj[c], c, 'Activity'); });
    this.activity.push(r);
  }

  /* ----- small key/value store (sessions, sign-in limits, Telegram setup) ----- */
  kvGet(k) { const e = this.kv[k]; if (!e || (e.exp && e.exp < Date.now())) return null; return e.v; }
  kvSet(k, v, ttlSeconds) { this.kv[k] = { v: String(v), exp: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null }; this.kvChanged[k] = true; }
  kvDel(k) { delete this.kv[k]; this.kvChanged[k] = true; }
  kvKeys(prefix) { return Object.keys(this.kv).filter((k) => k.indexOf(prefix) === 0); }

  isDirty() { return Object.keys(this.dirty).length > 0 || this.activity.length > 0 || Object.keys(this.kvChanged).length > 0; }

  /** Save every change in one transaction. Throws ConflictError if another save got in first. */
  async commit() {
    if (!this.isDirty()) return false;
    const db = this.db, stmts = [];
    stmts.push(db.prepare("INSERT INTO _guard (x) SELECT 1 WHERE (SELECT v FROM _meta WHERE k = 'revision') <> ?").bind(this.revision));
    Object.keys(this.dirty).forEach((t) => {
      const cols = SCHEMA[t];
      const changed = this.rows[t].filter((r) => r._changed && r._rid);
      const gone = this.deleted[t].concat(changed.map((r) => r._rid));
      if (gone.length) stmts.push(db.prepare(`DELETE FROM ${q(t)} WHERE _rid IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(gone)));
      const ins = changed.concat(this.rows[t].filter((r) => r._new));
      insertStatements(db, t, ins.map((r) => [r._new ? null : r._rid].concat(cols.map((c) => toDb(r[c], c)))), true).forEach((s) => stmts.push(s));
    });
    if (this.activity.length) {
      insertStatements(db, 'Activity', this.activity.map((r) => SCHEMA.Activity.map((c) => toDb(r[c], c))), false).forEach((s) => stmts.push(s));
    }
    const kvKeys = Object.keys(this.kvChanged);
    if (kvKeys.length) {
      stmts.push(db.prepare('DELETE FROM _kv WHERE k IN (SELECT value FROM json_each(?)) OR (exp IS NOT NULL AND exp < ?)').bind(JSON.stringify(kvKeys), Date.now()));
      const keep = kvKeys.filter((k) => this.kv[k]).map((k) => [k, this.kv[k].v, this.kv[k].exp]);
      if (keep.length) stmts.push(db.prepare("INSERT INTO _kv (k, v, exp) SELECT json_extract(value, '$[0]'), json_extract(value, '$[1]'), json_extract(value, '$[2]') FROM json_each(?)").bind(JSON.stringify(keep)));
    }
    stmts.push(db.prepare("UPDATE _meta SET v = v + 1 WHERE k = 'revision'"));
    try {
      await db.batch(stmts);
    } catch (e) {
      if (/CHECK constraint failed/i.test(String(e && e.message))) throw new ConflictError();
      throw e;
    }
    this.revision += 1;
    return true;
  }
}

/** INSERT … SELECT FROM json_each(?) — many rows per statement, split so no parameter gets too big. */
export function insertStatements(db, table, rows, withRid) {
  if (!rows.length) return [];
  const cols = (withRid ? ['_rid'] : []).concat(SCHEMA[table]);
  const sql = `INSERT INTO ${q(table)} (${cols.map(q).join(', ')}) SELECT ${cols.map((c, i) => `json_extract(value, '$[${i}]')`).join(', ')} FROM json_each(?)`;
  const out = [];
  let chunk = [], size = 2;
  rows.forEach((r) => {
    const s = JSON.stringify(r);
    if (chunk.length && size + s.length > CHUNK_BYTES) { out.push(db.prepare(sql).bind('[' + chunk.join(',') + ']')); chunk = []; size = 2; }
    chunk.push(s); size += s.length + 1;
  });
  if (chunk.length) out.push(db.prepare(sql).bind('[' + chunk.join(',') + ']'));
  return out;
}

/** Everything, including the full activity log, for the Google Sheet copy. */
export async function fullExport(db) {
  await ensureSchema(db);
  const names = Object.keys(SCHEMA);
  const res = await db.batch(names.map((t) => db.prepare(`SELECT * FROM ${q(t)} ORDER BY _rid`)).concat([db.prepare("SELECT v FROM _meta WHERE k = 'revision'")]));
  const tables = {};
  names.forEach((t, i) => {
    tables[t] = (res[i].results || []).map((x) => { const o = {}; SCHEMA[t].forEach((c) => { o[c] = fromDb(x[c], c); }); return o; });
  });
  return { revision: Number((res[names.length].results[0] || {}).v || 0), tables };
}

/** One-time import: replace every table with the rows sent from the old sheet. */
export async function replaceAllTables(db, tables, kv) {
  await ensureSchema(db);
  const stmts = [];
  Object.keys(SCHEMA).forEach((t) => {
    if (!Array.isArray(tables[t])) return;
    stmts.push(db.prepare(`DELETE FROM ${q(t)}`));
    const key = SCHEMA[t][0];
    const rows = tables[t].filter((o) => t === 'Activity' || (o[key] !== '' && o[key] != null))
      .map((o) => SCHEMA[t].map((c) => toDb(normalize(o[c], c, t), c)));
    insertStatements(db, t, rows, false).forEach((s) => stmts.push(s));
  });
  Object.keys(kv || {}).forEach((k) => {
    if (kv[k] === '' || kv[k] == null) return;
    stmts.push(db.prepare('INSERT OR REPLACE INTO _kv (k, v, exp) VALUES (?, ?, NULL)').bind(k, String(kv[k])));
  });
  stmts.push(db.prepare("UPDATE _meta SET v = v + 1 WHERE k = 'revision'"));
  await db.batch(stmts);
}
