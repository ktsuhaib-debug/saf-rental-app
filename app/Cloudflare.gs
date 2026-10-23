/**
 * SAF Rental → Cloudflare: the one-time move, and the Google Sheet copy afterwards.
 *
 * Add this file to the existing Apps Script project (next to Code.gs). It uses Code.gs's own sheet
 * helpers, so the sheet keeps exactly the same tabs, columns and date formats as before.
 *
 * Once, in Project Settings → Script Properties, add:
 *   CF_URL       https://saf-rental.<your-subdomain>.workers.dev   (no slash at the end)
 * Then run cfMakeKey and paste the key it shows into Cloudflare as the SYNC_KEY secret.
 *
 * Then run, from the editor (choose the function at the top, then Run):
 *   1. cfCopyFiles   copies photos, ID proofs, signatures and agreement PDFs from Drive to Cloudflare.
 *                    Safe to run while the old app is still in use. Run it again until it says "All files copied".
 *   2. cfSwitchOver  stops the old app (its link shows "moved" with the new link), copies all data across,
 *                    copies any files added meanwhile, and starts the sheet copy every 5 minutes.
 * After that, enter everything in the Cloudflare app only. The sheet is a read-only copy.
 */

var CF_FORMAT = 'saf-rental-report-v1';

/** Makes the shared secret key once, saves it as CF_SYNC_KEY, and shows it so it can be pasted into Cloudflare as SYNC_KEY. */
function cfMakeKey() {
  var p = PropertiesService.getScriptProperties(), key = p.getProperty('CF_SYNC_KEY');
  if (!key) {
    key = (Utilities.getUuid() + Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
    p.setProperty('CF_SYNC_KEY', key);
  }
  console.log('Copy this into Cloudflare → saf-rental → Settings → Variables and Secrets → Add → Secret, name SYNC_KEY:\n' + key);
  return key;
}

function cfConfig_() {
  var p = PropertiesService.getScriptProperties();
  var url = String(p.getProperty('CF_URL') || '').trim().replace(/\/+$/, '');
  var key = String(p.getProperty('CF_SYNC_KEY') || '').trim();
  if (!/^(https:\/\/[^\s/]+|http:\/\/localhost(:\d+)?)$/.test(url)) throw new Error('Set CF_URL in Script Properties first, like https://saf-rental.example.workers.dev');
  if (key.length < 32) throw new Error('Set CF_SYNC_KEY in Script Properties first (at least 32 characters, the same as SYNC_KEY in Cloudflare).');
  return { url: url, key: key };
}

function cfFetch_(path, opts) {
  var c = cfConfig_();
  opts = opts || {};
  opts.headers = { Authorization: 'Bearer ' + c.key };
  opts.muteHttpExceptions = true;
  var r = UrlFetchApp.fetch(c.url + path, opts), code = r.getResponseCode(), body = {};
  try { body = JSON.parse(r.getContentText()); } catch (e) { body = {}; }
  if (code === 401) throw new Error('Cloudflare refused the key. CF_SYNC_KEY must be exactly the same as the SYNC_KEY secret in Cloudflare.');
  if (code < 200 || code >= 300) throw new Error('Cloudflare: ' + (body.error || ('HTTP ' + code)));
  return body;
}

/** Is the old app switched off? Used by doGet() and api() in Code.gs. */
function cfMovedTo_() {
  var p = PropertiesService.getScriptProperties();
  return p.getProperty('CF_MOVED') === 'yes' ? String(p.getProperty('CF_URL') || '').replace(/\/+$/, '') : '';
}

function cfMovedPage_(url) {
  var u = String(url).replace(/"/g, '&quot;');
  return '<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<style>body{font-family:system-ui,sans-serif;background:#eef1f5;margin:0;display:grid;place-items:center;min-height:100vh}' +
    '.c{background:#fff;border-radius:18px;padding:28px 24px;max-width:360px;margin:16px;text-align:center;box-shadow:0 6px 24px rgba(19,26,42,.08)}' +
    'h1{font-size:22px;margin:0 0 8px;color:#131a2a}p{color:#4a5368;margin:0 0 18px;line-height:1.45}' +
    'a{display:block;background:#1b2a4a;color:#fff;text-decoration:none;padding:14px;border-radius:12px;font-weight:700}</style></head>' +
    '<body><div class="c"><h1>SAF Rental has moved</h1><p>The app is now faster and lives at a new link. Open it, sign in with your usual PIN, and add the new link to your home screen.</p>' +
    '<a href="' + u + '" target="_top">Open the new app</a></div></body></html>';
}

/* ------------------------------------------------------------------ */
/* Step 1 (and again at the switch-over): photos and PDFs → Cloudflare  */
/* ------------------------------------------------------------------ */
function cfFileIds_() {
  var ids = {}, add = function (v) { String(v || '').split(',').forEach(function (x) { x = x.replace(/^'/, '').trim(); if (/^[A-Za-z0-9_-]{10,80}$/.test(x)) ids[x] = true; }); };
  readTable_('Vehicles').forEach(function (r) { add(r['Photo']); });
  readTable_('Customers').forEach(function (r) { add(r['ID Proof']); });
  readTable_('Trips').forEach(function (r) { add(r['ID Proof']); add(r['Out Photos']); add(r['In Photos']); add(r['Signature']); add(r['Agreement File']); });
  return Object.keys(ids);
}

function cfCopyFiles() {
  var started = Date.now();
  var stored = {}; (cfFetch_('/api/admin/stored').ids || []).forEach(function (id) { stored[id] = true; });
  var todo = cfFileIds_().filter(function (id) { return !stored[id]; });
  var done = 0, missing = [];
  for (var i = 0; i < todo.length; i++) {
    if (Date.now() - started > 4.5 * 60 * 1000) break; // Apps Script stops scripts after 6 minutes
    var id = todo[i], file;
    try { file = DriveApp.getFileById(id); } catch (e) { missing.push(id); continue; }
    var blob = file.getBlob(), type = blob.getContentType() || 'application/octet-stream';
    if (blob.getBytes().length > 25e6) { missing.push(id); continue; }
    cfFetch_('/api/admin/file/' + encodeURIComponent(id) + '?kind=full&type=' + encodeURIComponent(type) + '&name=' + encodeURIComponent(file.getName()), { method: 'put', contentType: type, payload: blob.getBytes() });
    if (/^image\//.test(type)) {
      // A small preview, so lists open quickly (the old app used Drive's thumbnails the same way)
      try { var th = file.getThumbnail(); if (th) cfFetch_('/api/admin/file/' + encodeURIComponent(id) + '?kind=thumb&type=' + encodeURIComponent(th.getContentType() || 'image/png'), { method: 'put', contentType: th.getContentType() || 'image/png', payload: th.getBytes() }); } catch (e) { /* the full photo is used instead */ }
    }
    done++;
  }
  var left = todo.length - done - missing.length;
  var msg = left > 0 ? 'Copied ' + done + ' files. ' + left + ' still to copy: run cfCopyFiles again.'
    : 'All files copied (' + done + ' this run).' + (missing.length ? ' ' + missing.length + ' could not be found in Drive (already deleted?): ' + missing.slice(0, 10).join(', ') : '');
  console.log(msg);
  return msg;
}

/* ------------------------------------------------------------------ */
/* Step 2: switch over                                                 */
/* ------------------------------------------------------------------ */
function cfSwitchOver() {
  cfConfig_();
  var p = PropertiesService.getScriptProperties();
  // 1. Stop the old app first, so nothing is entered in two places. Wait for any save in progress.
  p.setProperty('CF_MOVED', 'yes');
  var lock = LockService.getScriptLock(); lock.waitLock(30000); lock.releaseLock();
  // 2. All data, plus the Telegram bot settings.
  ensureSchema_();
  var tables = {};
  Object.keys(SCHEMA).forEach(function (name) { tables[name] = readTable_(name); });
  var kv = {};
  ['TG_TOKEN', 'TG_BOT', 'TG_OFFSET', 'TG_MORNING'].forEach(function (k) { var v = p.getProperty(k); if (v) kv[k] = v; });
  var r;
  try {
    r = cfFetch_('/api/admin/import', { method: 'post', contentType: 'application/json', payload: JSON.stringify({ tables: tables, kv: kv }) });
  } catch (e) {
    p.deleteProperty('CF_MOVED'); // the old app keeps working if the copy failed
    throw new Error('Nothing was moved and the old app still works. ' + e.message);
  }
  console.log('Data copied: ' + JSON.stringify(r.counts));
  // 3. Files added since step 1.
  var files = cfCopyFiles();
  // 4. The sheet copy, every 5 minutes. Run once now so any error shows here.
  p.deleteProperty('CF_LAST_REVISION'); p.deleteProperty('CF_TAB_HASHES');
  cfSyncSheet();
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'cfSyncSheet') ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('cfSyncSheet').timeBased().everyMinutes(5).create();
  var msg = 'Moved. The old link now shows the new one: ' + cfConfig_().url + '. ' + files + ' The sheet now updates from Cloudflare every 5 minutes.';
  console.log(msg);
  return msg;
}

/* ------------------------------------------------------------------ */
/* Sheet copy: Cloudflare → Rental Hub Data, every 5 minutes            */
/* ------------------------------------------------------------------ */
function cfSyncSheet() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    var p = PropertiesService.getScriptProperties();
    var data = cfFetch_('/api/report?revision=' + encodeURIComponent(p.getProperty('CF_LAST_REVISION') || '-1'));
    if (data.unchanged) return;
    if (data.format !== CF_FORMAT || !data.tables || !(data.revision >= 0)) throw new Error('Unexpected reply from Cloudflare. The sheet was not changed.');
    Object.keys(SCHEMA).forEach(function (name) { if (!Array.isArray(data.tables[name])) throw new Error('Cloudflare did not send the ' + name + ' list. The sheet was not changed.'); });
    ensureSchema_();
    var hashes = JSON.parse(p.getProperty('CF_TAB_HASHES') || '{}'), next = {};
    Object.keys(SCHEMA).forEach(function (name) {
      var rows = data.tables[name];
      var hash = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify(rows)));
      next[name] = hash;
      if (hashes[name] === hash) return; // unchanged tab: not rewritten
      replaceAll_(name, rows);
    });
    SpreadsheetApp.flush();
    p.setProperties({ CF_LAST_REVISION: String(data.revision), CF_TAB_HASHES: JSON.stringify(next), CF_LAST_SYNC: new Date().toISOString() });
  } finally { lock.releaseLock(); }
}

/** Rewrite every tab on the next copy (for example after someone typed in the sheet by mistake). */
function cfSyncSheetNow() {
  var p = PropertiesService.getScriptProperties();
  p.deleteProperty('CF_LAST_REVISION'); p.deleteProperty('CF_TAB_HASHES');
  cfSyncSheet();
  return 'Sheet copied from Cloudflare.';
}

/** Undo the switch-over: the old link works again. Data entered in Cloudflare since then is NOT copied back. */
function cfReopenOldApp() {
  PropertiesService.getScriptProperties().deleteProperty('CF_MOVED');
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'cfSyncSheet') ScriptApp.deleteTrigger(t); });
  return 'The old app works again and the sheet copy is stopped.';
}
