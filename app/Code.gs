/**
 * Rental Hub — server code (Google Apps Script, bound to the "Rental Hub Data" sheet).
 *
 * Deploy as a web app: Execute as "Me", Who has access "Anyone". Partners sign in with a PIN.
 * Works as a standalone Apps Script project or bound to the Rental Hub Data sheet.
 * The page lives in an HTML file named exactly "Index".
 *
 * Safety: this app only ever WRITES to its own spreadsheet. The import reads your old
 * AppSheet sheet (ID in the Settings tab) and never changes it.
 */

var APP_NAME = 'Rental Hub';

// One-tap updates: the app pulls new code from GitHub and moves its own deployment to it.
// APP_VERSION must match app/version.json in the repository.
var APP_VERSION = '2026-10-19.3';
var GITHUB_REPO = 'ktsuhaib-debug/saf-rental-app';
var GITHUB_BRANCH = 'main';
var DEPLOYMENT_ID = 'AKfycbw4DwELqYZng48CLSiZ1qFM-d8S0UcV-7T4cddyFusD3blRddg1inJ2GjO49JhZTLByxQ';

/* ------------------------------------------------------------------ */
/* Schema: every tab, its columns, and the type of each column.        */
/* ------------------------------------------------------------------ */
var SCHEMA = {
  Settings:    ['Key', 'Value', 'Notes'],
  Partners:    ['Partner', 'Email', 'Role', 'Active', 'PIN', 'Telegram Chat ID', 'Telegram Alerts', 'Telegram Own'],
  Vehicles:    ['Vehicle ID', 'Name', 'Reg No', 'Purchase Date', 'Purchase Price', 'Extra Costs', 'Photo', 'Status', 'Notes', 'Chassis No', 'Engine No', 'FASTag ID', 'Workshop Since', 'Workshop Until', 'Workshop Notes'],
  Investments: ['Investment ID', 'Date', 'Vehicle ID', 'Partner', 'Amount', 'Notes'],
  Customers:   ['Customer ID', 'Name', 'Mobile', 'ID Proof', 'Notes', 'Blocked', 'Created At'],
  Trips:       ['Trip ID', 'Vehicle ID', 'Customer ID', 'Customer Name', 'Mobile', 'Status',
                'Out At', 'Start Odometer', 'Fuel Out', 'ID Proof', 'Out Photos', 'Deposit', 'Deposit Held By',
                'Expected Return', 'Rate Per Day',
                'In At', 'End Odometer', 'Fuel In', 'In Photos', 'Days', 'Km Driven', 'Extra Km',
                'Extra Km Charge', 'Late Fee', 'Fuel Charge', 'Damage Charge', 'Discount',
                'Bill Total', 'Paid', 'Balance', 'Deposit Refunded', 'Deposit Deducted',
                'Notes', 'Created By', 'Updated At', 'FASTag Out', 'FASTag In', 'Toll Charge', 'Fine Charge', 'Fine Notes', 'Signature', 'Agreement File', 'Rating', 'Rating Note'],
  Payments:    ['Payment ID', 'Date', 'Trip ID', 'Vehicle ID', 'Customer Name', 'Type', 'Amount', 'Mode', 'Received By', 'Notes', 'Created By'],
  Expenses:    ['Expense ID', 'Date', 'Vehicle ID', 'Type', 'Description', 'Amount', 'Paid By', 'Mode', 'Trip ID', 'Created By'],
  Dividends:   ['Dividend ID', 'Date', 'Partner', 'Amount', 'Mode', 'Paid By', 'Notes'],
  Transfers:   ['Transfer ID', 'Date', 'From', 'To', 'Amount', 'Mode', 'Notes', 'Created By'],
  Documents:   ['Document ID', 'Vehicle ID', 'Item', 'Expiry Date', 'Due Odometer', 'Notes'],
  Sales:       ['Sale ID', 'Date', 'Vehicle ID', 'Buyer', 'Amount', 'Received By', 'Notes'],
  Enquiries:   ['Enquiry ID', 'Date', 'Name', 'Mobile', 'Vehicle ID', 'Wanted From', 'Wanted To', 'Source', 'Status', 'Follow Up', 'Notes', 'Trip ID', 'Created By', 'Updated At'],
  Activity:    ['Time', 'User', 'Action', 'Details']
};

var DATE_COLS = ['Purchase Date', 'Date', 'Created At', 'Out At', 'In At', 'Expected Return', 'Updated At', 'Expiry Date', 'Time', 'Workshop Since', 'Workshop Until', 'Wanted From', 'Wanted To', 'Follow Up'];
var NUM_COLS = ['Purchase Price', 'Extra Costs', 'Amount', 'Start Odometer', 'End Odometer', 'Deposit', 'Rate Per Day',
                'Days', 'Km Driven', 'Extra Km', 'Extra Km Charge', 'Late Fee', 'Fuel Charge', 'Damage Charge', 'Discount',
                'Bill Total', 'Paid', 'Balance', 'Deposit Refunded', 'Deposit Deducted', 'Due Odometer',
                'FASTag Out', 'FASTag In', 'Toll Charge', 'Fine Charge'];
var BOOL_COLS = ['Active', 'Blocked', 'Telegram Own'];

var DEFAULT_SETTINGS = [
  ['Business Name', 'Rental Hub', 'Shown in the app header'],
  ['Currency', 'INR', 'Currency code for amounts'],
  ['Reserve %', 10, 'Share of profit kept in the business before dividends'],
  ['Late Grace Hours', 2, 'Hours after a full day before another day is charged'],
  ['Km Per Day Limit', 0, '0 means unlimited km'],
  ['Extra Km Rate', 0, 'Charge per km above the daily limit'],
  ['Expiry Warning Days', 30, 'Warn this many days before a document expires'],
  ['Old Sheet ID', '1M7laEOmAkokMKihyQemKcgR0fDF_mw6pkAPzkA_9ORQ', 'AppSheet sheet to import from (read only)'],
  ['Photos Folder ID', '', 'Filled in automatically on first photo upload'],
  ['Business Phone', '', 'Printed on rental agreements'],
  ['Business Address', '', 'Printed on rental agreements']
];

/* ------------------------------------------------------------------ */
/* Web app entry                                                       */
/* ------------------------------------------------------------------ */
function doGet() {
  var out = HtmlService.createHtmlOutputFromFile('Index')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
  var name = APP_NAME, iconId = '';
  try { var st = settings_(); name = st['Business Name'] || APP_NAME; iconId = String(st['Logo File ID'] || '').replace(/^'/, ''); } catch (e) { /* first run */ }
  out.setTitle(name);
  // Lets the full-screen launcher (GitHub Pages) show the app inside its page.
  out.setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  if (iconId) { try { out.setFaviconUrl('https://drive.google.com/uc?export=view&id=' + iconId + '&format=.png'); } catch (e) { /* icon is optional */ } }
  return out;
}

/** Show every date column in the sheet as dd/mm/yyyy (with the time where it matters). */
function formatDateColumns_() {
  var withTime = ['Out At', 'In At', 'Expected Return', 'Updated At', 'Time', 'Created At'];
  Object.keys(SCHEMA).forEach(function (name) {
    var sh = ss_().getSheetByName(name); if (!sh) return;
    headers_(sh).forEach(function (h, i) {
      if (DATE_COLS.indexOf(h) === -1) return;
      sh.getRange(2, i + 1, Math.max(sh.getMaxRows() - 1, 1), 1).setNumberFormat(withTime.indexOf(h) > -1 ? 'dd/mm/yyyy hh:mm' : 'dd/mm/yyyy');
    });
  });
}

/** The SAF logo (64 px) used for the browser tab icon. */
var LOGO_PNG_B64 = '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';

/** Saves the logo to Drive once and lets anyone with the link view that one image, so browsers can show it as the tab icon. */
function ensureLogo_() {
  var st = settings_();
  if (st['Logo File ID']) { try { DriveApp.getFileById(String(st['Logo File ID']).replace(/^'/, '')); return; } catch (e) { /* recreate */ } }
  var file = photoFolder_().createFile(Utilities.newBlob(Utilities.base64Decode(LOGO_PNG_B64), 'image/png', 'app-icon.png'));
  try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) { /* sharing blocked by account policy */ }
  var sh = ss_().getSheetByName('Settings'), r = findRow_(sh, 'Logo File ID');
  if (r > 0) sh.getRange(r, 2).setValue("'" + file.getId());
  else appendRows_('Settings', [{ 'Key': 'Logo File ID', 'Value': file.getId(), 'Notes': 'Browser tab icon (created by setup)' }]);
}

/** Run once from the editor (select setup → Run) to create every tab. Safe to run again. */
function setup() {
  ensureSchema_();
  var me = Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail();
  var partners = readTable_('Partners');
  if (!partners.length && me) {
    appendRows_('Partners', [{ 'Partner': me.split('@')[0].toUpperCase(), 'Email': me, 'Role': 'Admin', 'Active': true }]);
  }
  photoFolder_();
  ensureLogo_();
  formatDateColumns_();
  var morning = '';
  try { installMorningTrigger_(); } catch (e) { morning = ' Morning summary not switched on yet: update appsscript.json (it needs the script.scriptapp permission) and run setup again.'; }
  var noPin = readTable_('Partners').filter(function (r) { return r['Active'] !== false && !String(r['PIN'] || '').trim(); }).map(function (r) { return r['Partner']; });
  return 'Setup complete.' + morning + (noPin.length ? ' Add a PIN in the Partners tab for: ' + noPin.join(', ') : ' Every partner has a PIN.');
}

/**
 * Single entry point used by the page. Always returns a JSON string.
 * The web app runs as the owner, so partners are identified by a sign-in token, not their Google account.
 */
function api(action, payload, token) {
  try {
    ensureSchema_();
    if (action === 'partnerNames') return JSON.stringify({ ok: true, data: partnerNames_() });
    if (action === 'login') return JSON.stringify({ ok: true, data: login_(payload || {}) });
    var user = userFromToken_(token);
    if (!user) return JSON.stringify({ ok: false, error: 'Please sign in.', code: 'LOGIN' });
    var fn = ACTIONS[action];
    if (!fn) throw new Error('Unknown action: ' + action);
    return JSON.stringify({ ok: true, data: fn(payload || {}, user, token) });
  } catch (err) {
    return JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err), code: err && err.code ? err.code : undefined });
  }
}

var ACTIONS = {
  whoami: function (p, user) { return user; },
  logout: function (p, user, token) { PropertiesService.getScriptProperties().deleteProperty('session_' + token); return true; },
  changePin: function (p, user) { return withLock_(function () { return changePin_(p, user); }); },
  bootstrap: function (p, user) { return bootstrap_(user); },
  checkOut: function (p, user) { return withLock_(function () { return checkOut_(p, user); }); },
  book: function (p, user) { return withLock_(function () { return book_(p, user); }); },
  cancelBooking: function (p, user) { return withLock_(function () { return cancelBooking_(p, user); }); },
  checkIn: function (p, user) { return withLock_(function () { return checkIn_(p, user); }); },
  addPayment: function (p, user) { return withLock_(function () { return addPayment_(p, user); }); },
  addCharge: function (p, user) { return withLock_(function () { return addCharge_(p, user); }); },
  workshop: function (p, user) { return withLock_(function () { return workshop_(p, user); }); },
  rate: function (p, user) { return withLock_(function () { return rate_(p, user); }); },
  makePdf: function (p, user) { return makePdf_(p, user); },
  save: function (p, user) { return withLock_(function () { return save_(p, user); }); },
  remove: function (p, user) { return withLock_(function () { return remove_(p, user); }); },
  photos: function (p) { return photos_(p.ids || [], p.full === true); },
  // The AppSheet import was used once to move the old data across. It is switched off so it can never overwrite live data.
  updateStatus: function (p, user) { requireAdmin_(user); return updateStatus_(); },
  saveGithubToken: function (p, user) { requireAdmin_(user); return saveGithubToken_(p.token); },
  checkUpdate: function (p, user) { requireAdmin_(user); return checkUpdate_(); },
  applyUpdate: function (p, user) { requireAdmin_(user); return applyUpdate_(user); },
  importOld: function () { throw new Error('The AppSheet import is no longer available. All AppSheet data is already in this app.'); }
};

/* ------------------------------------------------------------------ */
/* Users                                                               */
/* ------------------------------------------------------------------ */
var SESSION_DAYS = 30;

function partnerRow_(name) {
  return readTable_('Partners').filter(function (r) { return String(r['Partner']).toUpperCase() === String(name || '').toUpperCase(); })[0] || null;
}

function partnerNames_() {
  return readTable_('Partners').filter(function (r) { return r['Active'] !== false; }).map(function (r) { return r['Partner']; });
}

function login_(p) {
  var name = String(p.partner || '').toUpperCase(), pin = String(p.pin || '').trim();
  if (!name || !pin) throw new Error('Choose your name and enter your PIN.');
  var cache = CacheService.getScriptCache(), key = 'fails_' + name;
  var fails = Number(cache.get(key) || 0);
  if (fails >= 5) throw new Error('Too many wrong PINs. Try again in 15 minutes.');
  var row = partnerRow_(name);
  if (!row || row['Active'] === false) throw new Error('That partner is not active.');
  var saved = String(row['PIN'] || '').trim();
  if (!saved) throw new Error('No PIN is set for ' + row['Partner'] + ' yet. Ask the admin to add one in the Partners tab.');
  if (saved !== pin) {
    cache.put(key, String(fails + 1), 900);
    throw new Error('Wrong PIN.' + (fails + 1 >= 3 ? ' ' + (5 - fails - 1) + ' tries left.' : ''));
  }
  cache.remove(key);
  var token = Utilities.getUuid() + Utilities.getUuid().slice(0, 8);
  PropertiesService.getScriptProperties().setProperty('session_' + token, JSON.stringify({ partner: row['Partner'], exp: Date.now() + SESSION_DAYS * 864e5 }));
  cleanSessions_();
  return { token: token, partner: row['Partner'] };
}

function userFromToken_(token) {
  if (!token) return null;
  var raw = PropertiesService.getScriptProperties().getProperty('session_' + token);
  if (!raw) return null;
  var s = JSON.parse(raw);
  if (s.exp < Date.now()) { PropertiesService.getScriptProperties().deleteProperty('session_' + token); return null; }
  var row = partnerRow_(s.partner);
  if (!row || row['Active'] === false) return null;
  return { partner: row['Partner'], role: row['Role'] || 'Partner', email: row['Email'] || '' };
}

function cleanSessions_() {
  var props = PropertiesService.getScriptProperties(), all = props.getProperties(), now = Date.now();
  Object.keys(all).forEach(function (k) {
    if (k.indexOf('session_') !== 0) return;
    try { if (JSON.parse(all[k]).exp < now) props.deleteProperty(k); } catch (e) { props.deleteProperty(k); }
  });
}

function changePin_(p, user) {
  var row = partnerRow_(user.partner);
  if (String(row['PIN'] || '').trim() !== String(p.oldPin || '').trim()) throw new Error('Your current PIN is not right.');
  var pin = String(p.newPin || '').trim();
  if (!/^\d{4,8}$/.test(pin)) throw new Error('Use 4 to 8 digits for the new PIN.');
  updateRow_('Partners', row['Partner'], { 'PIN': pin });
  log_(user, 'Changed PIN', '');
  return true;
}

function adminName_() {
  var a = readTable_('Partners').filter(function (r) { return r['Role'] === 'Admin' && r['Active'] !== false; })[0];
  return a ? a['Partner'] : 'the admin';
}
function requireAdmin_(user, msg) {
  if (user.role === 'Admin') return;
  var name = String(adminName_()); name = name.charAt(0) + name.slice(1).toLowerCase();
  throw new Error((msg || 'Only the admin can do this.') + ' Ask ' + name + '.');
}

/* ------------------------------------------------------------------ */
/* Spreadsheet helpers                                                 */
/* ------------------------------------------------------------------ */
var SHEET_ID = '168091EfFRUugh-4g3zhJxMyEi7uyACgMPaJrw0WCXvw'; // Rental Hub Data
var _ss = null;
function ss_() {
  if (_ss) return _ss;
  _ss = SpreadsheetApp.openById(SHEET_ID);
  return _ss;
}

function tz_() { return ss_().getSpreadsheetTimeZone() || Session.getScriptTimeZone(); }

var _schemaChecked = false;
function ensureSchema_() {
  if (_schemaChecked) return;
  var ss = ss_();
  Object.keys(SCHEMA).forEach(function (name) {
    var sh = ss.getSheetByName(name);
    if (!sh) {
      sh = ss.insertSheet(name);
      sh.getRange(1, 1, 1, SCHEMA[name].length).setValues([SCHEMA[name]]).setFontWeight('bold');
      sh.setFrozenRows(1);
      if (name === 'Settings') sh.getRange(2, 1, DEFAULT_SETTINGS.length, 3).setValues(DEFAULT_SETTINGS);
    } else {
      // Add any missing columns at the end, never reorder or remove.
      var lastCol = Math.max(sh.getLastColumn(), 1);
      var headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
      var missing = SCHEMA[name].filter(function (h) { return headers.indexOf(h) === -1; });
      if (missing.length) {
        var at = headers.filter(String).length + 1, need = at + missing.length - 1 - sh.getMaxColumns();
        if (need > 0) sh.insertColumnsAfter(sh.getMaxColumns(), need);
        sh.getRange(1, at, 1, missing.length).setValues([missing]).setFontWeight('bold');
      }
    }
  });
  _schemaChecked = true;
}

function headers_(sh) {
  return sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getValues()[0].map(String);
}

function toOut_(v, col) {
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return '';
    return Utilities.formatDate(v, tz_(), "yyyy-MM-dd'T'HH:mm");
  }
  if (BOOL_COLS.indexOf(col) > -1) return v === true || String(v).toUpperCase() === 'TRUE';
  return v;
}

function readTable_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  var h = headers_(sh);
  var values = sh.getRange(2, 1, sh.getLastRow() - 1, h.length).getValues();
  var out = [];
  values.forEach(function (row) {
    if (row[0] === '' || row[0] === null) return;
    var o = {};
    h.forEach(function (col, i) { if (col) o[col] = toOut_(row[i], col); });
    out.push(o);
  });
  return out;
}

function toCell_(v, col) {
  if (v === undefined || v === null || v === '') return '';
  if (DATE_COLS.indexOf(col) > -1) {
    if (v instanceof Date) return v;
    var s = String(v);
    var m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
    if (m) return Utilities.parseDate(m[1] + '-' + m[2] + '-' + m[3] + ' ' + (m[4] || '00') + ':' + (m[5] || '00'), tz_(), 'yyyy-MM-dd HH:mm');
    return s;
  }
  if (NUM_COLS.indexOf(col) > -1) {
    var n = Number(v);
    return isNaN(n) ? '' : n;
  }
  if (BOOL_COLS.indexOf(col) > -1) return v === true || String(v).toUpperCase() === 'TRUE';
  // Text: a leading apostrophe stops Sheets turning IDs and phone numbers into numbers or dates.
  return "'" + String(v);
}

function rowFor_(h, obj) { return h.map(function (col) { return toCell_(obj[col], col); }); }

function appendRows_(name, objs) {
  if (!objs.length) return;
  var sh = ss_().getSheetByName(name);
  var h = headers_(sh);
  var need = sh.getLastRow() + objs.length - sh.getMaxRows();
  if (need > 0) sh.insertRowsAfter(sh.getMaxRows(), need + 500);
  sh.getRange(sh.getLastRow() + 1, 1, objs.length, h.length).setValues(objs.map(function (o) { return rowFor_(h, o); }));
}

function replaceAll_(name, objs) {
  var sh = ss_().getSheetByName(name);
  var h = headers_(sh);
  if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, h.length).clearContent();
  if (objs.length + 1 > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), objs.length + 501 - sh.getMaxRows());
  if (objs.length) sh.getRange(2, 1, objs.length, h.length).setValues(objs.map(function (o) { return rowFor_(h, o); }));
}

function findRow_(sh, id) {
  if (sh.getLastRow() < 2) return -1;
  var keys = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
  for (var i = 0; i < keys.length; i++) if (String(keys[i][0]) === String(id)) return i + 2;
  return -1;
}

function updateRow_(name, id, patch) {
  var sh = ss_().getSheetByName(name);
  var r = findRow_(sh, id);
  if (r < 0) throw new Error(name + ' record ' + id + ' was not found. It may have been deleted.');
  var h = headers_(sh);
  var current = {};
  sh.getRange(r, 1, 1, h.length).getValues()[0].forEach(function (v, i) { current[h[i]] = toOut_(v, h[i]); });
  Object.keys(patch).forEach(function (k) { if (h.indexOf(k) > -1) current[k] = patch[k]; });
  sh.getRange(r, 1, 1, h.length).setValues([rowFor_(h, current)]);
  return current;
}

function getRow_(name, id) {
  return readTable_(name).filter(function (r) { return String(r[SCHEMA[name][0]]) === String(id); })[0] || null;
}

function newId_() { return Utilities.getUuid().replace(/-/g, '').slice(0, 8); }
function nowIso_() { return Utilities.formatDate(new Date(), tz_(), "yyyy-MM-dd'T'HH:mm"); }
function num_(v) { var n = Number(v); return isNaN(n) ? 0 : n; }

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function log_(user, action, details) {
  appendRows_('Activity', [{ 'Time': nowIso_(), 'User': user.partner || user.email, 'Action': action, 'Details': details }]);
}

function settings_() {
  var o = {};
  readTable_('Settings').forEach(function (r) { o[r['Key']] = r['Value']; });
  return o;
}

/* ------------------------------------------------------------------ */
/* Photos                                                              */
/* ------------------------------------------------------------------ */
function photoFolder_() {
  var s = settings_();
  if (s['Photos Folder ID']) {
    try { return DriveApp.getFolderById(s['Photos Folder ID']); } catch (e) { /* fall through and recreate */ }
  }
  var file = DriveApp.getFileById(ss_().getId());
  var parents = file.getParents();
  var parent = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  var folder = parent.createFolder('Rental Hub Photos');
  var sh = ss_().getSheetByName('Settings');
  var r = findRow_(sh, 'Photos Folder ID');
  if (r > 0) sh.getRange(r, 2).setValue("'" + folder.getId());
  else appendRows_('Settings', [{ 'Key': 'Photos Folder ID', 'Value': folder.getId(), 'Notes': 'Created automatically' }]);
  return folder;
}

/** dataUrl → Drive file id. Accepts an existing file id unchanged. */
function savePhoto_(dataUrl, name) {
  if (!dataUrl) return '';
  if (String(dataUrl).indexOf('data:') !== 0) return String(dataUrl);
  var m = String(dataUrl).match(/^data:(image\/[a-z+]+);base64,(.*)$/);
  if (!m) throw new Error('A photo could not be read. Try taking it again.');
  var blob = Utilities.newBlob(Utilities.base64Decode(m[2]), m[1], name + '.jpg');
  return photoFolder_().createFile(blob).getId();
}

function savePhotos_(list, prefix) {
  return (list || []).map(function (d, i) { return savePhoto_(d, prefix + '-' + (i + 1)); }).filter(String).join(',');
}

/** Photos as data URLs. Default is a small preview (fast, cached for 6 hours); full: true sends the original. */
function photos_(ids, full) {
  var cache = CacheService.getScriptCache();
  var keys = ids.slice(0, 12).map(function (id) { return 'th_' + id; });
  var hit = full ? {} : cache.getAll(keys);
  return ids.slice(0, 12).map(function (id) {
    if (hit['th_' + id]) return { id: id, src: hit['th_' + id] };
    try {
      var file = DriveApp.getFileById(id), blob = null;
      if (!full) { try { blob = file.getThumbnail(); } catch (e) { blob = null; } }
      if (!blob) blob = file.getBlob();
      var src = 'data:' + (blob.getContentType() || 'image/jpeg') + ';base64,' + Utilities.base64Encode(blob.getBytes());
      if (!full && src.length < 95000) { try { cache.put('th_' + id, src, 21600); } catch (e) { /* too big to cache */ } }
      return { id: id, src: src };
    } catch (e) {
      return { id: id, src: '', error: 'Photo not found in Drive.' };
    }
  });
}

/* ------------------------------------------------------------------ */
/* Bootstrap: everything the page needs in one call                    */
/* ------------------------------------------------------------------ */
function bootstrap_(user) {
  var tables = {};
  Object.keys(SCHEMA).forEach(function (name) { if (name !== 'Activity') tables[name] = readTable_(name); });
  tables.Partners = tables.Partners.map(function (r) { var o = {}; Object.keys(r).forEach(function (k) { if (k !== 'PIN' && k !== 'Telegram Chat ID') o[k] = r[k]; }); o.hasPin = !!String(r['PIN'] || '').trim(); o.hasTelegram = !!String(r['Telegram Chat ID'] || '').replace(/^'/, ''); return o; });
  var act = readTable_('Activity');
  tables.Activity = act.slice(-60).reverse();
  return { user: user, tables: tables, serverTime: nowIso_(), appVersion: APP_VERSION };
}

/* ------------------------------------------------------------------ */
/* Trips                                                               */
/* ------------------------------------------------------------------ */
function checkOut_(p, user) {
  if (!p.vehicleId) throw new Error('Choose a vehicle.');
  if (!p.customerName) throw new Error('Enter the customer name.');
  var busy = readTable_('Trips').some(function (t) { return t['Vehicle ID'] === p.vehicleId && t['Status'] === 'Out'; });
  if (busy) throw new Error('This vehicle is already out on a trip. Check it in first.');
  if ((getRow_('Vehicles', p.vehicleId) || {})['Status'] === 'Workshop') throw new Error('This car is in the workshop. Mark it back from the workshop first.');

  var booking = p.bookingId ? getRow_('Trips', p.bookingId) : null;
  if (p.bookingId && (!booking || booking['Status'] !== 'Booked')) throw new Error('This booking was cancelled or already started.');
  if (p.expectedReturn) {
    var clash = clashes_(p.vehicleId, p.outAt || nowIso_(), p.expectedReturn, p.bookingId).filter(function (t) { return t['Status'] === 'Booked'; });
    if (clash.length) throw new Error('This car is booked by ' + clash[0]['Customer Name'] + ' from ' + String(clash[0]['Out At']).slice(0, 10) + '. Choose an earlier return date or another car.');
  }
  // The app sends its own id so it can make the rental agreement straight after check-out.
  var tripId = booking ? booking['Trip ID'] : (/^[A-Za-z0-9]{6,16}$/.test(String(p.tripId || '')) && !getRow_('Trips', p.tripId) ? String(p.tripId) : newId_());
  var customer = upsertCustomer_(p, tripId);
  if (customer['Blocked'] === true) throw new Error(customer['Name'] + ' is marked "do not rent".');

  var trip = {
    'Trip ID': tripId, 'Vehicle ID': p.vehicleId, 'Customer ID': customer['Customer ID'],
    'Customer Name': customer['Name'], 'Mobile': customer['Mobile'], 'Status': 'Out',
    'Out At': p.outAt || nowIso_(), 'Start Odometer': p.startOdo, 'Fuel Out': p.fuelOut,
    'ID Proof': customer['ID Proof'], 'Out Photos': savePhotos_(p.photos, tripId + '.out'),
    'Deposit': p.deposit, 'Deposit Held By': p.deposit ? (p.depositHeldBy || user.partner) : '',
    'Expected Return': p.expectedReturn, 'Rate Per Day': p.rate, 'FASTag Out': p.fastagOut, 'Signature': savePhoto_(p.signature, tripId + '.signature'),
    'Notes': [booking ? booking['Notes'] : '', p.notes].filter(String).join(' · '), 'Created By': booking ? booking['Created By'] : user.partner, 'Updated At': nowIso_()
  };
  if (booking) updateRow_('Trips', tripId, trip);
  else appendRows_('Trips', [trip]);

  if (num_(p.advance) > 0) {
    appendRows_('Payments', [{
      'Payment ID': newId_(), 'Date': trip['Out At'], 'Trip ID': tripId, 'Vehicle ID': p.vehicleId,
      'Customer Name': customer['Name'], 'Type': 'Advance', 'Amount': p.advance, 'Mode': p.advanceMode || 'Cash',
      'Received By': p.advanceReceivedBy || user.partner, 'Created By': user.partner
    }]);
    recalcTrip_(tripId);
  }
  linkEnquiry_(p.enquiryId, tripId);
  log_(user, 'Checked out', customer['Name'] + ' · ' + ((getRow_('Vehicles', p.vehicleId) || {})['Name'] || p.vehicleId));
  return { tripId: tripId };
}

/* ------------------------------------------------------------------ */
/* Bookings: a trip row with Status "Booked" until the car is handed over */
/* ------------------------------------------------------------------ */
function msOf_(iso) {
  var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)).getTime() : NaN;
}

/** Trips and bookings for this car that overlap [from, to). An open trip with no return date blocks everything after it starts. */
function clashes_(vehicleId, fromIso, toIso, ignoreId) {
  var a = msOf_(fromIso), b = msOf_(toIso);
  return readTable_('Trips').filter(function (t) {
    if (t['Vehicle ID'] !== vehicleId || String(t['Trip ID']) === String(ignoreId || '')) return false;
    if (t['Status'] !== 'Booked' && t['Status'] !== 'Out') return false;
    var s = msOf_(t['Out At']), e = msOf_(t['Expected Return']);
    if (isNaN(e)) e = t['Status'] === 'Out' ? Infinity : s + 864e5;
    return s < b && a < e;
  });
}

function book_(p, user) {
  if (!p.vehicleId) throw new Error('Choose a car.');
  if (!p.customerName) throw new Error('Enter the customer name.');
  if (!p.from || !p.to) throw new Error('Enter the pickup and return dates.');
  if (msOf_(p.to) <= msOf_(p.from)) throw new Error('The return date must be after the pickup date.');
  var clash = clashes_(p.vehicleId, p.from, p.to, p.tripId);
  if (clash.length) {
    var c = clash[0];
    throw new Error('This car is not free then: ' + c['Customer Name'] + (c['Status'] === 'Out' ? ' has it now' : ' booked it') + ' from ' + String(c['Out At']).slice(0, 10) + (c['Expected Return'] ? ' to ' + String(c['Expected Return']).slice(0, 10) : '') + '.');
  }
  if (p.tripId) {
    requireAdmin_(user, 'Only the admin can change a booking.');
    var old = getRow_('Trips', p.tripId);
    if (!old || old['Status'] !== 'Booked') throw new Error('Only bookings that have not started can be changed here.');
    updateRow_('Trips', p.tripId, { 'Vehicle ID': p.vehicleId, 'Customer Name': p.customerName, 'Mobile': p.mobile, 'Out At': p.from, 'Expected Return': p.to, 'Rate Per Day': p.rate, 'Notes': p.notes, 'Updated At': nowIso_() });
    log_(user, 'Changed booking', p.customerName + ' · ' + String(p.from).slice(0, 10));
    return { tripId: p.tripId };
  }
  var tripId = newId_();
  var customer = upsertCustomer_(p, tripId);
  if (customer['Blocked'] === true) throw new Error(customer['Name'] + ' is marked "do not rent".');
  appendRows_('Trips', [{
    'Trip ID': tripId, 'Vehicle ID': p.vehicleId, 'Customer ID': customer['Customer ID'], 'Customer Name': customer['Name'],
    'Mobile': customer['Mobile'], 'Status': 'Booked', 'Out At': p.from, 'Expected Return': p.to, 'Rate Per Day': p.rate,
    'ID Proof': customer['ID Proof'], 'Bill Total': '', 'Notes': p.notes, 'Created By': user.partner, 'Updated At': nowIso_()
  }]);
  if (num_(p.advance) > 0) {
    appendRows_('Payments', [{
      'Payment ID': newId_(), 'Date': nowIso_(), 'Trip ID': tripId, 'Vehicle ID': p.vehicleId, 'Customer Name': customer['Name'],
      'Type': 'Advance', 'Amount': p.advance, 'Mode': p.advanceMode || 'Cash', 'Received By': p.advanceReceivedBy || user.partner,
      'Notes': 'Booking advance', 'Created By': user.partner
    }]);
    recalcTrip_(tripId);
  }
  linkEnquiry_(p.enquiryId, tripId);
  log_(user, 'New booking', customer['Name'] + ' · ' + ((getRow_('Vehicles', p.vehicleId) || {})['Name'] || '') + ' · ' + String(p.from).slice(0, 10));
  return { tripId: tripId };
}

function cancelBooking_(p, user) {
  requireAdmin_(user, 'Only the admin can cancel a booking.');
  var t = getRow_('Trips', p.tripId);
  if (!t || t['Status'] !== 'Booked') throw new Error('Only bookings that have not started can be cancelled.');
  var refund = num_(p.refund);
  if (refund > num_(t['Paid'])) throw new Error('The refund is more than the ' + t['Paid'] + ' advance paid.');
  if (refund > 0) {
    appendRows_('Payments', [{
      'Payment ID': newId_(), 'Date': nowIso_(), 'Trip ID': t['Trip ID'], 'Vehicle ID': t['Vehicle ID'], 'Customer Name': t['Customer Name'],
      'Type': 'Refund', 'Amount': -refund, 'Mode': p.mode || 'Cash', 'Received By': p.refundBy || user.partner, 'Notes': 'Advance returned on cancellation', 'Created By': user.partner
    }]);
  }
  updateRow_('Trips', t['Trip ID'], { 'Status': 'Cancelled', 'Notes': [t['Notes'], 'Cancelled: ' + (p.reason || 'no reason given')].filter(String).join(' · '), 'Updated At': nowIso_() });
  recalcTrip_(t['Trip ID']);
  log_(user, 'Cancelled booking', t['Customer Name'] + (refund ? ' · refunded ' + refund : ''));
  return true;
}

function upsertCustomer_(p, tripId) {
  var idProof = p.idProof ? savePhoto_(p.idProof, tripId + '.id-proof') : '';
  if (p.customerId) {
    var existing = getRow_('Customers', p.customerId);
    if (existing) {
      var patch = {};
      if (idProof) patch['ID Proof'] = idProof;
      if (p.mobile && p.mobile !== existing['Mobile']) patch['Mobile'] = p.mobile;
      return Object.keys(patch).length ? updateRow_('Customers', p.customerId, patch) : existing;
    }
  }
  var c = {
    'Customer ID': newId_(), 'Name': p.customerName, 'Mobile': p.mobile, 'ID Proof': idProof,
    'Notes': '', 'Blocked': false, 'Created At': nowIso_()
  };
  appendRows_('Customers', [c]);
  return c;
}

function checkIn_(p, user) {
  var trip = getRow_('Trips', p.tripId);
  if (!trip) throw new Error('Trip not found.');
  if (trip['Status'] !== 'Out') throw new Error('This trip is already checked in.');
  var end = num_(p.endOdo), start = num_(trip['Start Odometer']);
  if (p.endOdo !== '' && p.endOdo !== undefined && end < start) throw new Error('End odometer is lower than the start reading (' + start + ').');

  var bill = num_(p.days) * num_(p.rate) + num_(p.extraKmCharge) + num_(p.lateFee) + num_(p.fuelCharge) + num_(p.damageCharge) + num_(p.tollCharge) + num_(p.fineCharge) - num_(p.discount);
  updateRow_('Trips', p.tripId, {
    'Status': 'Returned', 'In At': p.inAt || nowIso_(), 'End Odometer': p.endOdo, 'Fuel In': p.fuelIn,
    'In Photos': savePhotos_(p.photos, p.tripId + '.in'), 'Days': p.days, 'Rate Per Day': p.rate,
    'Km Driven': p.endOdo ? end - start : '', 'Extra Km': p.extraKm, 'Extra Km Charge': p.extraKmCharge,
    'Late Fee': p.lateFee, 'Fuel Charge': p.fuelCharge, 'Damage Charge': p.damageCharge, 'Discount': p.discount,
    'Bill Total': bill, 'Deposit Refunded': p.depositRefunded, 'Deposit Deducted': p.depositDeducted,
    'FASTag In': p.fastagIn, 'Toll Charge': p.tollCharge, 'Fine Charge': p.fineCharge, 'Fine Notes': p.fineNotes,
    'Rating': RATINGS.indexOf(p.rating) > -1 ? p.rating : '', 'Rating Note': p.ratingNote || '',
    'Notes': p.notes || trip['Notes'], 'Updated At': nowIso_()
  });

  var pays = [];
  if (num_(p.paidNow) > 0) pays.push({ type: 'Rent', amount: p.paidNow, mode: p.mode, by: p.receivedBy || user.partner });
  if (num_(p.depositDeducted) > 0) pays.push({ type: 'From Deposit', amount: p.depositDeducted, mode: 'Deposit', by: trip['Deposit Held By'] });
  appendRows_('Payments', pays.map(function (x) {
    return {
      'Payment ID': newId_(), 'Date': p.inAt || nowIso_(), 'Trip ID': p.tripId, 'Vehicle ID': trip['Vehicle ID'],
      'Customer Name': trip['Customer Name'], 'Type': x.type, 'Amount': x.amount, 'Mode': x.mode,
      'Received By': x.by, 'Created By': user.partner
    };
  }));
  recalcTrip_(p.tripId);
  log_(user, 'Checked in', trip['Customer Name'] + ' · bill ' + bill);
  return { tripId: p.tripId };
}

function addPayment_(p, user) {
  var trip = p.tripId ? getRow_('Trips', p.tripId) : null;
  if (!(num_(p.amount) > 0)) throw new Error('Enter an amount above zero.');
  appendRows_('Payments', [{
    'Payment ID': newId_(), 'Date': p.date || nowIso_(), 'Trip ID': p.tripId || '',
    'Vehicle ID': trip ? trip['Vehicle ID'] : p.vehicleId, 'Customer Name': trip ? trip['Customer Name'] : p.customerName,
    'Type': p.type || (trip ? 'Balance' : 'Other'), 'Amount': p.amount, 'Mode': p.mode || 'Cash',
    'Received By': p.receivedBy || user.partner, 'Notes': p.notes, 'Created By': user.partner
  }]);
  if (trip) recalcTrip_(p.tripId);
  log_(user, 'Payment', (trip ? trip['Customer Name'] : (p.customerName || 'Other')) + ' · ' + p.amount);
  return true;
}

/** Add a fine or toll that turned up after the trip; it goes onto the bill. Any partner may add one. */
function addCharge_(p, user) {
  var t = getRow_('Trips', p.tripId);
  if (!t) throw new Error('Trip not found.');
  if (t['Status'] !== 'Returned') throw new Error('Add fines and tolls at check-in while the trip is open.');
  var amt = num_(p.amount);
  if (!(amt > 0)) throw new Error('Enter an amount above zero.');
  var field = p.kind === 'Toll' ? 'Toll Charge' : 'Fine Charge';
  var patch = { 'Bill Total': num_(t['Bill Total']) + amt, 'Updated At': nowIso_() };
  patch[field] = num_(t[field]) + amt;
  if (p.kind !== 'Toll') patch['Fine Notes'] = [t['Fine Notes'], (p.note || 'Fine') + ' ' + amt].filter(String).join(' · ');
  updateRow_('Trips', t['Trip ID'], patch);
  recalcTrip_(t['Trip ID']);
  log_(user, p.kind === 'Toll' ? 'Added toll' : 'Added fine', t['Customer Name'] + ' · ' + amt + (p.note ? ' · ' + p.note : ''));
  return true;
}

/* ------------------------------------------------------------------ */
/* App updates from GitHub (admin only)                                */
/* ------------------------------------------------------------------ */
function updErr_(code, msg) { var e = new Error(msg); e.code = code; throw e; }

function updateStatus_() {
  return { current: APP_VERSION, hasToken: !!PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN') };
}

/** The token lives in Script Properties, never in the code (the code itself is on GitHub). */
function saveGithubToken_(token) {
  token = String(token || '').trim();
  if (!/^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/.test(token)) updErr_('UPD_TOKEN', 'That does not look like a GitHub token. It starts with github_pat_.');
  PropertiesService.getScriptProperties().setProperty('GITHUB_TOKEN', token);
  try { ghFile_('version.json'); } catch (e) {
    PropertiesService.getScriptProperties().deleteProperty('GITHUB_TOKEN');
    throw e;
  }
  return updateStatus_();
}

/** One file from the app/ folder of the private repository. */
function ghFile_(name) {
  // A public repository needs no token. A private one needs a read-only token in Script Properties.
  // Without a token, read the public file directly (GitHub's API limits anonymous calls from Google's shared servers).
  var token = PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN');
  var url = token
    ? 'https://api.github.com/repos/' + GITHUB_REPO + '/contents/app/' + encodeURIComponent(name) + '?ref=' + GITHUB_BRANCH + '&t=' + Date.now()
    : 'https://raw.githubusercontent.com/' + GITHUB_REPO + '/' + GITHUB_BRANCH + '/app/' + encodeURIComponent(name) + '?t=' + Date.now();
  var opt = { muteHttpExceptions: true };
  if (token) opt.headers = { Authorization: 'Bearer ' + token, Accept: 'application/vnd.github.raw', 'X-GitHub-Api-Version': '2022-11-28' };
  var r;
  try {
    r = UrlFetchApp.fetch(url, opt);
  } catch (e) { updErr_('UPD_GITHUB', 'GitHub could not be reached. Check the internet and try again.'); }
  var c = r.getResponseCode();
  if (c === 401) updErr_('UPD_TOKEN', 'GitHub refused the token. It may have expired: make a new one and save it again.');
  if (c === 429 || (c === 403 && /rate limit/i.test(r.getContentText()))) updErr_('UPD_GITHUB', 'GitHub is busy right now. Try again in a few minutes.');
  if ((c === 403 || c === 404) && !token) updErr_('UPD_TOKEN', 'GitHub would not share ' + name + '. If the repository is private, add a read-only GitHub token in the App updates card.');
  if (c === 403 || c === 404) updErr_('UPD_TOKEN', 'The token cannot read ' + name + ' in ' + GITHUB_REPO + '. Check it has Contents: Read-only for this repository.');
  if (c !== 200) updErr_('UPD_GITHUB', 'GitHub answered with code ' + c + '. Try again in a minute.');
  return r.getContentText();
}

function cmpVer_(a, b) {
  var x = String(a).split(/[-.]/).map(Number), y = String(b).split(/[-.]/).map(Number);
  for (var i = 0; i < Math.max(x.length, y.length); i++) { var d = (x[i] || 0) - (y[i] || 0); if (d) return d; }
  return 0;
}

function checkUpdate_() {
  var v;
  try { v = JSON.parse(ghFile_('version.json')); } catch (e) { if (e.code) throw e; updErr_('UPD_FILES', 'version.json on GitHub is not valid.'); }
  return { current: APP_VERSION, latest: String(v.version), notes: String(v.notes || ''), newer: cmpVer_(v.version, APP_VERSION) > 0, hasToken: !!PropertiesService.getScriptProperties().getProperty('GITHUB_TOKEN') };
}

function applyUpdate_(user) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var v = JSON.parse(ghFile_('version.json'));
    var names = (v.files && v.files.length ? v.files : ['Code.gs', 'Index.html']).map(String);
    var got = names.map(function (n) { return { name: n, source: ghFile_(n) }; });
    // Refuse anything that is not a complete copy of this app.
    got.forEach(function (f) {
      if (/\.gs$/.test(f.name) && f.name === 'Code.gs' && (f.source.indexOf('function doGet') < 0 || f.source.indexOf("APP_VERSION = '" + v.version + "'") < 0))
        updErr_('UPD_FILES', 'Code.gs on GitHub is incomplete or does not match version ' + v.version + '. Nothing was changed.');
      if (/\.html$/.test(f.name) && f.source.indexOf('</html>') < 0)
        updErr_('UPD_FILES', f.name + ' on GitHub is incomplete. Nothing was changed.');
    });
    var id = ScriptApp.getScriptId(), base = 'https://script.googleapis.com/v1/projects/' + id;
    var files = gapi_('get', base + '/content').files.map(function (f) { return { name: f.name, type: f.type, source: f.source }; });
    got.forEach(function (g) {
      var type = /\.html$/.test(g.name) ? 'HTML' : 'SERVER_JS', name = g.name.replace(/\.(gs|html)$/, '');
      var f = files.filter(function (x) { return x.name === name && x.type === type; })[0];
      if (f) f.source = g.source; else files.push({ name: name, type: type, source: g.source });
    });
    gapi_('put', base + '/content', { files: files });
    var ver = gapi_('post', base + '/versions', { description: 'v' + v.version + (v.notes ? ' · ' + String(v.notes).slice(0, 80) : '') });
    gapi_('put', base + '/deployments/' + DEPLOYMENT_ID, {
      deploymentConfig: { scriptId: id, versionNumber: ver.versionNumber, manifestFileName: 'appsscript', description: 'v' + v.version }
    }, true);
    log_(user, 'Updated the app', 'v' + v.version);
    return { version: String(v.version) };
  } finally { lock.releaseLock(); }
}

/** Apps Script API call. Errors before the last step leave the live app on its old version. */
function gapi_(method, url, body, isDeploy) {
  var opt = { method: method, headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() }, muteHttpExceptions: true };
  if (body) { opt.contentType = 'application/json'; opt.payload = JSON.stringify(body); }
  var r = UrlFetchApp.fetch(url, opt), c = r.getResponseCode(), t = r.getContentText();
  if (c >= 300) {
    console.error(method, url, c, t);
    var still = isDeploy ? '' : ' The app is still on the old version.';
    if (/SERVICE_DISABLED|has not been used|not enabled|is disabled/i.test(t)) updErr_('UPD_API', 'The Google Apps Script API is off. Turn it on at script.google.com/home/usersettings and try again.' + still);
    if (c === 401 || c === 403) updErr_('UPD_SCOPE', 'The app is missing a permission. Replace appsscript.json, run setup once and click Allow.' + still);
    updErr_('UPD_OTHER', 'Google answered with code ' + c + '.' + still);
  }
  return t ? JSON.parse(t) : {};
}

/* ------------------------------------------------------------------ */
/* Customer ratings                                                    */
/* ------------------------------------------------------------------ */
var RATINGS = ['Good', 'OK', 'Bad'];
function rate_(p, user) {
  var trip = getRow_('Trips', p.tripId);
  if (!trip) throw new Error('Trip not found.');
  if (RATINGS.indexOf(p.rating) === -1 && p.rating !== '') throw new Error('Choose Good, OK or Bad.');
  updateRow_('Trips', p.tripId, { 'Rating': p.rating, 'Rating Note': p.note || '' });
  log_(user, 'Rated customer', trip['Customer Name'] + ' · ' + (p.rating || 'cleared'));
  return true;
}

/* ------------------------------------------------------------------ */
/* PDFs: rental agreements and monthly statements                      */
/* The app writes the page; the server turns it into a PDF in Drive.   */
/* ------------------------------------------------------------------ */
function docsFolder_() {
  var s = settings_();
  if (s['Documents Folder ID']) {
    try { return DriveApp.getFolderById(s['Documents Folder ID']); } catch (e) { /* recreate below */ }
  }
  var parents = DriveApp.getFileById(ss_().getId()).getParents();
  var parent = parents.hasNext() ? parents.next() : DriveApp.getRootFolder();
  var folder = parent.createFolder('SAF Rental – agreements and statements');
  var sh = ss_().getSheetByName('Settings'), r = findRow_(sh, 'Documents Folder ID');
  if (r > 0) sh.getRange(r, 2).setValue("'" + folder.getId());
  else appendRows_('Settings', [{ 'Key': 'Documents Folder ID', 'Value': folder.getId(), 'Notes': 'Created automatically' }]);
  return folder;
}

function makePdf_(p, user) {
  var kind = p.kind === 'statement' ? 'statement' : 'agreement';
  var html = String(p.html || '');
  if (!html || html.length > 2000000) throw new Error('The document could not be made.');
  var name = String(p.name || kind).replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 120);
  var trip = null;
  if (kind === 'agreement') {
    trip = getRow_('Trips', p.tripId);
    if (!trip) throw new Error('Trip not found.');
    var sig = '';
    if (trip['Signature']) {
      try { var b = DriveApp.getFileById(trip['Signature']).getBlob(); sig = '<img src="data:' + (b.getContentType() || 'image/png') + ';base64,' + Utilities.base64Encode(b.getBytes()) + '" style="height:70px">'; } catch (e) { sig = ''; }
    }
    html = html.split('{{SIGNATURE}}').join(sig);
  }
  var pdf = Utilities.newBlob(html, 'text/html', name + '.html').getAs('application/pdf').setName(name + '.pdf');
  var file = docsFolder_().createFile(pdf);
  try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) { /* sharing blocked by the account; the owner can still open it */ }
  if (trip) {
    if (trip['Agreement File']) { try { DriveApp.getFileById(trip['Agreement File']).setTrashed(true); } catch (e) { /* already gone */ } }
    updateRow_('Trips', trip['Trip ID'], { 'Agreement File': file.getId() });
  }
  log_(user, kind === 'agreement' ? 'Made rental agreement' : 'Made monthly statement', name);
  var bytes = pdf.getBytes();
  return { id: file.getId(), name: name + '.pdf', url: 'https://drive.google.com/file/d/' + file.getId() + '/view', b64: bytes.length < 1500000 ? Utilities.base64Encode(bytes) : '' };
}

/** Mark an enquiry as turned into a booking or trip. */
function linkEnquiry_(enquiryId, tripId) {
  if (!enquiryId || !getRow_('Enquiries', enquiryId)) return;
  updateRow_('Enquiries', enquiryId, { 'Status': 'Booked', 'Trip ID': tripId, 'Updated At': nowIso_() });
}

/* ------------------------------------------------------------------ */
/* Workshop: a car that is off the road for repair or service          */
/* ------------------------------------------------------------------ */
function workshop_(p, user) {
  var v = getRow_('Vehicles', p.vehicleId);
  if (!v) throw new Error('Choose a car.');
  if (p.on) {
    if (v['Status'] === 'Sold') throw new Error('This car is sold.');
    var out = readTable_('Trips').some(function (t) { return t['Vehicle ID'] === p.vehicleId && t['Status'] === 'Out'; });
    if (out) throw new Error('This car is out on a trip. Check it in first.');
    updateRow_('Vehicles', p.vehicleId, { 'Status': 'Workshop', 'Workshop Since': p.since || nowIso_().slice(0, 10), 'Workshop Until': p.until || '', 'Workshop Notes': p.notes || '' });
    log_(user, 'Sent to workshop', v['Name'] + (p.notes ? ' · ' + p.notes : ''));
    return true;
  }
  if (v['Status'] !== 'Workshop') throw new Error('This car is not in the workshop.');
  var what = [v['Workshop Notes'], p.notes].filter(String).join(' · ');
  updateRow_('Vehicles', p.vehicleId, { 'Status': 'Active', 'Workshop Since': '', 'Workshop Until': '', 'Workshop Notes': '' });
  if (num_(p.cost) > 0) {
    appendRows_('Expenses', [{ 'Expense ID': newId_(), 'Date': p.date || nowIso_().slice(0, 10), 'Vehicle ID': p.vehicleId, 'Type': p.costType || 'Service',
      'Description': 'Workshop' + (what ? ': ' + what : ''), 'Amount': p.cost, 'Paid By': p.paidBy || user.partner, 'Mode': p.mode || 'Cash', 'Created By': user.partner }]);
  }
  log_(user, 'Back from workshop', v['Name'] + (num_(p.cost) > 0 ? ' · ' + p.cost : ''));
  return true;
}

function recalcTrip_(tripId) {
  var trip = getRow_('Trips', tripId);
  if (!trip) return;
  var paid = readTable_('Payments')
    .filter(function (x) { return String(x['Trip ID']) === String(tripId); })
    .reduce(function (s, x) { return s + num_(x['Amount']); }, 0);
  var patch = { 'Paid': paid };
  if (trip['Status'] === 'Cancelled') { patch['Bill Total'] = paid; patch['Balance'] = 0; }
  else if (trip['Bill Total'] !== '') patch['Balance'] = num_(trip['Bill Total']) - paid;
  updateRow_('Trips', tripId, patch);
}

/* ------------------------------------------------------------------ */
/* Generic save / remove                                               */
/* ------------------------------------------------------------------ */
var LABELS = { Enquiries: 'enquiry', Expenses: 'expense', Payments: 'income', Dividends: 'dividend', Transfers: 'cash handover', Documents: 'document', Customers: 'customer', Vehicles: 'car', Investments: 'investment', Sales: 'car sale', Trips: 'trip', Partners: 'partner', Settings: 'setting' };
var EDITABLE = ['Enquiries', 'Expenses', 'Dividends', 'Transfers', 'Documents', 'Customers', 'Vehicles', 'Investments', 'Sales', 'Payments', 'Trips'];
var ADMIN_ONLY = ['Partners', 'Settings', 'Vehicles', 'Documents', 'Investments', 'Dividends', 'Sales', 'Customers', 'Trips'];
// Partners may ADD rows to these lists; once saved, only the admin can change or delete them.
var PARTNER_CAN_ADD = ['Expenses', 'Payments', 'Transfers', 'Dividends'];
// Enquiries are day-to-day work: partners can add and update them.
var PARTNER_CAN_EDIT = ['Enquiries'];
var REMOVABLE = ['Enquiries', 'Expenses', 'Dividends', 'Transfers', 'Documents', 'Sales', 'Payments', 'Investments'];

function save_(p, user) {
  var table = p.table, rec = p.record || {};
  if (EDITABLE.indexOf(table) === -1 && ADMIN_ONLY.indexOf(table) === -1) throw new Error('This list cannot be edited here.');
  var key = SCHEMA[table][0];
  if (user.role !== 'Admin') {
    if (PARTNER_CAN_ADD.indexOf(table) === -1 && PARTNER_CAN_EDIT.indexOf(table) === -1) requireAdmin_(user, 'Only the admin can add or change ' + LABELS[table] + 's.');
    if (PARTNER_CAN_EDIT.indexOf(table) === -1 && rec[key] && getRow_(table, rec[key])) requireAdmin_(user, 'Saved entries are locked. Only the admin can change them.');
  }
  if (table === 'Enquiries') {
    if (!String(rec['Name'] || '').trim() && !(rec[key] && getRow_(table, rec[key]))) throw new Error('Enter the customer name.');
    rec['Updated At'] = nowIso_();
    if (!rec[key]) { rec['Date'] = rec['Date'] || nowIso_(); rec['Status'] = rec['Status'] || 'New'; }
  }

  if (table === 'Vehicles' && rec._photo) rec['Photo'] = savePhoto_(rec._photo, 'vehicle-' + (rec['Name'] || 'photo'));
  if (table === 'Customers' && rec._idProof) rec['ID Proof'] = savePhoto_(rec._idProof, 'customer-' + (rec['Name'] || ''));
  delete rec._photo; delete rec._idProof;
  if (table === 'Partners') {
    if (rec['PIN'] === '' || rec['PIN'] == null) delete rec['PIN'];
    else if (!/^\d{4,8}$/.test(String(rec['PIN']))) throw new Error('Use 4 to 8 digits for the PIN.');
    if (String(rec['Partner']).toUpperCase() === String(user.partner).toUpperCase() && (rec['Active'] === false || rec['Role'] === 'Partner')) throw new Error('You cannot remove your own admin access.');
  }
  delete rec.hasPin;
  var rebill = rec._rebill === true; delete rec._rebill;
  var saved;
  var existing = rec[key] ? getRow_(table, rec[key]) : null;
  if (table === 'Trips' && rebill && existing) {
    var m = {}; Object.keys(existing).forEach(function (k) { m[k] = existing[k]; }); Object.keys(rec).forEach(function (k) { m[k] = rec[k]; });
    rec['Bill Total'] = num_(m['Days']) * num_(m['Rate Per Day']) + num_(m['Extra Km Charge']) + num_(m['Late Fee']) + num_(m['Fuel Charge']) + num_(m['Damage Charge']) + num_(m['Toll Charge']) + num_(m['Fine Charge']) - num_(m['Discount']);
    if (m['End Odometer'] !== '' && m['End Odometer'] != null) {
      if (num_(m['End Odometer']) < num_(m['Start Odometer'])) throw new Error('End odometer is lower than the start reading (' + m['Start Odometer'] + ').');
      rec['Km Driven'] = num_(m['End Odometer']) - num_(m['Start Odometer']);
    }
    rec['Updated At'] = nowIso_();
  }
  if (existing) {
    saved = updateRow_(table, rec[key], rec);
    log_(user, 'Edited ' + LABELS[table], describe_(table, saved));
  } else {
    if (!rec[key]) rec[key] = newId_();
    if (SCHEMA[table].indexOf('Created By') > -1) rec['Created By'] = rec['Created By'] || user.partner;
    if (table === 'Customers') rec['Created At'] = rec['Created At'] || nowIso_();
    appendRows_(table, [rec]);
    saved = rec;
    log_(user, 'Added ' + LABELS[table], describe_(table, rec));
  }
  if (table === 'Payments') {
    if (saved['Trip ID']) recalcTrip_(saved['Trip ID']);
    if (existing && existing['Trip ID'] && existing['Trip ID'] !== saved['Trip ID']) recalcTrip_(existing['Trip ID']);
  }
  if (table === 'Trips') recalcTrip_(saved['Trip ID']);
  return saved;
}

function describe_(table, r) {
  if (table === 'Partners') return r['Partner'];
  if (table === 'Enquiries') return [r['Name'], r['Status']].filter(String).join(' · ');
  return [r['Type'] || r['Item'] || r['Name'] || r['Partner'] || r['To'] || '', r['Amount'] || ''].filter(String).join(' · ');
}

function remove_(p, user) {
  requireAdmin_(user, 'Only the admin can delete entries.');
  if (REMOVABLE.indexOf(p.table) === -1) throw new Error('Records in this list cannot be deleted.');
  var sh = ss_().getSheetByName(p.table);
  var r = findRow_(sh, p.id);
  if (r < 0) throw new Error('Already deleted.');
  var old = getRow_(p.table, p.id);
  sh.deleteRow(r);
  log_(user, 'Deleted ' + LABELS[p.table], JSON.stringify(old));
  if (p.table === 'Payments' && old && old['Trip ID']) recalcTrip_(old['Trip ID']);
  return true;
}

/* ------------------------------------------------------------------ */
/* Import from the old AppSheet sheet (read only on the old sheet)     */
/* ------------------------------------------------------------------ */
function importOld_(user) {
  var s = settings_();
  var old = SpreadsheetApp.openById(String(s['Old Sheet ID']).replace(/^'/, ''));
  var tz = tz_();

  function oldTable(name) {
    var sh = old.getSheetByName(name);
    if (!sh || sh.getLastRow() < 2) return [];
    var v = sh.getDataRange().getValues();
    var h = v[0].map(function (x) { return String(x).trim(); });
    return v.slice(1).filter(function (r) { return r[0] !== ''; }).map(function (r) {
      var o = {}; h.forEach(function (c, i) { o[c] = r[i]; }); return o;
    });
  }
  function iso(d) { return d instanceof Date ? Utilities.formatDate(d, tz, "yyyy-MM-dd'T'HH:mm") : (d ? String(d) : ''); }
  function dayMs(d) { return d instanceof Date ? d.getTime() : NaN; }

  // Photo paths like "TRIP LOG_Images/x.jpg" → Drive file ids, looked up in the old sheet's folder.
  var oldParent = DriveApp.getFileById(old.getId()).getParents();
  oldParent = oldParent.hasNext() ? oldParent.next() : DriveApp.getRootFolder();
  var photoIds = {};
  ['TRIP LOG_Images', 'VEHICLE PURCHASE AND INITIAL INVESTMENT_Images'].forEach(function (fname) {
    var it = oldParent.getFoldersByName(fname);
    while (it.hasNext()) {
      var files = it.next().getFiles();
      while (files.hasNext()) { var f = files.next(); photoIds[fname + '/' + f.getName()] = f.getId(); }
    }
  });
  function pid(path) { return path ? (photoIds[String(path)] || '') : ''; }

  // Partners: use the AppSheet names for matching emails, then add anyone not yet listed.
  var psh = ss_().getSheetByName('Partners'), ph = headers_(psh);
  if (psh.getLastRow() > 1) {
    var pv = psh.getRange(2, 1, psh.getLastRow() - 1, ph.length).getValues(), ni = ph.indexOf('Partner'), ei = ph.indexOf('Email');
    oldTable('PARTNERS').forEach(function (x) {
      for (var i = 0; i < pv.length; i++) {
        if (String(pv[i][ei]).toLowerCase() === String(x['Email Address']).toLowerCase() && pv[i][ni] !== x['Partner']) {
          psh.getRange(i + 2, ni + 1).setValue("'" + x['Partner']);
        }
      }
    });
  }
  var partners = readTable_('Partners');
  var known = partners.map(function (x) { return String(x['Email']).toLowerCase(); });
  var newPartners = oldTable('PARTNERS').filter(function (x) { return known.indexOf(String(x['Email Address']).toLowerCase()) === -1; })
    .map(function (x) { return { 'Partner': x['Partner'], 'Email': x['Email Address'], 'Role': 'Partner', 'Active': true }; });
  appendRows_('Partners', newPartners);
  var partnerNames = readTable_('Partners').map(function (x) { return String(x['Partner']); });

  // Vehicles and investments
  var vehicles = [], investments = [], transfers = [], vehicleIdByName = {};
  oldTable('VEHICLE PURCHASE AND INITIAL INVESTMENT').forEach(function (r) {
    var name = String(r['Vehicle / Reg No']);
    var id = 'V' + newId_().slice(0, 5);
    vehicleIdByName[name] = id;
    vehicles.push({ 'Vehicle ID': id, 'Name': name, 'Reg No': '', 'Purchase Price': r['Purchase Price'], 'Extra Costs': r['Extra Costs (Insurance/Tax)'],
      'Photo': pid(r['Vehicle Photo']), 'Status': 'Active', 'Notes': '[import]' });
    partnerNames.forEach(function (pn) {
      if (num_(r[pn]) > 0) investments.push({ 'Investment ID': newId_(), 'Vehicle ID': id, 'Partner': pn, 'Amount': r[pn], 'Notes': '[import]' });
    });
    if (num_(r['Extra Cash Remaining']) > 0 && r['Held By']) {
      transfers.push({ 'Transfer ID': newId_(), 'From': 'Capital', 'To': r['Held By'], 'Amount': r['Extra Cash Remaining'], 'Mode': 'Cash',
        'Notes': '[import] Cash left over after purchase', 'Created By': user.partner });
    }
  });
  function vid(name) {
    name = String(name || '');
    if (!name) return '';
    if (!vehicleIdByName[name]) {
      var id = 'V' + newId_().slice(0, 5);
      vehicleIdByName[name] = id;
      vehicles.push({ 'Vehicle ID': id, 'Name': name, 'Status': 'Active', 'Notes': '[import]' });
    }
    return vehicleIdByName[name];
  }

  // Customers and trips
  var customers = [], custByKey = {};
  function custKey(name, mobile) {
    var m = String(mobile || '').replace(/\D/g, '').slice(-10);
    return m || String(name || '').toLowerCase().trim();
  }
  var trips = oldTable('TRIP LOG').map(function (r) {
    var key = custKey(r['Customer Name'], r['Mobile']);
    var c = custByKey[key];
    if (!c) {
      c = { 'Customer ID': newId_(), 'Name': r['Customer Name'], 'Mobile': String(r['Mobile'] || '').replace(/[‪‬]/g, '').trim(),
        'ID Proof': pid(r['ID Proof']), 'Blocked': false, 'Created At': iso(r['Check Out Date & Time']), 'Notes': '[import]' };
      custByKey[key] = c; customers.push(c);
    } else if (!c['ID Proof']) c['ID Proof'] = pid(r['ID Proof']);
    var photos = [];
    for (var i = 1; i <= 10; i++) { var id = pid(r['Damage Photo-' + i]); if (id) photos.push(id); }
    var returned = r['Ending Odometer'] !== '' && r['Check In Date & Time'] !== '';
    var outMs = dayMs(r['Check Out Date & Time']), inMs = dayMs(r['Check In Date & Time']);
    return {
      'Trip ID': String(r['Trip ID']), 'Vehicle ID': vid(r['Vehicle']), 'Customer ID': c['Customer ID'], 'Customer Name': r['Customer Name'],
      'Mobile': c['Mobile'], 'Status': returned ? 'Returned' : 'Out', 'Out At': iso(r['Check Out Date & Time']),
      'Start Odometer': r['Starting Odometer'], 'ID Proof': pid(r['ID Proof']), 'Out Photos': photos.join(','),
      'In At': returned ? iso(r['Check In Date & Time']) : '', 'End Odometer': returned ? r['Ending Odometer'] : '',
      'Km Driven': returned ? num_(r['Ending Odometer']) - num_(r['Starting Odometer']) : '',
      'Days': returned ? Math.max(1, Math.round((inMs - outMs) / 864e5)) : '',
      'Notes': '[import]', 'Created By': 'AppSheet', 'Updated At': nowIso_(),
      _out: outMs, _in: returned ? inMs : NaN, _vehicle: String(r['Vehicle']), _name: String(r['Customer Name']).toLowerCase()
    };
  });

  // Rental income → payments, matched to the trip they belong to
  var payments = oldTable('RENTAL INCOME LOG').map(function (r) {
    var d = dayMs(r['Date']), nm = String(r['Customer Name']).toLowerCase();
    var best = null, bestGap = 1e15;
    trips.forEach(function (t) {
      if (t._vehicle !== String(r['Vehicle'])) return;
      if (t._name.slice(0, 4) !== nm.slice(0, 4)) return;
      var lo = t._out - 2 * 864e5, hi = (isNaN(t._in) ? t._out : t._in) + 4 * 864e5;
      if (d < lo || d > hi) return;
      var gap = Math.abs(d - t._out);
      if (gap < bestGap) { best = t; bestGap = gap; }
    });
    if (best) {
      best['Rate Per Day'] = best['Rate Per Day'] || r['Rate per Day'];
      if (r['Days']) best['Days'] = best['Days'] || r['Days'];
    }
    return { 'Payment ID': String(r['Income ID']), 'Date': iso(r['Date']), 'Trip ID': best ? best['Trip ID'] : '', 'Vehicle ID': vid(r['Vehicle']),
      'Customer Name': r['Customer Name'], 'Type': 'Rent', 'Amount': r['Total Amount'], 'Mode': r['Mode of Payment'],
      'Received By': r['Received By'], 'Notes': '[import] ' + (r['Days'] || '') + ' days × ' + (r['Rate per Day'] || ''), 'Created By': 'AppSheet' };
  });
  trips.forEach(function (t) {
    var paid = payments.filter(function (x) { return x['Trip ID'] === t['Trip ID']; }).reduce(function (s, x) { return s + num_(x['Amount']); }, 0);
    if (paid > 0) { t['Bill Total'] = paid; t['Paid'] = paid; t['Balance'] = 0; }
    delete t._out; delete t._in; delete t._vehicle; delete t._name;
  });

  var expenses = oldTable('EXPENSE LOG').map(function (r) {
    return { 'Expense ID': String(r['Expense ID']), 'Date': iso(r['Date']), 'Vehicle ID': vid(r['Vehicle']), 'Type': r['Expense Type'],
      'Description': r['Description'], 'Amount': r['Amount'], 'Paid By': r['Paid By'], 'Mode': r['Mode of Payment'], 'Created By': 'AppSheet' };
  });
  var dividends = oldTable('DIVIDENT').map(function (r) {
    return { 'Dividend ID': String(r['Divident ID']), 'Date': iso(r['Date']), 'Partner': r['Partner'], 'Amount': r['Amount'],
      'Mode': r['Mode of Payment'], 'Paid By': r['Paid By'], 'Notes': r['Notes'] };
  });
  var sales = oldTable('VEHICLE SALES LOG').map(function (r) {
    return { 'Sale ID': String(r['Sale ID']), 'Date': iso(r['Date']), 'Vehicle ID': vid(r['Vehicle']), 'Buyer': r['Customer Name'],
      'Amount': r['Sale Amount'], 'Received By': r['Received By'] };
  });

  // Keep transfers entered in the new app; replace only imported ones.
  var keptTransfers = readTable_('Transfers').filter(function (x) { return String(x['Notes']).indexOf('[import]') === -1; });

  replaceAll_('Vehicles', vehicles);
  replaceAll_('Investments', investments);
  replaceAll_('Customers', customers);
  replaceAll_('Trips', trips);
  replaceAll_('Payments', payments);
  replaceAll_('Expenses', expenses);
  replaceAll_('Dividends', dividends);
  replaceAll_('Sales', sales);
  replaceAll_('Transfers', transfers.concat(keptTransfers));

  var summary = vehicles.length + ' vehicles, ' + trips.length + ' trips, ' + payments.length + ' payments, ' + expenses.length + ' expenses, ' + customers.length + ' customers';
  log_(user, 'Imported from AppSheet', summary);
  return { summary: summary };
}

/* ------------------------------------------------------------------ */
/* Telegram alerts: the bot messages each partner privately            */
/* ------------------------------------------------------------------ */
var TG_ALERTS = ['All', 'Trips', 'Money', 'Morning summary only', 'Off'];
var TG_TRIPS = ['checkOut', 'book', 'cancelBooking', 'checkIn', 'workshop', 'enquiry'];

function tgProp_(k, v) { var pr = PropertiesService.getScriptProperties(); if (v === undefined) return pr.getProperty(k) || ''; if (v === null) pr.deleteProperty(k); else pr.setProperty(k, v); return v; }
function h_(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function cap_(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(); }
/** Indian grouping: 1,25,000 */
function inr_(v) {
  var n = Math.round(num_(v)), neg = n < 0, s = String(Math.abs(n)), last = s.slice(-3), rest = s.slice(0, -3);
  if (rest) last = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last;
  return (neg ? '-₹' : '₹') + last;
}
/** '2026-10-22T18:00' → '22/10/2026 18:00' */
function dmy_(iso, withTime) {
  var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!m) return '';
  return m[3] + '/' + m[2] + '/' + m[1] + (withTime !== false && m[4] && !(m[4] === '00' && m[5] === '00') ? ' ' + m[4] + ':' + m[5] : '');
}
function carName_(id) { var v = id ? getRow_('Vehicles', id) : null; return v ? v['Name'] : (id ? id : 'General'); }

function tgApi_(method, payload) {
  var token = tgProp_('TG_TOKEN');
  if (!token) throw new Error('The Telegram bot is not set up yet.');
  var r = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/' + method, { method: 'post', contentType: 'application/json', payload: JSON.stringify(payload || {}), muteHttpExceptions: true });
  var j = {}; try { j = JSON.parse(r.getContentText()); } catch (e) { j = {}; }
  if (!j.ok) { var err = new Error(j.description ? 'Telegram: ' + j.description : 'Telegram could not be reached.'); err.code = 'TG'; throw err; }
  return j.result;
}
/** Send one message to several chats at once. Never throws: an alert must not break a save. */
function tgSendMany_(chatIds, html) {
  var token = tgProp_('TG_TOKEN'); if (!token || !chatIds.length) return 0;
  var reqs = chatIds.map(function (id) {
    return { url: 'https://api.telegram.org/bot' + token + '/sendMessage', method: 'post', contentType: 'application/json', muteHttpExceptions: true,
      payload: JSON.stringify({ chat_id: id, text: html, parse_mode: 'HTML', disable_web_page_preview: true }) };
  });
  try { return UrlFetchApp.fetchAll(reqs).filter(function (r) { return r.getResponseCode() === 200; }).length; } catch (e) { console.error('Telegram', e); return 0; }
}
function tgPartners_() {
  return readTable_('Partners').filter(function (r) { return r['Active'] !== false && String(r['Telegram Chat ID'] || '').replace(/^'/, ''); });
}
/** Who should get an alert about this kind of entry made by `actor`. */
function tgRecipients_(kind, actor) {
  var isTrip = TG_TRIPS.indexOf(kind) > -1;
  return tgPartners_().filter(function (r) {
    var pref = r['Telegram Alerts'] || 'All';
    if (pref === 'Off' || pref === 'Morning summary only') return false;
    if (pref === 'Trips' && !isTrip) return false;
    if (pref === 'Money' && isTrip) return false;
    if (String(r['Partner']).toUpperCase() === String(actor).toUpperCase() && r['Telegram Own'] !== true) return false;
    return true;
  }).map(function (r) { return String(r['Telegram Chat ID']).replace(/^'/, ''); });
}
function tgNotify_(kind, user, html) {
  if (!tgProp_('TG_TOKEN')) return;
  var to = tgRecipients_(kind, user.partner);
  if (to.length) tgSendMany_(to, html);
}

/** Build and send the alert for an action that just succeeded. */
function tgAfter_(action, p, user, r, before) {
  if (!tgProp_('TG_TOKEN')) return;
  var who = '<b>' + h_(cap_(user.partner)) + '</b>', t, msg = '', kind = action;
  if (['checkOut', 'book', 'cancelBooking', 'checkIn', 'addCharge'].indexOf(action) > -1) t = getRow_('Trips', (r && r.tripId) || p.tripId);
  if (action === 'checkOut' && t) {
    msg = '🚗 ' + who + ' checked out a car\n<b>' + h_(carName_(t['Vehicle ID'])) + '</b> → ' + h_(t['Customer Name']) + (t['Mobile'] ? ' (' + h_(t['Mobile']) + ')' : '') +
      '\n' + inr_(t['Rate Per Day']) + '/day' + (t['Expected Return'] ? ' · back ' + dmy_(t['Expected Return']) : '') + (num_(t['Paid']) ? '\nAdvance ' + inr_(t['Paid']) : '') + (num_(t['Deposit']) ? ' · deposit ' + inr_(t['Deposit']) : '');
  } else if (action === 'book' && t) {
    msg = (p.tripId ? '✏️ ' + who + ' changed a booking\n' : '📅 ' + who + ' made a booking\n') + '<b>' + h_(carName_(t['Vehicle ID'])) + '</b> · ' + h_(t['Customer Name']) +
      '\n' + dmy_(t['Out At']) + ' → ' + dmy_(t['Expected Return']) + (num_(t['Paid']) ? '\nAdvance ' + inr_(t['Paid']) : '');
  } else if (action === 'cancelBooking' && t) {
    msg = '❌ ' + who + ' cancelled a booking\n' + h_(t['Customer Name']) + ' · ' + h_(carName_(t['Vehicle ID'])) + ' · ' + dmy_(t['Out At']) + (num_(p.refund) ? '\nRefunded ' + inr_(p.refund) : '');
  } else if (action === 'checkIn' && t) {
    msg = '✅ ' + who + ' checked in a car\n<b>' + h_(carName_(t['Vehicle ID'])) + '</b> ← ' + h_(t['Customer Name']) +
      '\nBill ' + inr_(t['Bill Total']) + ' · paid ' + inr_(t['Paid']) + (num_(t['Balance']) > 0 ? ' · <b>' + inr_(t['Balance']) + ' still due</b>' : '') +
      (t['Km Driven'] !== '' && t['Km Driven'] != null ? '\n' + h_(t['Km Driven']) + ' km' : '') + (t['Rating'] ? ' · rated ' + h_(t['Rating']) : '');
  } else if (action === 'addCharge' && t) {
    kind = 'money';
    msg = '🧾 ' + who + ' added a ' + (p.kind === 'Toll' ? 'toll' : 'traffic fine') + ' to a bill\n' + inr_(p.amount) + ' · ' + h_(t['Customer Name']) + (p.note ? ' · ' + h_(p.note) : '') + (num_(t['Balance']) > 0 ? '\nNow due: ' + inr_(t['Balance']) : '');
  } else if (action === 'addPayment') {
    kind = 'money';
    var tr = p.tripId ? getRow_('Trips', p.tripId) : null;
    msg = '💰 ' + who + ' recorded a payment\n' + inr_(p.amount) + ' from ' + h_(tr ? tr['Customer Name'] : (p.customerName || 'customer')) + ' · ' + h_(p.mode || '') + ' · received by ' + h_(cap_(p.receivedBy || user.partner)) +
      (tr && num_(tr['Balance']) > 0 ? '\nStill due: ' + inr_(tr['Balance']) : tr ? '\nFully paid' : '');
  } else if (action === 'workshop') {
    var v = getRow_('Vehicles', p.vehicleId) || {};
    msg = p.on ? '🔧 ' + who + ' sent <b>' + h_(v['Name']) + '</b> to the workshop' + (v['Workshop Notes'] ? '\n' + h_(v['Workshop Notes']) : '') + (v['Workshop Until'] ? '\nExpected back ' + dmy_(v['Workshop Until'], false) : '')
      : '🔧 <b>' + h_(v['Name']) + '</b> is back from the workshop (' + h_(cap_(user.partner)) + ')' + (num_(p.cost) ? '\nBill ' + inr_(p.cost) + ' paid by ' + h_(cap_(p.paidBy || user.partner)) : '');
  } else if (action === 'save' && r) {
    var tb = p.table, edited = !!before, x = r, verb = edited ? 'edited' : 'added';
    kind = tb === 'Enquiries' ? 'enquiry' : 'money';
    if (tb === 'Expenses') msg = '💸 ' + who + ' ' + verb + ' an expense\n' + inr_(x['Amount']) + ' · ' + h_(x['Type']) + (x['Description'] ? ' · ' + h_(x['Description']) : '') + '\n' + h_(carName_(x['Vehicle ID'])) + ' · paid by ' + h_(cap_(x['Paid By']));
    else if (tb === 'Payments') msg = '💰 ' + who + ' ' + verb + ' income\n' + inr_(x['Amount']) + ' · ' + h_(x['Type']) + (x['Customer Name'] ? ' · ' + h_(x['Customer Name']) : '') + ' · received by ' + h_(cap_(x['Received By']));
    else if (tb === 'Transfers') msg = '🔁 ' + who + ' ' + verb + ' a cash handover\n' + h_(x['From'] === 'Capital' ? 'Business capital' : cap_(x['From'])) + ' → ' + h_(cap_(x['To'])) + ' · ' + inr_(x['Amount']);
    else if (tb === 'Dividends') msg = '🎁 ' + who + ' ' + verb + ' a dividend\n' + inr_(x['Amount']) + ' to ' + h_(cap_(x['Partner'])) + ' · paid by ' + h_(cap_(x['Paid By']));
    else if (tb === 'Sales') msg = '🏷️ ' + who + ' ' + verb + ' a car sale\n' + h_(carName_(x['Vehicle ID'])) + ' · ' + inr_(x['Amount']) + (x['Buyer'] ? ' · ' + h_(x['Buyer']) : '');
    else if (tb === 'Enquiries' && !edited) msg = '📞 ' + who + ' added an enquiry\n' + h_(x['Name']) + (x['Mobile'] ? ' (' + h_(x['Mobile']) + ')' : '') + ' · ' + h_(x['Vehicle ID'] ? carName_(x['Vehicle ID']) : 'any car') +
      (x['Wanted From'] ? '\n' + dmy_(x['Wanted From'], false) + (x['Wanted To'] ? ' → ' + dmy_(x['Wanted To'], false) : '') : '') + (x['Source'] ? ' · ' + h_(x['Source']) : '');
  } else if (action === 'remove' && before) {
    kind = p.table === 'Enquiries' ? 'enquiry' : 'money';
    msg = '🗑️ ' + who + ' deleted ' + (function (l) { return (/^[aeiou]/.test(l) ? 'an ' : 'a ') + l; })(LABELS[p.table] || 'record') + '\n' +
      [before['Amount'] !== undefined && before['Amount'] !== '' ? inr_(before['Amount']) : '', h_(before['Type'] || before['Item'] || before['Name'] || ''), before['Date'] ? dmy_(before['Date'], false) : ''].filter(String).join(' · ');
  }
  if (msg) tgNotify_(kind, user, msg);
}
/** Wrap the actions that change data so each success sends an alert afterwards (outside the lock). */
['checkOut', 'book', 'cancelBooking', 'checkIn', 'addPayment', 'addCharge', 'save', 'remove', 'workshop'].forEach(function (k) {
  var fn = ACTIONS[k];
  ACTIONS[k] = function (p, user, token) {
    var before = null;
    try {
      if (k === 'remove') before = getRow_(p.table, p.id);
      if (k === 'save' && SCHEMA[p.table]) { var key = SCHEMA[p.table][0]; before = p.record && p.record[key] ? getRow_(p.table, p.record[key]) : null; }
    } catch (e) { before = null; }
    var r = fn(p, user, token);
    try { tgAfter_(k, p, user, r, before); } catch (e) { console.error('Telegram alert', e); }
    return r;
  };
});

/* ----- Settings, connecting and choices ----- */
function tgStatus_(user) {
  var me = partnerRow_(user.partner) || {}, bot = tgProp_('TG_BOT');
  var out = { botSet: !!tgProp_('TG_TOKEN'), bot: bot, morning: !!tgProp_('TG_MORNING'),
    me: { connected: !!String(me['Telegram Chat ID'] || '').replace(/^'/, ''), alerts: me['Telegram Alerts'] || 'All', own: me['Telegram Own'] === true } };
  if (user.role === 'Admin') out.partners = readTable_('Partners').filter(function (r) { return r['Active'] !== false; }).map(function (r) { return { partner: r['Partner'], connected: !!String(r['Telegram Chat ID'] || '').replace(/^'/, ''), alerts: r['Telegram Alerts'] || 'All' }; });
  return out;
}
function tgSaveBot_(p, user) {
  requireAdmin_(user);
  var token = String(p.token || '').trim();
  if (!/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(token)) throw new Error('That does not look like a bot token. Copy the whole line BotFather sent, like 123456789:AA…');
  var old = tgProp_('TG_TOKEN');
  tgProp_('TG_TOKEN', token);
  try { var meBot = tgApi_('getMe', {}); tgProp_('TG_BOT', meBot.username); tgProp_('TG_OFFSET', null); }
  catch (e) { if (old) tgProp_('TG_TOKEN', old); else tgProp_('TG_TOKEN', null); throw new Error('Telegram did not accept that token. Check you copied all of it.'); }
  log_(user, 'Set up Telegram alerts', '@' + tgProp_('TG_BOT'));
  return tgStatus_(user);
}
function tgLink_(user) {
  if (!tgProp_('TG_TOKEN')) throw new Error('The admin needs to set up the Telegram bot first.');
  var code = Utilities.getUuid().replace(/-/g, '').slice(0, 10);
  CacheService.getScriptCache().put('tg_' + code, String(user.partner), 1800);
  return { code: code, url: 'https://t.me/' + tgProp_('TG_BOT') + '?start=' + code };
}
/** After the partner taps Start in Telegram, find their chat and save it. */
function tgConfirm_(p, user) {
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var offset = num_(tgProp_('TG_OFFSET')), found = null, cache = CacheService.getScriptCache();
    var ups = tgApi_('getUpdates', { offset: offset ? offset + 1 : 0, timeout: 0, allowed_updates: ['message'] }) || [];
    ups.forEach(function (u) {
      offset = Math.max(offset, u.update_id);
      var m = u.message; if (!m || !m.text) return;
      var mm = String(m.text).match(/^\/start\s+([a-f0-9]{10})$/);
      if (!mm) return;
      var who = cache.get('tg_' + mm[1]);
      if (!who) return;
      var row = partnerRow_(who);
      if (row) { updateRow_('Partners', row['Partner'], { 'Telegram Chat ID': String(m.chat.id), 'Telegram Alerts': row['Telegram Alerts'] || 'All' }); cache.remove('tg_' + mm[1]); }
      if (String(who).toUpperCase() === String(user.partner).toUpperCase()) found = String(m.chat.id);
      tgSendMany_([String(m.chat.id)], '👋 Hello ' + h_(cap_(who)) + '! This chat will now get alerts from <b>' + h_(settings_()['Business Name'] || APP_NAME) + '</b>. You can change what you get in the app: Partners → Telegram alerts.');
    });
    if (ups.length) tgProp_('TG_OFFSET', String(offset));
    if (!found && !String((partnerRow_(user.partner) || {})['Telegram Chat ID'] || '').replace(/^'/, '')) throw new Error('Telegram has not received your Start yet. Open the bot, tap Start, then come back and tap "I tapped Start".');
    if (found) log_(user, 'Connected Telegram', '');
    return tgStatus_(user);
  } finally { lock.releaseLock(); }
}
function tgPrefs_(p, user) {
  var row = partnerRow_(user.partner); if (!row) throw new Error('Partner not found.');
  if (TG_ALERTS.indexOf(p.alerts) === -1) throw new Error('Choose what to receive.');
  updateRow_('Partners', row['Partner'], { 'Telegram Alerts': p.alerts, 'Telegram Own': p.own === true });
  return tgStatus_(user);
}
function tgDisconnect_(p, user) {
  var name = p.partner && user.role === 'Admin' ? p.partner : user.partner, row = partnerRow_(name);
  if (row) updateRow_('Partners', row['Partner'], { 'Telegram Chat ID': '' });
  return tgStatus_(user);
}
function tgTest_(user) {
  var row = partnerRow_(user.partner) || {}, id = String(row['Telegram Chat ID'] || '').replace(/^'/, '');
  if (!id) throw new Error('Connect your Telegram first.');
  if (!tgSendMany_([id], '✅ Test message from <b>' + h_(settings_()['Business Name'] || APP_NAME) + '</b>. Alerts are working.')) throw new Error('Telegram did not deliver the message. Open the bot and tap Start again.');
  return true;
}

/* ----- Morning summary (time trigger, every day at 8:00) ----- */
function installMorningTrigger_() {
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'morningSummary') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('morningSummary').timeBased().atHour(8).nearMinute(0).everyDays(1).inTimezone(tz_()).create();
  tgProp_('TG_MORNING', '1');
}
function morningSummary() {
  if (!tgProp_('TG_TOKEN')) return;
  var to = tgPartners_().filter(function (r) { return (r['Telegram Alerts'] || 'All') !== 'Off'; }).map(function (r) { return String(r['Telegram Chat ID']).replace(/^'/, ''); });
  if (!to.length) return;
  tgSendMany_(to, morningText_());
}
function morningText_() {
  var now = new Date(), today = Utilities.formatDate(now, tz_(), 'yyyy-MM-dd'), nowIso = nowIso_(), st = settings_();
  var warn = num_(st['Expiry Warning Days'] || 30), trips = readTable_('Trips'), lines = [];
  var add = function (title, items) { if (items.length) lines.push('<b>' + title + '</b>\n' + items.map(function (s) { return '• ' + s; }).join('\n')); };
  var out = trips.filter(function (t) { return t['Status'] === 'Out'; });
  add('🚗 On trip (' + out.length + ')', out.map(function (t) {
    var late = t['Expected Return'] && String(t['Expected Return']) < nowIso;
    return h_(carName_(t['Vehicle ID'])) + ' · ' + h_(t['Customer Name']) + (t['Expected Return'] ? (late ? ' · <b>late, was due ' + dmy_(t['Expected Return']) + '</b>' : String(t['Expected Return']).slice(0, 10) === today ? ' · <b>back today ' + String(t['Expected Return']).slice(11, 16) + '</b>' : ' · back ' + dmy_(t['Expected Return'])) : '');
  }));
  add('📅 Pickups today', trips.filter(function (t) { return t['Status'] === 'Booked' && String(t['Out At']).slice(0, 10) === today; }).map(function (t) { return String(t['Out At']).slice(11, 16) + ' · ' + h_(t['Customer Name']) + ' · ' + h_(carName_(t['Vehicle ID'])); }));
  add('⚠️ Bookings not started', trips.filter(function (t) { return t['Status'] === 'Booked' && String(t['Out At']).slice(0, 10) < today; }).map(function (t) { return h_(t['Customer Name']) + ' · was ' + dmy_(t['Out At']); }));
  add('💰 Money due', trips.filter(function (t) { return t['Status'] === 'Returned' && num_(t['Balance']) > 0; }).map(function (t) { return inr_(t['Balance']) + ' · ' + h_(t['Customer Name']) + ' (since ' + dmy_(t['In At'], false) + ')'; }));
  add('📞 Follow up today', readTable_('Enquiries').filter(function (e) { return e['Status'] !== 'Booked' && e['Status'] !== 'Lost' && e['Follow Up'] && String(e['Follow Up']).slice(0, 10) <= today; }).map(function (e) { return h_(e['Name']) + (e['Mobile'] ? ' ' + h_(e['Mobile']) : ''); }));
  add('🔧 In workshop', readTable_('Vehicles').filter(function (v) { return v['Status'] === 'Workshop'; }).map(function (v) { return h_(v['Name']) + (v['Workshop Until'] ? ' · back ' + dmy_(v['Workshop Until'], false) : ''); }));
  var odo = {}; trips.forEach(function (t) { var id = t['Vehicle ID']; odo[id] = Math.max(odo[id] || 0, num_(t['End Odometer']), num_(t['Start Odometer'])); });
  var soon = Utilities.formatDate(new Date(now.getTime() + warn * 864e5), tz_(), 'yyyy-MM-dd');
  add('📄 Papers and service', readTable_('Documents').filter(function (d) {
    var ex = String(d['Expiry Date'] || '').slice(0, 10), km = num_(d['Due Odometer']);
    return (ex && ex <= soon) || (km && km - (odo[d['Vehicle ID']] || 0) <= 500);
  }).map(function (d) {
    var ex = String(d['Expiry Date'] || '').slice(0, 10), km = num_(d['Due Odometer']);
    return h_(d['Item']) + ' · ' + h_(carName_(d['Vehicle ID'])) + (ex ? (ex < today ? ' · <b>expired ' + dmy_(ex, false) + '</b>' : ' · ' + dmy_(ex, false)) : '') + (km ? ' · at ' + inr_(km).replace('₹', '') + ' km' : '');
  }));
  var head = '☀️ <b>' + h_(st['Business Name'] || APP_NAME) + '</b> · ' + Utilities.formatDate(now, tz_(), 'EEE dd/MM/yyyy');
  return head + '\n\n' + (lines.length ? lines.join('\n\n') : '✅ Nothing due today. All cars are in order.');
}

ACTIONS.tgStatus = function (p, user) { return tgStatus_(user); };
ACTIONS.tgSaveBot = function (p, user) { return tgSaveBot_(p, user); };
ACTIONS.tgLink = function (p, user) { return tgLink_(user); };
ACTIONS.tgConfirm = function (p, user) { return tgConfirm_(p, user); };
ACTIONS.tgPrefs = function (p, user) { return tgPrefs_(p, user); };
ACTIONS.tgDisconnect = function (p, user) { return tgDisconnect_(p, user); };
ACTIONS.tgTest = function (p, user) { return tgTest_(user); };
ACTIONS.tgMorningPreview = function (p, user) { requireAdmin_(user); return morningText_(); };
ACTIONS.tgMorningSend = function (p, user) { requireAdmin_(user); morningSummary(); return true; };
