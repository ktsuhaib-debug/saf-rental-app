// Local server for trying the app in a browser: node tests/serve.mjs [port]
// Uses the stand-ins in fake-env.mjs and fills them with sample data (no real data).
import http from 'node:http';
import worker from '../src/worker.mjs';
import { makeEnv, execCtx } from './fake-env.mjs';

const port = Number(process.argv[2] || 8787);
const env = makeEnv();
const ORIGIN = 'http://localhost:' + port;

async function handle(req, res) {
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const request = new Request(ORIGIN + req.url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
  const ctx = execCtx();
  const out = await worker.fetch(request, env, ctx);
  res.writeHead(out.status, Object.fromEntries(out.headers));
  res.end(Buffer.from(await out.arrayBuffer()));
  await Promise.all(ctx.jobs);
}

const today = new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10);
const SAMPLE = {
  Settings: [{ Key: 'Business Name', Value: 'SAF Rentals' }, { Key: 'Reserve %', Value: 10 }, { Key: 'Late Grace Hours', Value: 2 }, { Key: 'Km Per Day Limit', Value: 0 }, { Key: 'Extra Km Rate', Value: 0 }, { Key: 'Expiry Warning Days', Value: 30 }, { Key: 'Business Phone', Value: '+91 90000 00000' }, { Key: 'Business Address', Value: 'Kochi, Kerala' }],
  Partners: [{ Partner: 'SUHAIB', Role: 'Admin', Active: true, PIN: '1111' }, { Partner: 'ANEES', Role: 'Partner', Active: true, PIN: '2222' }, { Partner: 'FIROS', Role: 'Partner', Active: true, PIN: '3333' }],
  Vehicles: [{ 'Vehicle ID': 'V1abcd', Name: 'Swift White', 'Reg No': 'KL 10 AB 1234', 'Purchase Price': 600000, 'Extra Costs': 30000, Status: 'Active' }],
  Investments: [{ 'Investment ID': 'i1', 'Vehicle ID': 'V1abcd', Partner: 'SUHAIB', Amount: 210000 }, { 'Investment ID': 'i2', 'Vehicle ID': 'V1abcd', Partner: 'ANEES', Amount: 210000 }, { 'Investment ID': 'i3', 'Vehicle ID': 'V1abcd', Partner: 'FIROS', Amount: 210000 }],
  Customers: [{ 'Customer ID': 'c1', Name: 'Ajmal K', Mobile: '+91 98470 11223', Blocked: false }],
  Trips: [{ 'Trip ID': 'told1', 'Vehicle ID': 'V1abcd', 'Customer ID': 'c1', 'Customer Name': 'Ajmal K', Mobile: '+91 98470 11223', Status: 'Returned', 'Out At': today.slice(0, 8) + '02T10:00', 'In At': today.slice(0, 8) + '04T10:00', 'Start Odometer': 11000, 'End Odometer': 11420, 'Km Driven': 420, 'Rate Per Day': 1500, Days: 2, 'Bill Total': 3000, Paid: 3000, Balance: 0, 'Created By': 'SUHAIB' }],
  Payments: [{ 'Payment ID': 'p1', Date: today.slice(0, 8) + '04T10:00', 'Trip ID': 'told1', 'Vehicle ID': 'V1abcd', 'Customer Name': 'Ajmal K', Type: 'Rent', Amount: 3000, Mode: 'Cash', 'Received By': 'SUHAIB' }],
  Expenses: [{ 'Expense ID': 'e1', Date: today.slice(0, 8) + '05', 'Vehicle ID': 'V1abcd', Type: 'Washing', Amount: 300, 'Paid By': 'ANEES', Mode: 'Cash' }],
  Dividends: [], Transfers: [], Documents: [], Sales: [], Enquiries: [], Activity: []
};

http.createServer((req, res) => handle(req, res).catch((e) => { console.error(e); res.writeHead(500); res.end(String(e)); })).listen(port, async () => {
  if (process.env.EMPTY) return console.log('Empty database · ' + ORIGIN + ' · sync key ' + env.SYNC_KEY);
  const r = await worker.fetch(new Request(ORIGIN + '/api/admin/import', { method: 'POST', headers: { authorization: 'Bearer ' + env.SYNC_KEY }, body: JSON.stringify({ tables: SAMPLE }) }), env, execCtx());
  console.log('Sample data:', (await r.json()).ok ? 'loaded' : 'failed', '· open ' + ORIGIN + ' · PINs 1111 / 2222 / 3333');
});
