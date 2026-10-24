/**
 * SAF Rental — server rules, ported from the Apps Script version (app/Code.gs) to Cloudflare.
 *
 * The functions keep their old names and read almost line for line like the original, so a change
 * made in one is easy to carry to the other. What changed underneath:
 *   sheet tabs → D1 tables (store.mjs), Drive photos and PDFs → R2, Script Properties and the
 *   script cache → a small key/value table, Telegram calls → fetch (sent after the save succeeds).
 */
import { SCHEMA } from './schema.mjs';
import { recentActivity } from './store.mjs';

export const APP_NAME = 'Rental Hub';
// Shown under Partners → Team and settings. Keep it equal to app/version.json.
export const APP_VERSION = '2026-10-24.2';

const TZ_OFFSET_MIN = 330; // Asia/Kolkata, as in the Apps Script project. India has no daylight saving.
const SESSION_DAYS = 30;

/** Format a moment in India time. Patterns used by the old code only. */
export function fmt(date, pattern) {
  const d = new Date(date.getTime() + TZ_OFFSET_MIN * 60000), p = (n) => String(n).padStart(2, '0');
  const parts = { yyyy: String(d.getUTCFullYear()), MM: p(d.getUTCMonth() + 1), dd: p(d.getUTCDate()), HH: p(d.getUTCHours()), mm: p(d.getUTCMinutes()), EEE: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getUTCDay()] };
  return pattern.replace(/yyyy|MM|dd|HH|mm|EEE|'T'/g, (k) => (k === "'T'" ? 'T' : parts[k]));
}

function httpError(msg, code) { const e = new Error(msg); if (code) e.code = code; return e; }

/**
 * Everything for one request. ctx: { store, env, db, origin, uploads: [], deletes: [], after: [] }
 * - uploads: files to put in R2 before the database save
 * - deletes: R2 files to remove after the save
 * - after: async jobs (Telegram) to run after the save succeeds
 */
export function makeApp(ctx) {
  const S = ctx.store;

  /* ------------------------------------------------------------------ */
  /* Helpers that replace the sheet functions                            */
  /* ------------------------------------------------------------------ */
  function readTable_(name) { return S.read(name); }
  function appendRows_(name, objs) { S.append(name, objs); }
  function updateRow_(name, id, patch) { return S.update(name, id, patch); }
  function getRow_(name, id) { return S.find(name, id); }
  function newId_() { return crypto.randomUUID().replace(/-/g, '').slice(0, 8); }
  function nowIso_() { return fmt(new Date(), "yyyy-MM-dd'T'HH:mm"); }
  function num_(v) { const n = Number(v); return isNaN(n) ? 0 : n; }
  function log_(user, action, details) { S.log({ 'Time': nowIso_(), 'User': user.partner || user.email, 'Action': action, 'Details': details }); }
  function settings_() { const o = {}; readTable_('Settings').forEach((r) => { o[r['Key']] = r['Value']; }); return o; }

  /* ------------------------------------------------------------------ */
  /* Users                                                               */
  /* ------------------------------------------------------------------ */
  function partnerRow_(name) {
    return readTable_('Partners').filter((r) => String(r['Partner']).toUpperCase() === String(name || '').toUpperCase())[0] || null;
  }
  function partnerNames_() {
    return readTable_('Partners').filter((r) => r['Active'] !== false).map((r) => r['Partner']);
  }

  function login_(p) {
    const name = String(p.partner || '').toUpperCase(), pin = String(p.pin || '').trim();
    if (!name || !pin) throw new Error('Choose your name and enter your PIN.');
    const key = 'fails_' + name;
    const fails = Number(S.kvGet(key) || 0);
    if (fails >= 5) throw new Error('Too many wrong PINs. Try again in 15 minutes.');
    const row = partnerRow_(name);
    if (!row || row['Active'] === false) throw new Error('That partner is not active.');
    const saved = String(row['PIN'] || '').trim();
    if (!saved) throw new Error('No PIN is set for ' + row['Partner'] + ' yet. Ask the admin to set one in the app: Partners → Team and settings.');
    if (saved !== pin) {
      S.kvSet(key, String(fails + 1), 900);
      // The wrong try must be saved even though sign-in fails.
      const err = new Error('Wrong PIN.' + (fails + 1 >= 3 ? ' ' + (5 - fails - 1) + ' tries left.' : ''));
      err.commitAnyway = true;
      throw err;
    }
    if (S.kvGet(key)) S.kvDel(key);
    const token = crypto.randomUUID() + crypto.randomUUID().slice(0, 8);
    S.kvSet('session_' + token, JSON.stringify({ partner: row['Partner'], exp: Date.now() + SESSION_DAYS * 864e5 }), SESSION_DAYS * 86400);
    return { token: token, partner: row['Partner'] };
  }

  function userFromToken_(token) {
    if (!token) return null;
    const raw = S.kvGet('session_' + token);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (s.exp < Date.now()) { S.kvDel('session_' + token); return null; }
    const row = partnerRow_(s.partner);
    if (!row || row['Active'] === false) return null;
    return { partner: row['Partner'], role: row['Role'] || 'Partner', email: row['Email'] || '' };
  }

  function changePin_(p, user) {
    const row = partnerRow_(user.partner);
    if (String(row['PIN'] || '').trim() !== String(p.oldPin || '').trim()) throw new Error('Your current PIN is not right.');
    const pin = String(p.newPin || '').trim();
    if (!/^\d{4,8}$/.test(pin)) throw new Error('Use 4 to 8 digits for the new PIN.');
    updateRow_('Partners', row['Partner'], { 'PIN': pin });
    log_(user, 'Changed PIN', '');
    return true;
  }

  function adminName_() {
    const a = readTable_('Partners').filter((r) => r['Role'] === 'Admin' && r['Active'] !== false)[0];
    return a ? a['Partner'] : 'the admin';
  }
  function requireAdmin_(user, msg) {
    if (user.role === 'Admin') return;
    let name = String(adminName_()); name = name.charAt(0) + name.slice(1).toLowerCase();
    throw new Error((msg || 'Only the admin can do this.') + ' Ask ' + name + '.');
  }

  /* ------------------------------------------------------------------ */
  /* Photos and files (R2)                                               */
  /* ------------------------------------------------------------------ */
  function newFileId_() { return crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '').slice(0, 8); }

  /** dataUrl → stored file id. Accepts an existing file id unchanged. */
  function savePhoto_(dataUrl, name) {
    if (!dataUrl) return '';
    if (String(dataUrl).indexOf('data:') !== 0) return String(dataUrl);
    const m = String(dataUrl).match(/^data:(image\/[a-z+]+);base64,(.*)$/);
    if (!m) throw new Error('A photo could not be read. Try taking it again.');
    const id = newFileId_();
    ctx.uploads.push({ id: id, b64: m[2], type: m[1], name: name + (m[1] === 'image/png' ? '.png' : '.jpg') });
    return id;
  }
  function savePhotos_(list, prefix) {
    return (list || []).map((d, i) => savePhoto_(d, prefix + '-' + (i + 1))).filter(String).join(',');
  }

  /** Short-lived links to the photos. Default is the small preview (if there is one); full: true sends the original. */
  async function photos_(ids, full) {
    return Promise.all(ids.slice(0, 12).map(async (id) => ({ id: id, src: await ctx.fileUrl(String(id), full ? 'full' : 'thumb') })));
  }

  /* ------------------------------------------------------------------ */
  /* Bootstrap: everything the page needs in one call                    */
  /* ------------------------------------------------------------------ */
  async function bootstrap_(user) {
    const tables = {};
    Object.keys(SCHEMA).forEach((name) => { if (name !== 'Activity') tables[name] = readTable_(name); });
    tables.Partners = tables.Partners.map((r) => { const o = {}; Object.keys(r).forEach((k) => { if (k !== 'PIN' && k !== 'Telegram Chat ID') o[k] = r[k]; }); o.hasPin = !!String(r['PIN'] || '').trim(); o.hasTelegram = !!String(r['Telegram Chat ID'] || '').replace(/^'/, ''); return o; });
    tables.Activity = await recentActivity(ctx.db, 60);
    return { user: user, tables: tables, serverTime: nowIso_(), appVersion: APP_VERSION };
  }

  /* ------------------------------------------------------------------ */
  /* Trips                                                               */
  /* ------------------------------------------------------------------ */
  function checkOut_(p, user) {
    if (!p.vehicleId) throw new Error('Choose a vehicle.');
    if (!p.customerName) throw new Error('Enter the customer name.');
    const busy = readTable_('Trips').some((t) => t['Vehicle ID'] === p.vehicleId && t['Status'] === 'Out');
    if (busy) throw new Error('This vehicle is already out on a trip. Check it in first.');
    if ((getRow_('Vehicles', p.vehicleId) || {})['Status'] === 'Workshop') throw new Error('This car is in the workshop. Mark it back from the workshop first.');

    const booking = p.bookingId ? getRow_('Trips', p.bookingId) : null;
    if (p.bookingId && (!booking || booking['Status'] !== 'Booked')) throw new Error('This booking was cancelled or already started.');
    if (p.expectedReturn) {
      const clash = clashes_(p.vehicleId, p.outAt || nowIso_(), p.expectedReturn, p.bookingId).filter((t) => t['Status'] === 'Booked');
      if (clash.length) throw new Error('This car is booked by ' + clash[0]['Customer Name'] + ' from ' + String(clash[0]['Out At']).slice(0, 10) + '. Choose an earlier return date or another car.');
    }
    // The app sends its own id so it can make the rental agreement straight after check-out.
    const tripId = booking ? booking['Trip ID'] : (/^[A-Za-z0-9]{6,16}$/.test(String(p.tripId || '')) && !getRow_('Trips', p.tripId) ? String(p.tripId) : newId_());
    const customer = upsertCustomer_(p, tripId);
    if (customer['Blocked'] === true) throw new Error(customer['Name'] + ' is marked "do not rent".');

    const trip = {
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

  /* Bookings: a trip row with Status "Booked" until the car is handed over */
  function msOf_(iso) {
    const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
    return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0)) : NaN;
  }

  /** Trips and bookings for this car that overlap [from, to). An open trip with no return date blocks everything after it starts. */
  function clashes_(vehicleId, fromIso, toIso, ignoreId) {
    const a = msOf_(fromIso), b = msOf_(toIso);
    return readTable_('Trips').filter((t) => {
      if (t['Vehicle ID'] !== vehicleId || String(t['Trip ID']) === String(ignoreId || '')) return false;
      if (t['Status'] !== 'Booked' && t['Status'] !== 'Out') return false;
      const s = msOf_(t['Out At']); let e = msOf_(t['Expected Return']);
      if (isNaN(e)) e = t['Status'] === 'Out' ? Infinity : s + 864e5;
      return s < b && a < e;
    });
  }

  function book_(p, user) {
    if (!p.vehicleId) throw new Error('Choose a car.');
    if (!p.customerName) throw new Error('Enter the customer name.');
    if (!p.from || !p.to) throw new Error('Enter the pickup and return dates.');
    if (msOf_(p.to) <= msOf_(p.from)) throw new Error('The return date must be after the pickup date.');
    const clash = clashes_(p.vehicleId, p.from, p.to, p.tripId);
    if (clash.length) {
      const c = clash[0];
      throw new Error('This car is not free then: ' + c['Customer Name'] + (c['Status'] === 'Out' ? ' has it now' : ' booked it') + ' from ' + String(c['Out At']).slice(0, 10) + (c['Expected Return'] ? ' to ' + String(c['Expected Return']).slice(0, 10) : '') + '.');
    }
    if (p.tripId) {
      requireAdmin_(user, 'Only the admin can change a booking.');
      const old = getRow_('Trips', p.tripId);
      if (!old || old['Status'] !== 'Booked') throw new Error('Only bookings that have not started can be changed here.');
      updateRow_('Trips', p.tripId, { 'Vehicle ID': p.vehicleId, 'Customer Name': p.customerName, 'Mobile': p.mobile, 'Out At': p.from, 'Expected Return': p.to, 'Rate Per Day': p.rate, 'Notes': p.notes, 'Updated At': nowIso_() });
      log_(user, 'Changed booking', p.customerName + ' · ' + String(p.from).slice(0, 10));
      return { tripId: p.tripId };
    }
    const tripId = newId_();
    const customer = upsertCustomer_(p, tripId);
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
    const t = getRow_('Trips', p.tripId);
    if (!t || t['Status'] !== 'Booked') throw new Error('Only bookings that have not started can be cancelled.');
    const refund = num_(p.refund);
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
    const idProof = p.idProof ? savePhoto_(p.idProof, tripId + '.id-proof') : '';
    if (p.customerId) {
      const existing = getRow_('Customers', p.customerId);
      if (existing) {
        const patch = {};
        if (idProof) patch['ID Proof'] = idProof;
        if (p.mobile && p.mobile !== existing['Mobile']) patch['Mobile'] = p.mobile;
        return Object.keys(patch).length ? updateRow_('Customers', p.customerId, patch) : existing;
      }
    }
    const c = {
      'Customer ID': newId_(), 'Name': p.customerName, 'Mobile': p.mobile, 'ID Proof': idProof,
      'Notes': '', 'Blocked': false, 'Created At': nowIso_()
    };
    appendRows_('Customers', [c]);
    return c;
  }

  function checkIn_(p, user) {
    const trip = getRow_('Trips', p.tripId);
    if (!trip) throw new Error('Trip not found.');
    if (trip['Status'] !== 'Out') throw new Error('This trip is already checked in.');
    const end = num_(p.endOdo), start = num_(trip['Start Odometer']);
    if (p.endOdo !== '' && p.endOdo !== undefined && end < start) throw new Error('End odometer is lower than the start reading (' + start + ').');

    const bill = num_(p.days) * num_(p.rate) + num_(p.extraKmCharge) + num_(p.lateFee) + num_(p.fuelCharge) + num_(p.damageCharge) + num_(p.tollCharge) + num_(p.fineCharge) - num_(p.discount);
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

    const pays = [];
    if (num_(p.paidNow) > 0) pays.push({ type: 'Rent', amount: p.paidNow, mode: p.mode, by: p.receivedBy || user.partner });
    if (num_(p.depositDeducted) > 0) pays.push({ type: 'From Deposit', amount: p.depositDeducted, mode: 'Deposit', by: trip['Deposit Held By'] });
    appendRows_('Payments', pays.map((x) => ({
      'Payment ID': newId_(), 'Date': p.inAt || nowIso_(), 'Trip ID': p.tripId, 'Vehicle ID': trip['Vehicle ID'],
      'Customer Name': trip['Customer Name'], 'Type': x.type, 'Amount': x.amount, 'Mode': x.mode,
      'Received By': x.by, 'Created By': user.partner
    })));
    recalcTrip_(p.tripId);
    log_(user, 'Checked in', trip['Customer Name'] + ' · bill ' + bill);
    return { tripId: p.tripId };
  }

  function addPayment_(p, user) {
    const trip = p.tripId ? getRow_('Trips', p.tripId) : null;
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
    const t = getRow_('Trips', p.tripId);
    if (!t) throw new Error('Trip not found.');
    if (t['Status'] !== 'Returned') throw new Error('Add fines and tolls at check-in while the trip is open.');
    const amt = num_(p.amount);
    if (!(amt > 0)) throw new Error('Enter an amount above zero.');
    const field = p.kind === 'Toll' ? 'Toll Charge' : 'Fine Charge';
    const patch = { 'Bill Total': num_(t['Bill Total']) + amt, 'Updated At': nowIso_() };
    patch[field] = num_(t[field]) + amt;
    if (p.kind !== 'Toll') patch['Fine Notes'] = [t['Fine Notes'], (p.note || 'Fine') + ' ' + amt].filter(String).join(' · ');
    updateRow_('Trips', t['Trip ID'], patch);
    recalcTrip_(t['Trip ID']);
    log_(user, p.kind === 'Toll' ? 'Added toll' : 'Added fine', t['Customer Name'] + ' · ' + amt + (p.note ? ' · ' + p.note : ''));
    return true;
  }

  /* Customer ratings */
  const RATINGS = ['Good', 'OK', 'Bad'];
  function rate_(p, user) {
    const trip = getRow_('Trips', p.tripId);
    if (!trip) throw new Error('Trip not found.');
    if (RATINGS.indexOf(p.rating) === -1 && p.rating !== '') throw new Error('Choose Good, OK or Bad.');
    updateRow_('Trips', p.tripId, { 'Rating': p.rating, 'Rating Note': p.note || '' });
    log_(user, 'Rated customer', trip['Customer Name'] + ' · ' + (p.rating || 'cleared'));
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* PDFs: rental agreements and monthly statements                      */
  /* The app makes the PDF on the phone; the server keeps it in R2 and   */
  /* gives back a link anyone with it can open (like a Drive link).      */
  /* ------------------------------------------------------------------ */
  function makePdf_(p, user) {
    const kind = p.kind === 'statement' ? 'statement' : 'agreement';
    const b64 = String(p.pdf || '');
    if (!b64 || b64.length > 14000000 || !/^JVBER/.test(b64)) throw new Error('The document could not be made.');
    const name = String(p.name || kind).replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 120);
    let trip = null;
    if (kind === 'agreement') {
      trip = getRow_('Trips', p.tripId);
      if (!trip) throw new Error('Trip not found.');
    }
    const id = newFileId_();
    ctx.uploads.push({ id: id, b64: b64, type: 'application/pdf', name: name + '.pdf' });
    if (trip) {
      if (trip['Agreement File']) ctx.deletes.push(String(trip['Agreement File']));
      updateRow_('Trips', trip['Trip ID'], { 'Agreement File': id });
    }
    log_(user, kind === 'agreement' ? 'Made rental agreement' : 'Made monthly statement', name);
    return { id: id, name: name + '.pdf', url: ctx.docUrl(id, name + '.pdf') };
  }

  /** Mark an enquiry as turned into a booking or trip. */
  function linkEnquiry_(enquiryId, tripId) {
    if (!enquiryId || !getRow_('Enquiries', enquiryId)) return;
    updateRow_('Enquiries', enquiryId, { 'Status': 'Booked', 'Trip ID': tripId, 'Updated At': nowIso_() });
  }

  /* Workshop: a car that is off the road for repair or service */
  function workshop_(p, user) {
    const v = getRow_('Vehicles', p.vehicleId);
    if (!v) throw new Error('Choose a car.');
    if (p.on) {
      if (v['Status'] === 'Sold') throw new Error('This car is sold.');
      const out = readTable_('Trips').some((t) => t['Vehicle ID'] === p.vehicleId && t['Status'] === 'Out');
      if (out) throw new Error('This car is out on a trip. Check it in first.');
      updateRow_('Vehicles', p.vehicleId, { 'Status': 'Workshop', 'Workshop Since': p.since || nowIso_().slice(0, 10), 'Workshop Until': p.until || '', 'Workshop Notes': p.notes || '' });
      log_(user, 'Sent to workshop', v['Name'] + (p.notes ? ' · ' + p.notes : ''));
      return true;
    }
    if (v['Status'] !== 'Workshop') throw new Error('This car is not in the workshop.');
    const what = [v['Workshop Notes'], p.notes].filter(String).join(' · ');
    updateRow_('Vehicles', p.vehicleId, { 'Status': 'Active', 'Workshop Since': '', 'Workshop Until': '', 'Workshop Notes': '' });
    if (num_(p.cost) > 0) {
      appendRows_('Expenses', [{ 'Expense ID': newId_(), 'Date': p.date || nowIso_().slice(0, 10), 'Vehicle ID': p.vehicleId, 'Type': p.costType || 'Service',
        'Description': 'Workshop' + (what ? ': ' + what : ''), 'Amount': p.cost, 'Paid By': p.paidBy || user.partner, 'Mode': p.mode || 'Cash', 'Created By': user.partner }]);
    }
    log_(user, 'Back from workshop', v['Name'] + (num_(p.cost) > 0 ? ' · ' + p.cost : ''));
    return true;
  }

  function recalcTrip_(tripId) {
    const trip = getRow_('Trips', tripId);
    if (!trip) return;
    const paid = readTable_('Payments')
      .filter((x) => String(x['Trip ID']) === String(tripId))
      .reduce((s, x) => s + num_(x['Amount']), 0);
    const patch = { 'Paid': paid };
    if (trip['Status'] === 'Cancelled') { patch['Bill Total'] = paid; patch['Balance'] = 0; }
    else if (trip['Bill Total'] !== '') patch['Balance'] = num_(trip['Bill Total']) - paid;
    updateRow_('Trips', tripId, patch);
  }

  /* ------------------------------------------------------------------ */
  /* Generic save / remove                                               */
  /* ------------------------------------------------------------------ */
  const LABELS = { Enquiries: 'enquiry', Expenses: 'expense', Payments: 'income', Dividends: 'dividend', Transfers: 'cash handover', Documents: 'document', Customers: 'customer', Vehicles: 'car', Investments: 'investment', Sales: 'car sale', Trips: 'trip', Partners: 'partner', Settings: 'setting' };
  const EDITABLE = ['Enquiries', 'Expenses', 'Dividends', 'Transfers', 'Documents', 'Customers', 'Vehicles', 'Investments', 'Sales', 'Payments', 'Trips'];
  const ADMIN_ONLY = ['Partners', 'Settings', 'Vehicles', 'Documents', 'Investments', 'Dividends', 'Sales', 'Customers', 'Trips'];
  // Partners may ADD rows to these lists; once saved, only the admin can change or delete them.
  const PARTNER_CAN_ADD = ['Expenses', 'Payments', 'Transfers', 'Dividends'];
  // Enquiries are day-to-day work: partners can add and update them.
  const PARTNER_CAN_EDIT = ['Enquiries'];
  const REMOVABLE = ['Enquiries', 'Expenses', 'Dividends', 'Transfers', 'Documents', 'Sales', 'Payments', 'Investments'];

  function save_(p, user) {
    const table = p.table, rec = p.record || {};
    if (EDITABLE.indexOf(table) === -1 && ADMIN_ONLY.indexOf(table) === -1) throw new Error('This list cannot be edited here.');
    const key = SCHEMA[table][0];
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
      // Telegram details are set through the Telegram screens only.
      delete rec['Telegram Chat ID'];
    }
    delete rec.hasPin; delete rec.hasTelegram;
    const rebill = rec._rebill === true; delete rec._rebill;
    let saved;
    const existing = rec[key] ? getRow_(table, rec[key]) : null;
    if (table === 'Trips' && rebill && existing) {
      const m = {}; Object.keys(existing).forEach((k) => { m[k] = existing[k]; }); Object.keys(rec).forEach((k) => { m[k] = rec[k]; });
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
    if (table === 'Partners') { const o = {}; Object.keys(saved).forEach((k) => { if (k !== 'PIN' && k !== 'Telegram Chat ID') o[k] = saved[k]; }); return o; }
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
    const old = getRow_(p.table, p.id);
    if (!old) throw new Error('Already deleted.');
    S.remove(p.table, p.id);
    log_(user, 'Deleted ' + LABELS[p.table], JSON.stringify(old));
    if (p.table === 'Payments' && old && old['Trip ID']) recalcTrip_(old['Trip ID']);
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Telegram alerts: the bot messages each partner privately            */
  /* ------------------------------------------------------------------ */
  const TG_ALERTS = ['All', 'Trips', 'Money', 'Off'];
  const TG_TRIPS = ['checkOut', 'book', 'cancelBooking', 'checkIn', 'workshop', 'enquiry'];

  function tgProp_(k, v) { if (v === undefined) return S.kvGet(k) || ''; if (v === null) S.kvDel(k); else S.kvSet(k, v); return v; }
  function h_(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function cap_(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(); }
  /** Indian grouping: 1,25,000 */
  function inr_(v) {
    const n = Math.round(num_(v)), neg = n < 0, s = String(Math.abs(n)); let last = s.slice(-3); const rest = s.slice(0, -3);
    if (rest) last = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + last;
    return (neg ? '-₹' : '₹') + last;
  }
  /** '2026-10-22T18:00' → '22/10/2026 18:00' */
  function dmy_(iso, withTime) {
    const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
    if (!m) return '';
    return m[3] + '/' + m[2] + '/' + m[1] + (withTime !== false && m[4] && !(m[4] === '00' && m[5] === '00') ? ' ' + m[4] + ':' + m[5] : '');
  }
  function carName_(id) { const v = id ? getRow_('Vehicles', id) : null; return v ? v['Name'] : (id ? id : 'General'); }

  async function tgApi_(method, payload, tokenOverride) {
    const token = tokenOverride || tgProp_('TG_TOKEN');
    if (!token) throw new Error('The Telegram bot is not set up yet.');
    let j = {};
    try {
      const r = await fetch('https://api.telegram.org/bot' + token + '/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload || {}) });
      j = await r.json();
    } catch (e) { j = {}; }
    if (!j.ok) throw httpError(j.description ? 'Telegram: ' + j.description : 'Telegram could not be reached.', 'TG');
    return j.result;
  }
  /** Send one message to several chats now. Never throws: an alert must not break a save. */
  async function tgSendNow_(chatIds, html, token) {
    token = token || tgProp_('TG_TOKEN'); if (!token || !chatIds.length) return 0;
    const results = await Promise.all(chatIds.map((id) => fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: id, text: html, parse_mode: 'HTML', disable_web_page_preview: true })
    }).then((r) => r.status === 200).catch(() => false)));
    return results.filter(Boolean).length;
  }
  /** Same, but after the save has gone through. */
  function tgSendMany_(chatIds, html) {
    const token = tgProp_('TG_TOKEN'); if (!token || !chatIds.length) return 0;
    ctx.after.push(() => tgSendNow_(chatIds, html, token));
    return chatIds.length;
  }
  function tgPartners_() {
    return readTable_('Partners').filter((r) => r['Active'] !== false && String(r['Telegram Chat ID'] || '').replace(/^'/, ''));
  }
  /** Who should get an alert about this kind of entry made by `actor`. */
  function tgRecipients_(kind, actor) {
    const isTrip = TG_TRIPS.indexOf(kind) > -1;
    return tgPartners_().filter((r) => {
      const pref = r['Telegram Alerts'] || 'All';
      if (pref === 'Off') return false;
      if (pref === 'Trips' && !isTrip) return false;
      if (pref === 'Money' && isTrip) return false;
      if (String(r['Partner']).toUpperCase() === String(actor).toUpperCase() && r['Telegram Own'] !== true) return false;
      return true;
    }).map((r) => String(r['Telegram Chat ID']).replace(/^'/, ''));
  }
  function tgNotify_(kind, user, html) {
    if (!tgProp_('TG_TOKEN')) return;
    const to = tgRecipients_(kind, user.partner);
    if (to.length) tgSendMany_(to, html);
  }

  /** Build and send the alert for an action that just succeeded. */
  function tgAfter_(action, p, user, r, before) {
    if (!tgProp_('TG_TOKEN')) return;
    const who = '<b>' + h_(cap_(user.partner)) + '</b>'; let t, msg = '', kind = action;
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
      const tr = p.tripId ? getRow_('Trips', p.tripId) : null;
      msg = '💰 ' + who + ' recorded a payment\n' + inr_(p.amount) + ' from ' + h_(tr ? tr['Customer Name'] : (p.customerName || 'customer')) + ' · ' + h_(p.mode || '') + ' · received by ' + h_(cap_(p.receivedBy || user.partner)) +
        (tr && num_(tr['Balance']) > 0 ? '\nStill due: ' + inr_(tr['Balance']) : tr ? '\nFully paid' : '');
    } else if (action === 'workshop') {
      const v = getRow_('Vehicles', p.vehicleId) || {};
      msg = p.on ? '🔧 ' + who + ' sent <b>' + h_(v['Name']) + '</b> to the workshop' + (v['Workshop Notes'] ? '\n' + h_(v['Workshop Notes']) : '') + (v['Workshop Until'] ? '\nExpected back ' + dmy_(v['Workshop Until'], false) : '')
        : '🔧 <b>' + h_(v['Name']) + '</b> is back from the workshop (' + h_(cap_(user.partner)) + ')' + (num_(p.cost) ? '\nBill ' + inr_(p.cost) + ' paid by ' + h_(cap_(p.paidBy || user.partner)) : '');
    } else if (action === 'save' && r) {
      const tb = p.table, edited = !!before, x = r, verb = edited ? 'edited' : 'added';
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
      msg = '🗑️ ' + who + ' deleted ' + ((l) => (/^[aeiou]/.test(l) ? 'an ' : 'a ') + l)(LABELS[p.table] || 'record') + '\n' +
        [before['Amount'] !== undefined && before['Amount'] !== '' ? inr_(before['Amount']) : '', h_(before['Type'] || before['Item'] || before['Name'] || ''), before['Date'] ? dmy_(before['Date'], false) : ''].filter(String).join(' · ');
    }
    if (msg) tgNotify_(kind, user, msg);
  }

  /* ----- Settings, connecting and choices ----- */
  function tgStatus_(user) {
    const me = partnerRow_(user.partner) || {}, bot = tgProp_('TG_BOT');
    const out = { botSet: !!tgProp_('TG_TOKEN'), bot: bot, morning: !!tgProp_('TG_MORNING'),
      me: { connected: !!String(me['Telegram Chat ID'] || '').replace(/^'/, ''), alerts: me['Telegram Alerts'] || 'All', own: me['Telegram Own'] === true } };
    if (user.role === 'Admin') out.partners = readTable_('Partners').filter((r) => r['Active'] !== false).map((r) => ({ partner: r['Partner'], connected: !!String(r['Telegram Chat ID'] || '').replace(/^'/, ''), alerts: r['Telegram Alerts'] || 'All' }));
    return out;
  }
  async function tgSaveBot_(p, user) {
    requireAdmin_(user);
    const token = String(p.token || '').trim();
    if (!/^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(token)) throw new Error('That does not look like a bot token. Copy the whole line BotFather sent, like 123456789:AA…');
    let meBot;
    try { meBot = await tgApi_('getMe', {}, token); }
    catch (e) { throw new Error('Telegram did not accept that token. Check you copied all of it.'); }
    tgProp_('TG_TOKEN', token); tgProp_('TG_BOT', meBot.username); tgProp_('TG_OFFSET', null);
    log_(user, 'Set up Telegram alerts', '@' + tgProp_('TG_BOT'));
    return tgStatus_(user);
  }
  function tgLink_(user) {
    if (!tgProp_('TG_TOKEN')) throw new Error('The admin needs to set up the Telegram bot first.');
    const code = crypto.randomUUID().replace(/-/g, '').slice(0, 10);
    S.kvSet('tg_' + code, String(user.partner), 1800);
    return { code: code, url: 'https://t.me/' + tgProp_('TG_BOT') + '?start=' + code };
  }
  /** After the partner taps Start in Telegram, find their chat and save it. */
  async function tgConfirm_(p, user) {
    let offset = num_(tgProp_('TG_OFFSET')), found = null;
    const ups = (await tgApi_('getUpdates', { offset: offset ? offset + 1 : 0, timeout: 0, allowed_updates: ['message'] })) || [];
    ups.forEach((u) => {
      offset = Math.max(offset, u.update_id);
      const m = u.message; if (!m || !m.text) return;
      const mm = String(m.text).match(/^\/start\s+([a-f0-9]{10})$/);
      if (!mm) return;
      const who = S.kvGet('tg_' + mm[1]);
      if (!who) return;
      const row = partnerRow_(who);
      if (row) { updateRow_('Partners', row['Partner'], { 'Telegram Chat ID': String(m.chat.id), 'Telegram Alerts': row['Telegram Alerts'] || 'All' }); S.kvDel('tg_' + mm[1]); }
      if (String(who).toUpperCase() === String(user.partner).toUpperCase()) found = String(m.chat.id);
      tgSendMany_([String(m.chat.id)], '👋 Hello ' + h_(cap_(who)) + '! This chat will now get alerts from <b>' + h_(settings_()['Business Name'] || APP_NAME) + '</b>. You can change what you get in the app: Partners → Telegram alerts.');
    });
    if (ups.length) tgProp_('TG_OFFSET', String(offset));
    if (!found && !String((partnerRow_(user.partner) || {})['Telegram Chat ID'] || '').replace(/^'/, '')) {
      const err = new Error('Telegram has not received your Start yet. Open the bot, tap Start, then come back and tap "I tapped Start".');
      err.commitAnyway = true; // keep the read position and any other partner who connected meanwhile
      throw err;
    }
    if (found) log_(user, 'Connected Telegram', '');
    return tgStatus_(user);
  }
  function tgPrefs_(p, user) {
    const row = partnerRow_(user.partner); if (!row) throw new Error('Partner not found.');
    if (TG_ALERTS.indexOf(p.alerts) === -1) throw new Error('Choose what to receive.');
    updateRow_('Partners', row['Partner'], { 'Telegram Alerts': p.alerts, 'Telegram Own': p.own === true });
    return tgStatus_(user);
  }
  function tgDisconnect_(p, user) {
    const name = p.partner && user.role === 'Admin' ? p.partner : user.partner, row = partnerRow_(name);
    if (row) updateRow_('Partners', row['Partner'], { 'Telegram Chat ID': '' });
    return tgStatus_(user);
  }
  async function tgTest_(user) {
    const row = partnerRow_(user.partner) || {}, id = String(row['Telegram Chat ID'] || '').replace(/^'/, '');
    if (!id) throw new Error('Connect your Telegram first.');
    if (!(await tgSendNow_([id], '✅ Test message from <b>' + h_(settings_()['Business Name'] || APP_NAME) + '</b>. Alerts are working.'))) throw new Error('Telegram did not deliver the message. Open the bot and tap Start again.');
    return true;
  }

  /* ----- Morning summary (scheduled every day at 8:00 India time; only sends when switched on) ----- */
  function morningSummary() {
    if (!tgProp_('TG_TOKEN')) return;
    const to = tgPartners_().filter((r) => (r['Telegram Alerts'] || 'All') !== 'Off').map((r) => String(r['Telegram Chat ID']).replace(/^'/, ''));
    if (!to.length) return;
    tgSendMany_(to, morningText_());
  }
  function morningText_() {
    const now = new Date(), today = fmt(now, 'yyyy-MM-dd'), nowIso = nowIso_(), st = settings_();
    const warn = num_(st['Expiry Warning Days'] || 30), trips = readTable_('Trips'), lines = [];
    const add = (title, items) => { if (items.length) lines.push('<b>' + title + '</b>\n' + items.map((s) => '• ' + s).join('\n')); };
    const out = trips.filter((t) => t['Status'] === 'Out');
    add('🚗 On trip (' + out.length + ')', out.map((t) => {
      const late = t['Expected Return'] && String(t['Expected Return']) < nowIso;
      return h_(carName_(t['Vehicle ID'])) + ' · ' + h_(t['Customer Name']) + (t['Expected Return'] ? (late ? ' · <b>late, was due ' + dmy_(t['Expected Return']) + '</b>' : String(t['Expected Return']).slice(0, 10) === today ? ' · <b>back today ' + String(t['Expected Return']).slice(11, 16) + '</b>' : ' · back ' + dmy_(t['Expected Return'])) : '');
    }));
    add('📅 Pickups today', trips.filter((t) => t['Status'] === 'Booked' && String(t['Out At']).slice(0, 10) === today).map((t) => String(t['Out At']).slice(11, 16) + ' · ' + h_(t['Customer Name']) + ' · ' + h_(carName_(t['Vehicle ID']))));
    add('⚠️ Bookings not started', trips.filter((t) => t['Status'] === 'Booked' && String(t['Out At']).slice(0, 10) < today).map((t) => h_(t['Customer Name']) + ' · was ' + dmy_(t['Out At'])));
    add('💰 Money due', trips.filter((t) => t['Status'] === 'Returned' && num_(t['Balance']) > 0).map((t) => inr_(t['Balance']) + ' · ' + h_(t['Customer Name']) + ' (since ' + dmy_(t['In At'], false) + ')'));
    add('📞 Follow up today', readTable_('Enquiries').filter((e) => e['Status'] !== 'Booked' && e['Status'] !== 'Lost' && e['Follow Up'] && String(e['Follow Up']).slice(0, 10) <= today).map((e) => h_(e['Name']) + (e['Mobile'] ? ' ' + h_(e['Mobile']) : '')));
    add('🔧 In workshop', readTable_('Vehicles').filter((v) => v['Status'] === 'Workshop').map((v) => h_(v['Name']) + (v['Workshop Until'] ? ' · back ' + dmy_(v['Workshop Until'], false) : '')));
    const odo = {}; trips.forEach((t) => { const id = t['Vehicle ID']; odo[id] = Math.max(odo[id] || 0, num_(t['End Odometer']), num_(t['Start Odometer'])); });
    const soon = fmt(new Date(now.getTime() + warn * 864e5), 'yyyy-MM-dd');
    add('📄 Papers and service', readTable_('Documents').filter((d) => {
      const ex = String(d['Expiry Date'] || '').slice(0, 10), km = num_(d['Due Odometer']);
      return (ex && ex <= soon) || (km && km - (odo[d['Vehicle ID']] || 0) <= 500);
    }).map((d) => {
      const ex = String(d['Expiry Date'] || '').slice(0, 10), km = num_(d['Due Odometer']);
      return h_(d['Item']) + ' · ' + h_(carName_(d['Vehicle ID'])) + (ex ? (ex < today ? ' · <b>expired ' + dmy_(ex, false) + '</b>' : ' · ' + dmy_(ex, false)) : '') + (km ? ' · at ' + inr_(km).replace('₹', '') + ' km' : '');
    }));
    const head = '☀️ <b>' + h_(st['Business Name'] || APP_NAME) + '</b> · ' + fmt(now, 'EEE dd/MM/yyyy');
    return head + '\n\n' + (lines.length ? lines.join('\n\n') : '✅ Nothing due today. All cars are in order.');
  }

  /* ------------------------------------------------------------------ */
  /* Actions the page can call                                           */
  /* ------------------------------------------------------------------ */
  const ACTIONS = {
    whoami: (p, user) => user,
    logout: (p, user, token) => { S.kvDel('session_' + token); return true; },
    changePin: (p, user) => changePin_(p, user),
    bootstrap: (p, user) => bootstrap_(user),
    checkOut: (p, user) => checkOut_(p, user),
    book: (p, user) => book_(p, user),
    cancelBooking: (p, user) => cancelBooking_(p, user),
    checkIn: (p, user) => checkIn_(p, user),
    addPayment: (p, user) => addPayment_(p, user),
    addCharge: (p, user) => addCharge_(p, user),
    workshop: (p, user) => workshop_(p, user),
    rate: (p, user) => rate_(p, user),
    makePdf: (p, user) => makePdf_(p, user),
    save: (p, user) => save_(p, user),
    remove: (p, user) => remove_(p, user),
    photos: (p) => photos_(p.ids || [], p.full === true),
    importOld: () => { throw new Error('The AppSheet import is no longer available. All AppSheet data is already in this app.'); },
    tgStatus: (p, user) => tgStatus_(user),
    tgSaveBot: (p, user) => tgSaveBot_(p, user),
    tgLink: (p, user) => tgLink_(user),
    tgConfirm: (p, user) => tgConfirm_(p, user),
    tgPrefs: (p, user) => tgPrefs_(p, user),
    tgDisconnect: (p, user) => tgDisconnect_(p, user),
    tgTest: (p, user) => tgTest_(user),
    tgMorningPreview: (p, user) => { requireAdmin_(user); return morningText_(); },
    tgMorningSend: (p, user) => { requireAdmin_(user); morningSummary(); return true; }
  };
  /** Wrap the actions that change data so each success sends an alert afterwards. */
  ['checkOut', 'book', 'cancelBooking', 'checkIn', 'addPayment', 'addCharge', 'save', 'remove', 'workshop'].forEach((k) => {
    const fn = ACTIONS[k];
    ACTIONS[k] = (p, user, token) => {
      let before = null;
      try {
        if (k === 'remove') before = getRow_(p.table, p.id);
        if (k === 'save' && SCHEMA[p.table]) { const key = SCHEMA[p.table][0]; before = p.record && p.record[key] ? getRow_(p.table, p.record[key]) : null; }
      } catch (e) { before = null; }
      const r = fn(p, user, token);
      try { tgAfter_(k, p, user, r, before); } catch (e) { console.error('Telegram alert', e); }
      return r;
    };
  });

  /** Single entry point used by the page. Same replies as the Apps Script version. */
  async function api(action, payload, token) {
    if (action === 'partnerNames') return partnerNames_();
    if (action === 'login') return login_(payload || {});
    const user = userFromToken_(token);
    if (!user) throw httpError('Please sign in.', 'LOGIN');
    const fn = ACTIONS[action];
    if (!fn) throw new Error('Unknown action: ' + action);
    return fn(payload || {}, user, token);
  }

  return { api, morningSummary, settings_ };
}
