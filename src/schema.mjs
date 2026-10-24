// Every table, its columns (same names and order as the Google Sheet tabs), and the column types.
// The first column of each table is its key, exactly as in the Apps Script version.

export const SCHEMA = {
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

export const DATE_COLS = ['Purchase Date', 'Date', 'Created At', 'Out At', 'In At', 'Expected Return', 'Updated At', 'Expiry Date', 'Time', 'Workshop Since', 'Workshop Until', 'Wanted From', 'Wanted To', 'Follow Up'];
export const NUM_COLS = ['Purchase Price', 'Extra Costs', 'Amount', 'Start Odometer', 'End Odometer', 'Deposit', 'Rate Per Day',
  'Days', 'Km Driven', 'Extra Km', 'Extra Km Charge', 'Late Fee', 'Fuel Charge', 'Damage Charge', 'Discount',
  'Bill Total', 'Paid', 'Balance', 'Deposit Refunded', 'Deposit Deducted', 'Due Odometer',
  'FASTag Out', 'FASTag In', 'Toll Charge', 'Fine Charge'];
export const BOOL_COLS = ['Active', 'Blocked', 'Telegram Own'];

// Settings values can be numbers or text, as they were in the sheet, so that column keeps whatever it is given.
const UNTYPED = { Settings: ['Value'] };

export const DEFAULT_SETTINGS = [
  ['Business Name', 'Rental Hub', 'Shown in the app header'],
  ['Currency', 'INR', 'Currency code for amounts'],
  ['Reserve %', 10, 'Share of profit kept in the business before dividends'],
  ['Late Grace Hours', 2, 'Hours after a full day before another day is charged'],
  ['Km Per Day Limit', 0, '0 means unlimited km'],
  ['Extra Km Rate', 0, 'Charge per km above the daily limit'],
  ['Expiry Warning Days', 30, 'Warn this many days before a document expires'],
  ['Business Phone', '', 'Printed on rental agreements'],
  ['Business Address', '', 'Printed on rental agreements']
];

export function sqlType(table, col) {
  if ((UNTYPED[table] || []).includes(col)) return '';
  if (NUM_COLS.includes(col)) return 'REAL';
  if (BOOL_COLS.includes(col)) return 'INTEGER';
  return 'TEXT';
}

export const q = (name) => '"' + String(name).replace(/"/g, '""') + '"';

/**
 * A value as the Apps Script version read it back from the sheet (write with toCell_, read with toOut_):
 * dates become 'yyyy-MM-ddTHH:mm', numbers become numbers, ticks become true/false, everything else text.
 */
export function normalize(v, col, table) {
  if (BOOL_COLS.includes(col)) return v === true || v === 1 || String(v).toUpperCase() === 'TRUE';
  if (v === undefined || v === null || v === '') return '';
  if (DATE_COLS.includes(col)) {
    const s = String(v);
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
    if (m) return m[1] + '-' + m[2] + '-' + m[3] + 'T' + (m[4] || '00') + ':' + (m[5] || '00');
    return s;
  }
  if (NUM_COLS.includes(col)) {
    const n = Number(v);
    return isNaN(n) ? '' : n;
  }
  if ((UNTYPED[table] || []).includes(col) && typeof v === 'number') return v;
  return String(v);
}

/** Value for a D1 column. */
export function toDb(v, col) {
  if (BOOL_COLS.includes(col)) return v === true ? 1 : 0;
  if (v === '' || v === undefined || v === null) return null;
  return v;
}

/** Value from a D1 column, in the same shape the sheet version returned. */
export function fromDb(v, col) {
  if (BOOL_COLS.includes(col)) return v === 1 || v === true;
  if (v === null || v === undefined) return '';
  return v;
}
