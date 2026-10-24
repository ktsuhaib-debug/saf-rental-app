/**
 * SAF Rental on Cloudflare Workers.
 *   POST /api                 the app (same actions and replies as the Apps Script web app)
 *   GET  /photo/:id           a photo, through a short-lived signed link
 *   GET  /doc/:id/:name       an agreement or statement PDF (anyone with the link, like a Drive link)
 *   GET  /api/report          everything, for the Google Sheet copy        (needs SYNC_KEY)
 *   POST /api/admin/import    one-time move of the old sheet data          (needs SYNC_KEY)
 *   GET  /api/admin/stored    ids of the files already in R2               (needs SYNC_KEY)
 *   PUT  /api/admin/file/:id  upload one old Drive photo or PDF            (needs SYNC_KEY)
 * Everything else is the static app in /public.
 */
import { Buffer } from 'node:buffer';
import { loadStore, fullExport, replaceAllTables } from './store.mjs';
import { makeApp, APP_VERSION } from './app.mjs';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (e) {
      console.error(e);
      return new Response(JSON.stringify({ ok: false, error: 'Server problem. Try again.' }), { status: 500, headers: JSON_HEADERS });
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runMorning(env));
  }
};

async function route(request, env, ctx) {
  const url = new URL(request.url), path = url.pathname, method = request.method;
  if (path === '/api' && method === 'POST') return handleApi(request, env, ctx, url);
  if (path.startsWith('/photo/') && method === 'GET') return servePhoto(url, env);
  if (path.startsWith('/doc/') && method === 'GET') return serveDoc(url, env);
  if (path === '/api/health') return json({ ok: true, version: APP_VERSION });
  if (path.startsWith('/api/')) {
    if (!(await syncKeyOk(request, env))) return json({ ok: false, error: 'Not allowed.' }, 401);
    // Only the Apps Script (which holds the key) reaches here, so the real error can be shown.
    try {
      if (path === '/api/report' && method === 'GET') return await report(url, env);
      if (path === '/api/admin/import' && method === 'POST') return await importData(request, env);
      if (path === '/api/admin/stored' && method === 'GET') return await storedFiles(env);
      if (path.startsWith('/api/admin/file/') && method === 'PUT') return await putFile(request, url, env);
    } catch (e) {
      console.error(e);
      return json({ ok: false, error: 'Server problem: ' + String(e && e.message ? e.message : e).slice(0, 500) }, 500);
    }
    return json({ ok: false, error: 'Not found.' }, 404);
  }
  const res = await env.ASSETS.fetch(request);
  if (path === '/' || path.endsWith('.html')) {
    const h = new Headers(res.headers);
    h.set('cache-control', 'no-cache');
    h.set('referrer-policy', 'no-referrer');
    h.set('x-content-type-options', 'nosniff');
    return new Response(res.body, { status: res.status, headers: h });
  }
  return res;
}

function json(o, status) { return new Response(JSON.stringify(o), { status: status || 200, headers: JSON_HEADERS }); }

/* ------------------------------------------------------------------ */
/* The app                                                             */
/* ------------------------------------------------------------------ */
async function handleApi(request, env, ctx, url) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: 'The app sent an unreadable request.' }); }
  const out = await runAction(env, url.origin, (app) => app.api(String(body.action || ''), body.payload || {}, String(body.token || '')), ctx);
  return json(out);
}

/**
 * Load, run, save. If another save got in first, start again on fresh data (like waiting for the
 * old script lock). Telegram alerts and old-file clean-up only happen after a successful save.
 */
async function runAction(env, origin, run, waitCtx) {
  for (let attempt = 0; ; attempt++) {
    const store = await loadStore(env.DB);
    const ctx = { store, env, db: env.DB, origin, uploads: [], deletes: [], after: [] };
    ctx.fileUrl = (id, size) => signedPhotoUrl(env, store, id, size);
    ctx.docUrl = (id, name) => origin + '/doc/' + encodeURIComponent(id) + '/' + encodeURIComponent(name);
    const app = makeApp(ctx);
    let result, error = null;
    try { result = await run(app); } catch (e) { error = e; }
    let saved = false;
    if (!error || error.commitAnyway) {
      try {
        if (ctx.uploads.length) {
          await Promise.all(ctx.uploads.map((u) => env.FILES.put('f/' + u.id, Buffer.from(u.b64, 'base64'), {
            httpMetadata: { contentType: u.type }, customMetadata: { name: u.name }
          })));
        }
        await store.commit();
        saved = true;
      } catch (e) {
        if (e.code === 'CONFLICT' && attempt < 4) { await sleep(40 + Math.random() * 160 * (attempt + 1)); continue; }
        console.error('Save failed', e);
        error = e.code === 'CONFLICT' ? new Error('Too many people saving at once. Try again.') : new Error('Not saved: the server could not store it. Try again.');
      }
    }
    if (saved) {
      const jobs = ctx.after.map((f) => f().catch((e) => console.error('After save', e)))
        .concat(ctx.deletes.filter(Boolean).map((id) => env.FILES.delete(['f/' + id, 't/' + id]).catch(() => {})));
      if (jobs.length) { if (waitCtx && waitCtx.waitUntil) waitCtx.waitUntil(Promise.all(jobs)); else await Promise.all(jobs); }
    }
    if (error) return { ok: false, error: String(error && error.message ? error.message : error), code: error && error.code && error.code !== 'CONFLICT' ? error.code : undefined };
    return { ok: true, data: result };
  }
}

async function runMorning(env) {
  await runAction(env, '', async (app) => {
    // Off unless the admin switched it on (same as the Apps Script version).
    if (!(await env.DB.prepare("SELECT v FROM _kv WHERE k = 'TG_MORNING'").first('v'))) return false;
    app.morningSummary();
    return true;
  }, null);
}

/* ------------------------------------------------------------------ */
/* Photos and PDFs                                                     */
/* ------------------------------------------------------------------ */
async function hmac(secret, text) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(text));
  return Buffer.from(sig).toString('base64url').slice(0, 32);
}

/** The signing secret lives in the database; it is made once, on first use. */
function fileSecret(env, store) {
  if (env.FILE_SECRET) return env.FILE_SECRET;
  let s = store.kvGet('file_secret');
  if (!s) { s = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'); store.kvSet('file_secret', s); }
  return s;
}

async function signedPhotoUrl(env, store, id, size) {
  if (!/^[A-Za-z0-9_-]{10,80}$/.test(id)) return '';
  // Links last 6 to 7 hours and stay the same within the hour, so the phone can cache the photo.
  const exp = (Math.floor(Date.now() / 3600e3) + 7) * 3600;
  const s = await hmac(fileSecret(env, store), id + '.' + size + '.' + exp);
  return '/photo/' + id + '?v=' + size + '&e=' + exp + '&s=' + s;
}

async function servePhoto(url, env) {
  const id = decodeURIComponent(url.pathname.slice(7)), size = url.searchParams.get('v') === 'full' ? 'full' : 'thumb';
  const exp = Number(url.searchParams.get('e') || 0), sig = url.searchParams.get('s') || '';
  if (!/^[A-Za-z0-9_-]{10,80}$/.test(id) || !(exp * 1000 > Date.now())) return new Response('This link has expired. Reopen it from the app.', { status: 403 });
  const secret = env.FILE_SECRET || (await env.DB.prepare("SELECT v FROM _kv WHERE k = 'file_secret'").first('v'));
  if (!secret || (await hmac(secret, id + '.' + size + '.' + exp)) !== sig) return new Response('Not allowed.', { status: 403 });
  let obj = size === 'thumb' ? await env.FILES.get('t/' + id) : null;
  if (!obj) obj = await env.FILES.get('f/' + id);
  if (!obj) return new Response('Photo not found.', { status: 404 });
  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set('cache-control', 'private, max-age=21600');
  h.set('x-content-type-options', 'nosniff');
  if (!/^image\//.test(h.get('content-type') || '')) h.set('content-disposition', 'attachment');
  return new Response(obj.body, { headers: h });
}

async function serveDoc(url, env) {
  const parts = url.pathname.split('/');
  const id = decodeURIComponent(parts[2] || '');
  if (!/^[A-Za-z0-9_-]{10,80}$/.test(id)) return new Response('Not found.', { status: 404 });
  const obj = await env.FILES.get('f/' + id);
  if (!obj || (obj.httpMetadata && obj.httpMetadata.contentType !== 'application/pdf')) return new Response('This document is no longer available.', { status: 404 });
  const name = (obj.customMetadata && obj.customMetadata.name) || 'document.pdf';
  const h = new Headers({ 'content-type': 'application/pdf', 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
  h.set('content-disposition', 'inline; filename="' + name.replace(/[^\w .()-]+/g, '_') + '"');
  return new Response(obj.body, { headers: h });
}

/* ------------------------------------------------------------------ */
/* Google Sheet copy and the one-time move (Apps Script side: app/Cloudflare.gs) */
/* ------------------------------------------------------------------ */
async function syncKeyOk(request, env) {
  const key = String(env.SYNC_KEY || '');
  const got = String(request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (key.length < 32 || got.length !== key.length) return false;
  const a = new TextEncoder().encode(key), b = new TextEncoder().encode(got);
  let diff = 0; for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

async function report(url, env) {
  const since = Number(url.searchParams.get('revision'));
  const rev = Number(await env.DB.prepare("SELECT v FROM _meta WHERE k = 'revision'").first('v').catch(() => 0) || 0);
  if (Number.isFinite(since) && since === rev) return json({ format: 'saf-rental-report-v1', revision: rev, unchanged: true });
  const data = await fullExport(env.DB);
  return json({ format: 'saf-rental-report-v1', revision: data.revision, generatedAt: new Date().toISOString(), tables: data.tables });
}

async function importData(request, env) {
  const body = await request.json();
  if (!body || typeof body.tables !== 'object') return json({ ok: false, error: 'No tables sent.' }, 400);
  const existing = await loadStore(env.DB);
  const hasData = ['Trips', 'Payments', 'Expenses'].some((t) => existing.read(t).length > 0);
  if (hasData && body.force !== true) return json({ ok: false, error: 'The Cloudflare app already has trips or money entries. Nothing was imported, so nothing was overwritten.' }, 409);
  await replaceAllTables(env.DB, body.tables, body.kv || {});
  const counts = {}; Object.keys(body.tables).forEach((t) => { counts[t] = (body.tables[t] || []).length; });
  return json({ ok: true, counts });
}

async function storedFiles(env) {
  const ids = [];
  let cursor;
  do {
    const page = await env.FILES.list({ prefix: 'f/', cursor, limit: 1000 });
    page.objects.forEach((o) => ids.push(o.key.slice(2)));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return json({ ok: true, ids });
}

async function putFile(request, url, env) {
  const id = decodeURIComponent(url.pathname.split('/')[4] || '');
  if (!/^[A-Za-z0-9_-]{10,80}$/.test(id)) return json({ ok: false, error: 'Bad id.' }, 400);
  const kind = url.searchParams.get('kind') === 'thumb' ? 't/' : 'f/';
  const type = String(url.searchParams.get('type') || request.headers.get('content-type') || 'application/octet-stream').slice(0, 100);
  const name = String(url.searchParams.get('name') || id).slice(0, 150);
  const bytes = await request.arrayBuffer();
  if (!bytes.byteLength || bytes.byteLength > 30e6) return json({ ok: false, error: 'Empty or too big.' }, 400);
  await env.FILES.put(kind + id, bytes, { httpMetadata: { contentType: type }, customMetadata: { name } });
  return json({ ok: true, bytes: bytes.byteLength });
}
