// Runs app/Code.gs + app/Cloudflare.gs with stand-ins for the Google services, against a local
// Worker started with:  EMPTY=1 node tests/serve.mjs 8798
// Checks the one-time move (data, photos, Telegram settings) and the sheet copy back.
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const BASE = process.argv[2] || 'http://localhost:8798';
const KEY = 'k'.repeat(40);
const TZ = 330 * 60000;

/* ----- Spreadsheet stand-in: cells hold numbers, text, booleans or Date objects ----- */
function cellIn(v) {
  if (typeof v === 'string' && v.charAt(0) === "'") return v.slice(1);   // forced text
  if (typeof v === 'string' && v !== '' && !isNaN(Number(v))) return Number(v); // Sheets turns "12" into 12
  return v;
}
class Range {
  constructor(sh, r, c, nr, nc) { Object.assign(this, { sh, r, c, nr: nr || 1, nc: nc || 1 }); }
  getValues() { const out = []; for (let i = 0; i < this.nr; i++) { const row = []; for (let j = 0; j < this.nc; j++) { const v = (this.sh.cells[this.r - 1 + i] || [])[this.c - 1 + j]; row.push(v === undefined || v === null ? '' : v); } out.push(row); } return out; }
  setValues(vals) { vals.forEach((row, i) => row.forEach((v, j) => this.sh.set(this.r + i, this.c + j, cellIn(v)))); return this; }
  setValue(v) { this.sh.set(this.r, this.c, cellIn(v)); return this; }
  clearContent() { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) this.sh.set(this.r + i, this.c + j, ''); return this; }
  setFontWeight() { return this; } setNumberFormat() { return this; }
}
class Sheet {
  constructor(name) { this.name = name; this.cells = []; this.maxRows = 1000; this.maxCols = 26; }
  set(r, c, v) { while (this.cells.length < r) this.cells.push([]); this.cells[r - 1][c - 1] = v; }
  getLastRow() { for (let i = this.cells.length; i > 0; i--) if ((this.cells[i - 1] || []).some((v) => v !== '' && v !== undefined && v !== null)) return i; return 0; }
  getLastColumn() { let m = 0; this.cells.forEach((row) => row.forEach((v, j) => { if (v !== '' && v !== undefined && v !== null) m = Math.max(m, j + 1); })); return m; }
  getRange(r, c, nr, nc) { return new Range(this, r, c, nr, nc); }
  getMaxRows() { return this.maxRows; } getMaxColumns() { return this.maxCols; }
  insertRowsAfter(a, n) { this.maxRows += n; } insertColumnsAfter(a, n) { this.maxCols += n; }
  setFrozenRows() {} deleteRow(r) { this.cells.splice(r - 1, 1); }
  getDataRange() { return this.getRange(1, 1, this.getLastRow(), this.getLastColumn()); }
}
const sheets = {};
const ss = {
  getSheetByName: (n) => sheets[n] || null,
  insertSheet: (n) => (sheets[n] = new Sheet(n)),
  getSpreadsheetTimeZone: () => 'Asia/Kolkata', getId: () => 'SHEET'
};

/* ----- Other Google services ----- */
const props = {};
const Properties = { getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); }, deleteProperty: (k) => { delete props[k]; }, setProperties: (o) => Object.assign(props, o), getProperties: () => ({ ...props }) };
const triggers = [];
const pad = (n) => String(n).padStart(2, '0');
const driveFiles = {
  DrivePhotoId_0000000001: { name: 'car.jpg', type: 'image/jpeg', bytes: Buffer.from('/9j/4AAQSkZJRgABAQ==', 'base64') },
  DrivePhotoId_0000000002: { name: 'id.jpg', type: 'image/jpeg', bytes: Buffer.from('/9j/4AAQSkZJRgABAg==', 'base64') },
  DriveAgreement_00000003: { name: 'agreement.pdf', type: 'application/pdf', bytes: Buffer.from('%PDF-1.4 old agreement') }
};
const blob = (bytes, type, name) => ({ getBytes: () => [...bytes], getContentType: () => type, getName: () => name, getAs: () => blob(bytes, type, name), setName() { return this; } });
const g = {
  console, JSON, Date, Math, Object, Array, String, Number, Boolean, RegExp, Error, isNaN, encodeURIComponent, decodeURIComponent,
  SpreadsheetApp: { openById: () => ss, flush() {} },
  PropertiesService: { getScriptProperties: () => Properties },
  LockService: { getScriptLock: () => ({ waitLock() {}, tryLock: () => true, releaseLock() {} }) },
  CacheService: { getScriptCache: () => ({ get: () => null, put() {}, remove() {}, getAll: () => ({}) }) },
  Session: { getActiveUser: () => ({ getEmail: () => '' }), getEffectiveUser: () => ({ getEmail: () => '' }), getScriptTimeZone: () => 'Asia/Kolkata' },
  ScriptApp: { getProjectTriggers: () => triggers.slice(), deleteTrigger: (t) => triggers.splice(triggers.indexOf(t), 1), newTrigger: (fn) => { const b = { timeBased: () => b, everyMinutes: (m) => { b.m = m; return b; }, create: () => { const t = { getHandlerFunction: () => fn, every: b.m }; triggers.push(t); return t; } }; return b; } },
  DriveApp: { getFileById: (id) => { const f = driveFiles[id]; if (!f) throw new Error('No file'); return { getBlob: () => blob(f.bytes, f.type, f.name), getName: () => f.name, getThumbnail: () => (f.type.startsWith('image/') ? blob(Buffer.from('iVBORw0KGgo=', 'base64'), 'image/png', 'th.png') : null), getId: () => id }; } },
  HtmlService: { createHtmlOutput: (h) => { const o = { html: h, setTitle: () => o, addMetaTag: () => o, setXFrameOptionsMode: () => o }; return o; }, XFrameOptionsMode: { ALLOWALL: 1 } },
  Utilities: {
    getUuid: () => crypto.randomUUID(),
    formatDate: (d, tz, pat) => { const x = new Date(d.getTime() + TZ); return pat.replace("yyyy-MM-dd'T'HH:mm", x.getUTCFullYear() + '-' + pad(x.getUTCMonth() + 1) + '-' + pad(x.getUTCDate()) + 'T' + pad(x.getUTCHours()) + ':' + pad(x.getUTCMinutes())); },
    parseDate: (s, tz, pat) => { const m = s.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/); return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - TZ); },
    base64Encode: (b) => Buffer.from(typeof b === 'string' ? b : b).toString('base64'),
    base64Decode: (s) => [...Buffer.from(s, 'base64')],
    computeDigest: (alg, s) => [...crypto.createHash('sha256').update(s).digest()],
    DigestAlgorithm: { SHA_256: 'sha256' },
    newBlob: (b, t, n) => blob(Buffer.from(b), t, n)
  },
  UrlFetchApp: {
    fetch: (url, o) => {
      o = o || {};
      const args = ['-s', '-o', '-', '-w', '\n%{http_code}', '-X', (o.method || 'get').toUpperCase(), url];
      Object.entries(o.headers || {}).forEach(([k, v]) => args.push('-H', k + ': ' + v));
      let input;
      if (o.payload !== undefined) {
        args.push('-H', 'content-type: ' + (o.contentType || 'application/octet-stream'), '--data-binary', '@-');
        input = Array.isArray(o.payload) ? Buffer.from(o.payload.map((b) => b & 255)) : Buffer.from(String(o.payload));
      }
      const out = execFileSync('curl', args, { input, maxBuffer: 64e6, env: { ...process.env, NO_PROXY: 'localhost', no_proxy: 'localhost' } }).toString();
      const i = out.lastIndexOf('\n');
      return { getResponseCode: () => Number(out.slice(i + 1)), getContentText: () => out.slice(0, i) };
    }
  }
};
vm.createContext(g);
vm.runInContext(fs.readFileSync(new URL('../app/Code.gs', import.meta.url), 'utf8') + '\n' + fs.readFileSync(new URL('../app/Cloudflare.gs', import.meta.url), 'utf8') + '\n;this.__ = { cfCopyFiles, cfSwitchOver, cfSyncSheet, cfSyncSheetNow, doGet, api, ensureSchema_, appendRows_, readTable_ };', g);
const GS = g.__;

/* ----- The old sheet, as the Apps Script app left it ----- */
GS.ensureSchema_();
const d = (s) => new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10), +(s.slice(11, 13) || 0), +(s.slice(14, 16) || 0)) - TZ);
GS.appendRows_('Partners', [{ Partner: 'SUHAIB', Role: 'Admin', Active: true, PIN: '1111', 'Telegram Chat ID': '5550001', 'Telegram Alerts': 'All' }, { Partner: 'ANEES', Role: 'Partner', Active: true, PIN: '2222' }]);
sheets.Partners.set(3, 5, 2222); // a PIN typed straight into the sheet becomes a number
GS.appendRows_('Vehicles', [{ 'Vehicle ID': 'V1abcd', Name: 'Swift White', 'Reg No': 'KL 10 AB 1234', 'Purchase Date': '2025-03-01', 'Purchase Price': 600000, Photo: 'DrivePhotoId_0000000001', Status: 'Active' }]);
GS.appendRows_('Customers', [{ 'Customer ID': 'c1', Name: 'Ajmal K', Mobile: '0098470 11223', 'ID Proof': 'DrivePhotoId_0000000002', Blocked: false, 'Created At': '2026-09-01T10:00' }]);
GS.appendRows_('Trips', [{ 'Trip ID': '00123456', 'Vehicle ID': 'V1abcd', 'Customer ID': 'c1', 'Customer Name': 'Ajmal K', Mobile: '0098470 11223', Status: 'Returned', 'Out At': '2026-09-01T10:00', 'In At': '2026-09-03T18:30', 'Rate Per Day': 1500, Days: 2, 'Bill Total': 3000, Paid: 3000, Balance: 0, 'ID Proof': 'DrivePhotoId_0000000002', 'Out Photos': 'DrivePhotoId_0000000001,DriveMissing_000000009', 'Agreement File': 'DriveAgreement_00000003' }]);
GS.appendRows_('Payments', [{ 'Payment ID': 'p1', Date: '2026-09-03T18:30', 'Trip ID': '00123456', 'Vehicle ID': 'V1abcd', 'Customer Name': 'Ajmal K', Type: 'Rent', Amount: 3000, Mode: 'Cash', 'Received By': 'SUHAIB' }]);
GS.appendRows_('Activity', [{ Time: '2026-09-03T18:30', User: 'SUHAIB', Action: 'Checked in', Details: 'Ajmal K · bill 3000' }]);
props.TG_TOKEN = '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'; props.TG_BOT = 'saf_rental_bot';
props.CF_URL = BASE; props.CF_SYNC_KEY = KEY;

let n = 0; const ok = (name) => console.log('  ✓ ' + name, ++n);
console.log('Apps Script move and sheet copy');

const before = JSON.parse(GS.api('partnerNames', {}, ''));
assert.equal(before.ok, true); ok('old app works before the move');

let msg = GS.cfCopyFiles();
assert.match(msg, /All files copied \(3 this run\)\. 1 could not be found/); ok('photos and the old agreement PDF copied from Drive; a missing file is reported');
assert.match(GS.cfCopyFiles(), /All files copied \(0 this run\)/); ok('running it again copies nothing twice');

msg = GS.cfSwitchOver();
assert.match(msg, /^Moved\./); ok('switch-over finished');
assert.equal(triggers.filter((t) => t.getHandlerFunction() === 'cfSyncSheet' && t.every === 5).length, 1); ok('sheet copy scheduled every 5 minutes');
assert.match(GS.doGet().html, /SAF Rental has moved/); ok('old link shows the moved page');
const blocked = JSON.parse(GS.api('save', { table: 'Expenses', record: {} }, 'x'));
assert.equal(blocked.code, 'MOVED'); ok('old app refuses to save after the move');

/* ----- The new app has the same data ----- */
const call = async (action, payload, token) => (await fetch(BASE + '/api', { method: 'POST', body: JSON.stringify({ action, payload, token }) })).json();
const login = await call('login', { partner: 'ANEES', pin: '2222' });
assert.equal(login.ok, true, login.error); ok('partners sign in with their old PINs (also a PIN typed into the sheet as a number)');
const T = (await call('login', { partner: 'SUHAIB', pin: '1111' })).data.token;
const b = (await call('bootstrap', {}, T)).data;
const t = b.tables.Trips[0];
assert.equal(t['Trip ID'], '00123456'); assert.equal(t['In At'], '2026-09-03T18:30'); assert.equal(t['Bill Total'], 3000);
assert.equal(b.tables.Customers[0].Mobile, '0098470 11223');
assert.equal(b.tables.Vehicles[0]['Purchase Date'], '2025-03-01T00:00');
assert.equal(b.tables.Partners.find((p) => p.Partner === 'SUHAIB').hasTelegram, true);
ok('trips, customers, dates and leading zeros came across unchanged');
const tg = (await call('tgStatus', {}, T)).data;
assert.equal(tg.botSet, true); assert.equal(tg.bot, 'saf_rental_bot'); ok('Telegram bot settings came across');
const ph = (await call('photos', { ids: ['DrivePhotoId_0000000001'] }, T)).data;
assert.equal((await fetch(BASE + ph[0].src)).status, 200); ok('old Drive photo opens in the new app');
const ag = await fetch(BASE + '/doc/DriveAgreement_00000003/agreement.pdf');
assert.equal(ag.status, 200); assert.equal(ag.headers.get('content-type'), 'application/pdf'); ok('old agreement PDF opens by link');

/* ----- New entries reach the sheet ----- */
const r1 = await call('checkOut', { vehicleId: 'V1abcd', customerName: 'Nithin Raj', mobile: '09446033445', outAt: '2026-10-24T09:15', rate: 1800, advance: 1000 }, T);
assert.equal(r1.ok, true, r1.error);
GS.cfSyncSheet();
const rows = GS.readTable_('Trips');
const nt = rows.find((x) => x['Trip ID'] === r1.data.tripId);
assert.ok(nt, 'new trip in the sheet'); assert.equal(nt['Out At'], '2026-10-24T09:15'); assert.equal(nt.Mobile, '09446033445'); assert.equal(nt.Paid, 1000);
assert.ok(sheets.Trips.cells[2][6] instanceof Date, 'dates are real dates in the sheet');
assert.equal(typeof sheets.Trips.cells[1][0], 'string', 'trip id 00123456 kept as text');
assert.equal(sheets.Trips.cells[1][0], '00123456');
ok('a new check-out reaches the sheet with real dates and text kept as text');
assert.ok(GS.readTable_('Activity').some((a) => a.Action === 'Checked out')); ok('activity log copied');
const p = GS.readTable_('Partners');
assert.equal(String(p.find((x) => x.Partner === 'SUHAIB')['Telegram Chat ID']), '5550001'); ok('partner details intact in the sheet');

const lastRev = props.CF_LAST_REVISION;
const tabsWritten = JSON.parse(props.CF_TAB_HASHES);
GS.cfSyncSheet();
assert.equal(props.CF_LAST_REVISION, lastRev); ok('nothing rewritten when nothing changed');
sheets.Trips.set(2, 4, 'TYPED BY MISTAKE');
GS.cfSyncSheetNow();
assert.equal(GS.readTable_('Trips')[0]['Customer Name'], 'Ajmal K'); ok('a full re-copy repairs the sheet');
assert.ok(Object.keys(tabsWritten).length >= 14);

console.log(n + ' checks passed');
