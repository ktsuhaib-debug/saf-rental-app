// Runs the real Worker against local stand-ins (tests/fake-env.mjs). No real data, no network.
import assert from 'node:assert/strict';
import worker from '../src/worker.mjs';
import { makeEnv, execCtx } from './fake-env.mjs';

const env = makeEnv();
const ORIGIN = 'https://saf-rental.example.workers.dev';
const KEY = env.SYNC_KEY;
let passed = 0;

async function req(path, init) {
  const ctx = execCtx();
  const res = await worker.fetch(new Request(ORIGIN + path, init), env, ctx);
  await Promise.all(ctx.jobs);
  return res;
}
async function call(action, payload, token) {
  const r = await req('/api', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, payload, token }) });
  return r.json();
}
async function ok(action, payload, token) {
  const r = await call(action, payload, token);
  if (!r.ok) throw new Error(action + ' failed: ' + r.error);
  return r.data;
}
async function fails(action, payload, token, re) {
  const r = await call(action, payload, token);
  assert.equal(r.ok, false, action + ' should fail');
  if (re) assert.match(r.error, re);
  return r;
}
async function test(name, fn) { await fn(); passed++; console.log('  ✓ ' + name); }
const admin = (o) => fetchJson(o, { authorization: 'Bearer ' + KEY });
async function fetchJson(o, headers) {
  const r = await req(o.path, { method: o.method || 'GET', headers: Object.assign({ 'content-type': 'application/json' }, headers || {}), body: o.body ? JSON.stringify(o.body) : undefined });
  return { status: r.status, body: await r.json() };
}

// A tiny real JPEG and PNG (1×1 px)
const JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const SAMPLE = {
  Settings: [
    { Key: 'Business Name', Value: 'SAF Rentals', Notes: '' }, { Key: 'Reserve %', Value: 10, Notes: '' },
    { Key: 'Late Grace Hours', Value: 2 }, { Key: 'Expiry Warning Days', Value: 30 }
  ],
  Partners: [
    { Partner: 'SUHAIB', Email: 's@example.com', Role: 'Admin', Active: true, PIN: '1111', 'Telegram Alerts': 'All' },
    { Partner: 'ANEES', Email: 'a@example.com', Role: 'Partner', Active: true, PIN: 2222 },
    { Partner: 'FIROS', Email: 'f@example.com', Role: 'Partner', Active: true, PIN: '' }
  ],
  Vehicles: [{ 'Vehicle ID': 'V1abcd', Name: 'Swift White', 'Reg No': 'KL 10 AB 1234', 'Purchase Price': 600000, Status: 'Active', Photo: 'DriveFileId_123456789' }],
  Investments: [{ 'Investment ID': 'i1', 'Vehicle ID': 'V1abcd', Partner: 'SUHAIB', Amount: 200000 }],
  Customers: [{ 'Customer ID': 'c1', Name: 'Ajmal K', Mobile: '+91 98470 11223', Blocked: false, 'Created At': '2026-09-01T10:00' }],
  Trips: [{ 'Trip ID': 't-old-1', 'Vehicle ID': 'V1abcd', 'Customer ID': 'c1', 'Customer Name': 'Ajmal K', Status: 'Returned', 'Out At': '2026-09-01T10:00', 'In At': '2026-09-03T10:00', 'Rate Per Day': 1500, Days: 2, 'Bill Total': 3000, Paid: 3000, Balance: 0 }],
  Payments: [{ 'Payment ID': 'p1', Date: '2026-09-03T10:00', 'Trip ID': 't-old-1', 'Vehicle ID': 'V1abcd', 'Customer Name': 'Ajmal K', Type: 'Rent', Amount: 3000, Mode: 'Cash', 'Received By': 'SUHAIB' }],
  Expenses: [], Dividends: [], Transfers: [], Documents: [{ 'Document ID': 'd1', 'Vehicle ID': 'V1abcd', Item: 'Insurance', 'Expiry Date': '2026-11-01T00:00' }],
  Sales: [], Enquiries: [], Activity: [{ Time: '2026-09-03T10:00', User: 'SUHAIB', Action: 'Checked in', Details: 'Ajmal K · bill 3000' }]
};

console.log('SAF Rental worker tests');

await test('first request creates the database with default settings', async () => {
  const names = await ok('partnerNames');
  assert.deepEqual(names, []);
  const rows = env.DB.d.prepare('SELECT "Key", "Value" FROM "Settings"').all();
  assert.ok(rows.some((r) => r.Key === 'Reserve %' && r.Value === 10));
});

await test('import needs the sync key', async () => {
  const r = await fetchJson({ path: '/api/admin/import', method: 'POST', body: { tables: SAMPLE } }, { authorization: 'Bearer wrong' });
  assert.equal(r.status, 401);
});

await test('one-time import of the sheet data', async () => {
  const r = await admin({ path: '/api/admin/import', method: 'POST', body: { tables: SAMPLE, kv: { TG_BOT: 'saf_bot' } } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.counts.Trips, 1);
  assert.deepEqual(await ok('partnerNames'), ['SUHAIB', 'ANEES', 'FIROS']);
});

await test('a second import is refused, so live data is never overwritten', async () => {
  const r = await admin({ path: '/api/admin/import', method: 'POST', body: { tables: SAMPLE } });
  assert.equal(r.status, 409);
});

let A, P;
await test('sign in: wrong PIN is counted, right PIN works, numeric PINs from the sheet work', async () => {
  await fails('login', { partner: 'SUHAIB', pin: '9999' }, '', /Wrong PIN/);
  await fails('login', { partner: 'FIROS', pin: '1234' }, '', /No PIN is set/);
  A = (await ok('login', { partner: 'suhaib', pin: '1111' })).token;
  P = (await ok('login', { partner: 'ANEES', pin: '2222' })).token;
  assert.ok(A && P);
  await fails('bootstrap', {}, 'not-a-token', /Please sign in/);
});

await test('bootstrap hides PINs and Telegram chat ids', async () => {
  const b = await ok('bootstrap', {}, A);
  assert.equal(b.user.role, 'Admin');
  const s = b.tables.Partners.find((p) => p.Partner === 'SUHAIB');
  assert.equal(s.PIN, undefined); assert.equal(s.hasPin, true);
  assert.equal(b.tables.Partners.find((p) => p.Partner === 'FIROS').hasPin, false);
  assert.equal(b.tables.Trips[0]['Out At'], '2026-09-01T10:00');
  assert.equal(b.tables.Trips[0]['Bill Total'], 3000);
  assert.equal(b.tables.Customers[0].Blocked, false);
  assert.equal(b.tables.Documents[0]['Expiry Date'], '2026-11-01T00:00');
  assert.equal(b.tables.Activity.length, 1);
  assert.ok(b.appVersion);
});

let tripId;
await test('check-out with photos, ID proof, signature and an advance', async () => {
  const r = await ok('checkOut', { tripId: 'tripA123', vehicleId: 'V1abcd', customerName: 'Nithin Raj', mobile: '9446033445', outAt: '2026-10-24T09:00', expectedReturn: '2026-10-26T09:00',
    startOdo: 12000, fuelOut: 'F', rate: 1800, deposit: 5000, advance: 1000, advanceMode: 'UPI/Bank', photos: [JPG, JPG], idProof: JPG, signature: PNG }, P);
  tripId = r.tripId; assert.equal(tripId, 'tripA123');
  const b = await ok('bootstrap', {}, P);
  const t = b.tables.Trips.find((x) => x['Trip ID'] === tripId);
  assert.equal(t.Status, 'Out'); assert.equal(t.Paid, 1000); assert.equal(t['Deposit Held By'], 'ANEES');
  assert.equal(t['Out Photos'].split(',').length, 2);
  assert.ok(t.Signature && t['ID Proof']);
  assert.equal(env.FILES.m.size, 4);
  assert.ok(b.tables.Customers.find((c) => c.Name === 'Nithin Raj'));
  assert.equal(b.tables.Payments.filter((p) => p['Trip ID'] === tripId).length, 1);
});

await test('the same car cannot go out twice, or clash with a booking', async () => {
  await fails('checkOut', { vehicleId: 'V1abcd', customerName: 'X' }, A, /already out/);
  await fails('book', { vehicleId: 'V1abcd', customerName: 'Y', from: '2026-10-25T09:00', to: '2026-10-27T09:00' }, A, /not free then/);
});

await test('photos come back as signed links that work, and fail when tampered', async () => {
  const b = await ok('bootstrap', {}, A);
  const t = b.tables.Trips.find((x) => x['Trip ID'] === tripId);
  const list = await ok('photos', { ids: t['Out Photos'].split(',') }, A);
  assert.equal(list.length, 2);
  const res = await req(list[0].src);
  assert.equal(res.status, 200); assert.equal(res.headers.get('content-type'), 'image/jpeg');
  const bad = await req(list[0].src.replace(/s=[^&]+/, 's=AAAA'));
  assert.equal(bad.status, 403);
  const full = await ok('photos', { ids: [t.Signature], full: true }, A);
  assert.match(full[0].src, /v=full/);
  assert.equal((await req(full[0].src)).headers.get('content-type'), 'image/png');
});

await test('check-in makes the bill and records payments', async () => {
  await ok('checkIn', { tripId, inAt: '2026-10-26T10:00', endOdo: 12450, fuelIn: '¾', days: 2, rate: 1800, lateFee: 200, paidNow: 2000, mode: 'Cash', depositDeducted: 400, depositRefunded: 4600, rating: 'Good' }, P);
  const t = (await ok('bootstrap', {}, A)).tables.Trips.find((x) => x['Trip ID'] === tripId);
  assert.equal(t.Status, 'Returned'); assert.equal(t['Bill Total'], 3800); assert.equal(t.Paid, 3400); assert.equal(t.Balance, 400); assert.equal(t['Km Driven'], 450);
  await fails('checkIn', { tripId }, P, /already checked in/);
});

await test('fines, payments and balance', async () => {
  await ok('addCharge', { tripId, kind: 'Fine', amount: 500, note: 'Overspeed' }, P);
  await ok('addPayment', { tripId, amount: 900, mode: 'UPI/Bank' }, P);
  const t = (await ok('bootstrap', {}, A)).tables.Trips.find((x) => x['Trip ID'] === tripId);
  assert.equal(t['Bill Total'], 4300); assert.equal(t.Paid, 4300); assert.equal(t.Balance, 0); assert.match(t['Fine Notes'], /Overspeed 500/);
});

await test('partners can add expenses but saved entries are locked; only the admin edits and deletes', async () => {
  const e = await ok('save', { table: 'Expenses', record: { Date: '2026-10-24', 'Vehicle ID': 'V1abcd', Type: 'Washing', Amount: '300', 'Paid By': 'ANEES', Mode: 'Cash' } }, P);
  assert.equal(e['Created By'], 'ANEES');
  await fails('save', { table: 'Expenses', record: Object.assign({}, e, { Amount: 999 }) }, P, /locked/);
  await fails('save', { table: 'Vehicles', record: { Name: 'New car' } }, P, /Only the admin/);
  await fails('remove', { table: 'Expenses', id: e['Expense ID'] }, P, /Only the admin/);
  const ed = await ok('save', { table: 'Expenses', record: Object.assign({}, e, { Amount: 350 }) }, A);
  assert.equal(ed.Amount, 350);
  await ok('remove', { table: 'Expenses', id: e['Expense ID'] }, A);
  await fails('remove', { table: 'Expenses', id: e['Expense ID'] }, A, /Already deleted/);
});

await test('bookings: make, change (admin), cancel with refund', async () => {
  const b = await ok('book', { vehicleId: 'V1abcd', customerName: 'Arun P', mobile: '9633099001', from: '2026-11-02T09:00', to: '2026-11-04T09:00', rate: 1700, advance: 2000 }, P);
  await fails('book', { tripId: b.tripId, vehicleId: 'V1abcd', customerName: 'Arun P', from: '2026-11-02T09:00', to: '2026-11-05T09:00' }, P, /Only the admin/);
  await ok('book', { tripId: b.tripId, vehicleId: 'V1abcd', customerName: 'Arun P', from: '2026-11-02T09:00', to: '2026-11-05T09:00', rate: 1700 }, A);
  await fails('cancelBooking', { tripId: b.tripId, refund: 5000 }, A, /more than/);
  await ok('cancelBooking', { tripId: b.tripId, refund: 1500, reason: 'Plans changed' }, A);
  const t = (await ok('bootstrap', {}, A)).tables.Trips.find((x) => x['Trip ID'] === b.tripId);
  assert.equal(t.Status, 'Cancelled'); assert.equal(t.Paid, 500); assert.equal(t['Bill Total'], 500); assert.equal(t.Balance, 0);
  assert.equal(t['Expected Return'], '2026-11-05T09:00');
});

await test('workshop out and back, with the bill saved as an expense', async () => {
  await ok('workshop', { vehicleId: 'V1abcd', on: true, notes: 'Brake pads', since: '2026-10-27' }, A);
  await fails('checkOut', { vehicleId: 'V1abcd', customerName: 'Z' }, A, /workshop/);
  await ok('workshop', { vehicleId: 'V1abcd', on: false, cost: 2400, paidBy: 'SUHAIB' }, A);
  const b = await ok('bootstrap', {}, A);
  assert.equal(b.tables.Vehicles[0].Status, 'Active');
  assert.ok(b.tables.Expenses.find((x) => x.Amount === 2400 && /Brake pads/.test(x.Description)));
});

await test('enquiries: partners can add and update', async () => {
  const e = await ok('save', { table: 'Enquiries', record: { Name: 'Haris P', Mobile: '9037044556', 'Wanted From': '2026-11-10', Source: 'Instagram' } }, P);
  assert.equal(e.Status, 'New');
  const u = await ok('save', { table: 'Enquiries', record: { 'Enquiry ID': e['Enquiry ID'], Status: 'Contacted' } }, P);
  assert.equal(u.Status, 'Contacted'); assert.equal(u.Name, 'Haris P'); assert.equal(u['Wanted From'], '2026-11-10T00:00');
});

await test('admin manages partners and PINs; PINs never come back to the page', async () => {
  const s = await ok('save', { table: 'Partners', record: { Partner: 'FIROS', PIN: '4321' } }, A);
  assert.equal(s.PIN, undefined);
  await fails('save', { table: 'Partners', record: { Partner: 'SUHAIB', Role: 'Partner' } }, A, /own admin/);
  await fails('save', { table: 'Partners', record: { Partner: 'FIROS', PIN: '12' } }, A, /4 to 8 digits/);
  await ok('changePin', { oldPin: '2222', newPin: '5555' }, P);
  await fails('login', { partner: 'ANEES', pin: '2222' }, '', /Wrong PIN/);
  P = (await ok('login', { partner: 'ANEES', pin: '5555' })).token;
});

await test('five wrong PINs lock sign-in for 15 minutes', async () => {
  for (let i = 0; i < 5; i++) await call('login', { partner: 'FIROS', pin: '0000' });
  await fails('login', { partner: 'FIROS', pin: '4321' }, '', /Too many wrong PINs/);
});

let docUrl;
await test('PDF made on the phone is kept and shared by link; a new agreement replaces the old one', async () => {
  const pdf = Buffer.from('%PDF-1.7\n% test\n').toString('base64');
  const r = await ok('makePdf', { kind: 'agreement', tripId, name: 'Rental agreement Nithin Raj 2026-10-24', pdf }, P);
  assert.match(r.url, /^https:\/\/saf-rental\.example\.workers\.dev\/doc\//);
  docUrl = r.url;
  const d = await req(r.url.replace(ORIGIN, ''));
  assert.equal(d.status, 200); assert.equal(d.headers.get('content-type'), 'application/pdf');
  const before = env.FILES.m.size;
  const r2 = await ok('makePdf', { kind: 'agreement', tripId, name: 'Rental agreement again', pdf }, P);
  assert.equal(env.FILES.m.size, before, 'old agreement removed');
  assert.equal((await req(r.url.replace(ORIGIN, ''))).status, 404);
  assert.equal((await req(r2.url.replace(ORIGIN, ''))).status, 200);
  await fails('makePdf', { kind: 'statement', name: 'x', pdf: 'bm90IGEgcGRm' }, P, /could not be made/);
});

await test('two partners saving at the same moment: both saves are kept', async () => {
  env.DB.delay = 15;
  const rs = await Promise.all([1, 2, 3, 4].map((i) => call('save', { table: 'Expenses', record: { Date: '2026-10-25', Type: 'Fuel', Amount: 100 * i, 'Paid By': 'ANEES' } }, i % 2 ? P : A)));
  env.DB.delay = 0;
  rs.forEach((r) => assert.equal(r.ok, true, r.error));
  const exps = (await ok('bootstrap', {}, A)).tables.Expenses.filter((x) => x.Date === '2026-10-25T00:00');
  assert.equal(exps.length, 4);
});

await test('a failed action saves nothing (no half-saved trips)', async () => {
  const before = (await ok('bootstrap', {}, A)).tables.Customers.length;
  // A blocked customer: the photo is taken and the customer updated, then refused — nothing must remain.
  await ok('save', { table: 'Customers', record: { 'Customer ID': 'cblk', Name: 'Bad Customer', Blocked: true } }, A);
  const n1 = (await ok('bootstrap', {}, A)).tables.Customers.length;
  const files = env.FILES.m.size;
  await fails('checkOut', { vehicleId: 'V1abcd', customerName: 'Bad Customer', customerId: 'cblk', idProof: JPG }, A, /do not rent/);
  assert.equal(env.FILES.m.size, files, 'no photo stored');
  const after = await ok('bootstrap', {}, A);
  assert.equal(after.tables.Customers.length, n1);
  assert.equal(after.tables.Customers.find((c) => c['Customer ID'] === 'cblk')['ID Proof'], '');
  assert.ok(n1 === before + 1);
  assert.equal(after.tables.Trips.filter((t) => t.Status === 'Out').length, 0);
});

await test('sheet report: full data with the sync key, "unchanged" when nothing changed', async () => {
  const r = await admin({ path: '/api/report?revision=-1' });
  assert.equal(r.status, 200);
  assert.equal(r.body.format, 'saf-rental-report-v1');
  assert.ok(r.body.tables.Activity.length > 10);
  assert.equal(r.body.tables.Partners.find((p) => p.Partner === 'FIROS').PIN, '4321');
  const again = await admin({ path: '/api/report?revision=' + r.body.revision });
  assert.equal(again.body.unchanged, true);
  assert.equal((await fetchJson({ path: '/api/report' })).status, 401);
});

await test('old Drive photos can be uploaded once and listed', async () => {
  const r = await req('/api/admin/file/DriveFileId_123456789?kind=full&type=image/jpeg&name=car.jpg', { method: 'PUT', headers: { authorization: 'Bearer ' + KEY }, body: Buffer.from(JPG.split(',')[1], 'base64') });
  assert.equal(r.status, 200);
  const s = await admin({ path: '/api/admin/stored' });
  assert.ok(s.body.ids.includes('DriveFileId_123456789'));
  const list = await ok('photos', { ids: ['DriveFileId_123456789'] }, A);
  assert.equal((await req(list[0].src)).status, 200);
});

await test('each request stays inside the free-plan database query limit', async () => {
  env.DB.count = 0;
  await ok('checkOut', { vehicleId: 'V1abcd', customerName: 'Count Test', advance: 500, photos: [JPG] }, A);
  assert.ok(env.DB.count <= 30, 'queries used: ' + env.DB.count);
});

await test('signing out ends the session', async () => {
  await ok('logout', {}, P);
  await fails('bootstrap', {}, P, /Please sign in/);
});

await test('the page and install files are served', async () => {
  const r = await req('/');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /google = \{ script: \{ run: new Runner\(\) \} \}/);
  assert.equal(r.headers.get('cache-control'), 'no-cache');
  assert.equal((await req('/manifest.webmanifest')).status, 200);
  assert.equal((await req('/vendor/pdf-lib.min.js')).status, 200);
});

console.log(passed + ' tests passed');
