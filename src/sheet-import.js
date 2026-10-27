import ExcelJS from 'exceljs';
import { randomUUID } from 'node:crypto';
import { getOrderGroup } from './utils.js';

// One-time import from the office's "Misc. Parts Ordered" Google Sheet
// (downloaded as .xlsx). Only the two order tabs are read; the warranty,
// claims and auto-glass tabs stay in the sheet.
const ORDER_TABS = [
  { match: /^window orders$/i, category: 'Windows' },
  { match: /^cw, trulite, arcadia/i, category: 'Showers' }
];

// The sheet uses short vendor codes. Anything not listed keeps its sheet
// spelling; names can be corrected later in Master Lists without breaking links.
const VENDOR_NAMES = {
  JW: 'Jeld-Wen',
  AW: 'Andersen',
  GT: 'Glaztech',
  GLAZTECH: 'Glaztech',
  GLZTECH: 'Glaztech',
  OLDCASTLE: 'Oldcastle',
  ARCADIA: 'Arcadia',
  TRULITE: 'Trulite',
  STANLEY: 'Stanley'
};
const VENDOR_CATEGORIES = { Arcadia: 'Storefront' };
const UNKNOWN_SUPPLIER = 'Unknown supplier (from sheet)';
const UNKNOWN_STAFF = 'Unknown';

const COLUMNS = {
  orderedBy: /^who ordered/,
  customer: /^customer/,
  vendor: /^vendor/,
  orderDate: /^order date/,
  expectedDate: /^date to receive/,
  received: /^received/,
  scheduled: /^job scheduled/,
  shopLocation: /^shop location/,
  scheduleNote: /^(to schedule|pending date to schedule)/,
  completed: /^job complete/,
  invoice: /^(billed\s*-\s*invoice|sales order & invoice)/,
  deliveryClaim: /^del claim/,
  billedOut: /^billed out/,
  notes: /^notes/
};

function cellValue(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value !== 'object') return value;
  if ('result' in value) return cellValue(value.result);
  if (Array.isArray(value.richText)) return value.richText.map(part => part.text).join('');
  if ('text' in value) return cellValue(value.text);
  return null;
}

function text(value) {
  const plain = cellValue(value);
  if (plain === null) return '';
  if (plain instanceof Date) return isoDate(plain);
  return String(plain).replace(/\s+/g, ' ').trim();
}

function multilineText(value) {
  const plain = cellValue(value);
  return plain === null || plain instanceof Date ? text(value) : String(plain).trim();
}

function checked(value) {
  const plain = cellValue(value);
  return plain === true || String(plain).trim().toUpperCase() === 'TRUE';
}

function isoDate(date) {
  // Google Sheets exports dates as UTC midnight.
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

// Dates arrive as real dates, Excel serial numbers, or typed text such as
// "10/12/2026" or "08-25-26 (9/3)". Anything unreadable (e.g. a mistyped
// year) comes back as ''.
function sheetDate(value) {
  const plain = cellValue(value);
  let date = '';
  if (plain instanceof Date) {
    date = Number.isNaN(plain.getTime()) ? '' : isoDate(plain);
  } else if (typeof plain === 'number' && plain > 20000 && plain < 80000) {
    date = isoDate(new Date(Date.UTC(1899, 11, 30) + plain * 86400000));
  } else {
    const typed = String(plain ?? '').trim();
    const iso = /^(\d{4})-(\d{2})-(\d{2})\b/.exec(typed);
    const us = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4}|\d{2})\b/.exec(typed);
    if (iso) date = `${iso[1]}-${iso[2]}-${iso[3]}`;
    else if (us) date = `${us[3].length === 2 ? `20${us[3]}` : us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  }
  const [year, month, day] = date.split('-').map(Number);
  return year >= 2000 && year <= 2099 && month >= 1 && month <= 12 && day >= 1 && day <= 31 ? date : '';
}

// The billing cell holds either an 8-digit Housecall Pro invoice/job number
// or a pricing note ("Selling at $827 + tax").
function housecallNumber(reference) {
  return /\b(\d{8})\b/.exec(reference)?.[1] || '';
}

function headerColumns(worksheet) {
  for (let rowNumber = 1; rowNumber <= 5; rowNumber += 1) {
    const found = {};
    worksheet.getRow(rowNumber).eachCell((cell, column) => {
      const label = text(cell.value).toLowerCase();
      for (const [key, pattern] of Object.entries(COLUMNS)) {
        if (!found[key] && pattern.test(label)) found[key] = column;
      }
    });
    if (found.customer && found.vendor) return { headerRow: rowNumber, columns: found };
  }
  return null;
}

function supplierName(vendor) {
  const code = vendor.trim();
  if (!code) return UNKNOWN_SUPPLIER;
  return VENDOR_NAMES[code.toUpperCase().replace(/\s+/g, '')] || code;
}

// "SD/RD", "KA for AD" and "AD/JC" are credited to the first person;
// the full text is kept in the order notes.
function staffName(orderedBy) {
  const first = orderedBy.split(/\s*(?:\/|for|&|,)\s*/i)[0].trim();
  return /^[?]*$/.test(first) ? UNKNOWN_STAFF : first.toUpperCase();
}

function customerKey(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Reads the workbook and returns what would be imported, without touching
// the database. Rows already complete and billed are left out.
export async function parseOrderSheet(buffer, { today }) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const plan = { tabs: [], orders: [], jobs: [], suppliers: [], staff: [], skipped: [] };
  // Supplier and staff names are matched without regard to capitals, like
  // Master Lists; the first spelling seen is kept.
  const suppliers = new Map();
  const staff = new Map();
  const canonical = (names, name) => {
    const key = name.trim().toLowerCase();
    if (!names.has(key)) names.set(key, name.trim());
    return names.get(key);
  };

  for (const tab of ORDER_TABS) {
    const worksheet = workbook.worksheets.find(sheet => tab.match.test(sheet.name.trim()));
    if (!worksheet) continue;
    const header = headerColumns(worksheet);
    if (!header) continue;
    const summary = { name: worksheet.name.trim(), category: tab.category, imported: 0, skipped: 0 };
    const { columns } = header;
    const cell = (row, key) => (columns[key] ? row.getCell(columns[key]).value : null);
    const groups = new Map();

    for (let rowNumber = header.headerRow + 1; rowNumber <= worksheet.rowCount; rowNumber += 1) {
      const row = worksheet.getRow(rowNumber);
      const customer = text(cell(row, 'customer'));
      if (!customer) continue;

      const skip = reason => {
        summary.skipped += 1;
        plan.skipped.push({ tab: summary.name, row: rowNumber, customer, reason });
      };
      const invoiceReference = text(cell(row, 'invoice'));
      const jobNumber = housecallNumber(invoiceReference);
      const completed = checked(cell(row, 'completed'));
      // Window tab has a Billed Out box; the glass tab counts as billed once
      // its Sales Order & Invoice cell has an invoice number.
      const invoiced = columns.billedOut ? checked(cell(row, 'billedOut')) : Boolean(jobNumber);
      if (completed && invoiced) {
        skip('Complete and billed');
        continue;
      }

      const expected = sheetDate(cell(row, 'expectedDate'));
      const typedExpected = text(cell(row, 'expectedDate'));
      // The order date is required; a few rows never had one.
      const dateOrdered = sheetDate(cell(row, 'orderDate')) || (expected && expected <= today ? expected : today);
      const missingOrderDate = !sheetDate(cell(row, 'orderDate'));
      // The sheet only has a Received box, not the day it arrived: use the
      // expected date (or today if that is still ahead), never before ordering.
      const received = checked(cell(row, 'received'));
      const [earliest] = [expected, today].filter(Boolean).sort();
      const dateReceived = received ? (earliest < dateOrdered ? dateOrdered : earliest) : '';
      const orderedByText = text(cell(row, 'orderedBy'));
      const person = canonical(staff, orderedByText ? staffName(orderedByText) : UNKNOWN_STAFF);
      const supplier = canonical(suppliers, supplierName(text(cell(row, 'vendor'))));
      const notes = [
        multilineText(cell(row, 'notes')),
        missingOrderDate ? `No order date in the sheet${text(cell(row, 'orderDate')) ? ` ("${text(cell(row, 'orderDate'))}")` : ''}; used ${dateOrdered === today ? 'the import date' : 'the expected date'}.` : '',
        typedExpected && !expected ? `Expected date in the sheet could not be read: "${typedExpected}".` : '',
        orderedByText && orderedByText.toUpperCase() !== person ? `Ordered by ${orderedByText} (from the sheet)` : '',
        checked(cell(row, 'deliveryClaim')) ? 'Delivery claim filed (from the sheet)' : ''
      ].filter(Boolean).join('\n');
      const category = VENDOR_CATEGORIES[supplier] || tab.category;
      const order = {
        key: `${summary.name}:${rowNumber}`,
        tab: summary.name,
        row: rowNumber,
        customer_name: customer,
        housecall_job_number: jobNumber,
        supplier,
        category,
        ordered_by: person,
        date_ordered: dateOrdered,
        expected_delivery_date: expected,
        date_received: dateReceived,
        shop_location: text(cell(row, 'shopLocation')),
        job_scheduled: checked(cell(row, 'scheduled')) ? 1 : 0,
        schedule_note: text(cell(row, 'scheduleNote')),
        job_completed: completed ? 1 : 0,
        invoiced: invoiced ? 1 : 0,
        invoice_reference: invoiceReference,
        notes
      };
      plan.orders.push(order);
      summary.imported += 1;
      const key = customerKey(customer);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(order);
    }

    // Several orders for the same customer on one tab become one job, so
    // scheduling one schedules them all and "all materials here" works.
    for (const orders of groups.values()) {
      if (orders.length < 2) continue;
      const job = { key: `job:${orders[0].key}`, customer_name: orders[0].customer_name, order_keys: orders.map(order => order.key) };
      orders.forEach(order => { order.job_key = job.key; });
      plan.jobs.push(job);
    }
    plan.tabs.push(summary);
  }

  if (!plan.tabs.length) {
    throw Object.assign(new Error('No order tabs found.'), { code: 'NOT_ORDER_SHEET' });
  }
  plan.suppliers = [...suppliers.values()].sort((a, b) => a.localeCompare(b));
  plan.staff = [...staff.values()].sort((a, b) => a.localeCompare(b));
  return plan;
}

const ORDER_COLUMNS = [
  'id', 'customer_name', 'housecall_job_number', 'housecall_job_link', 'supplier', 'supplier_id', 'category', 'combined_group',
  'po_number', 'date_ordered', 'expected_delivery_date', 'date_received', 'ordered_by', 'ordered_by_id', 'status', 'notes',
  'job_draft_id', 'created_at', 'updated_at', 'created_by', 'updated_by', 'is_preview_data', 'shop_location', 'job_scheduled',
  'scheduled_date', 'schedule_note', 'job_completed', 'completed_date', 'invoiced', 'invoice_reference'
];

const sameName = (left, right) => left.trim().toLowerCase() === right.trim().toLowerCase();

// Turns a parsed plan into insert statements for runInTransaction.
// 'replace' first empties orders, jobs, suppliers and staff (users and
// Freeport stay); 'add' reuses existing names and skips orders already in
// the tracker (same customer, supplier and order date).
export function importStatements(plan, { mode, existing, now, actor }) {
  const statements = [];
  const result = { mode, orders: 0, duplicates: 0, jobs: 0, suppliers_added: 0, staff_added: 0 };
  if (mode === 'replace') {
    for (const table of ['orders', 'job_drafts', 'suppliers', 'staff_names']) statements.push({ sql: `DELETE FROM ${table}` });
  }
  const keep = rows => (mode === 'replace' ? [] : rows);

  const supplierIds = new Map();
  for (const name of plan.suppliers) {
    const found = keep(existing.suppliers).find(row => sameName(row.name, name));
    if (found) {
      supplierIds.set(name, found.id);
      // A matching supplier that was switched off is switched back on.
      if (Number(found.active) === 0) statements.push({ sql: 'UPDATE suppliers SET active = 1, updated_at = ? WHERE id = ?', params: [now, found.id] });
      continue;
    }
    const id = `supplier-${randomUUID()}`;
    supplierIds.set(name, id);
    statements.push({ sql: 'INSERT INTO suppliers (id, name, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)', params: [id, name, now, now] });
    result.suppliers_added += 1;
  }

  const staffIds = new Map();
  for (const name of plan.staff) {
    const found = keep(existing.staff).find(row => sameName(row.name, name));
    if (found) {
      staffIds.set(name, found.id);
      continue;
    }
    const id = `staff-${randomUUID()}`;
    staffIds.set(name, id);
    statements.push({ sql: 'INSERT INTO staff_names (id, name, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)', params: [id, name, now, now] });
    result.staff_added += 1;
  }

  const already = new Set(keep(existing.orders).map(row => [row.customer_name, row.supplier, row.date_ordered].map(value => String(value || '').trim().toLowerCase()).join('|')));
  const orders = plan.orders.filter(order => {
    const duplicate = already.has([order.customer_name, order.supplier, order.date_ordered].map(value => value.trim().toLowerCase()).join('|'));
    if (duplicate) result.duplicates += 1;
    return !duplicate;
  });

  const jobIds = new Map();
  for (const job of plan.jobs) {
    if (orders.filter(order => order.job_key === job.key).length < 2) continue;
    const id = `draft-${randomUUID()}`;
    jobIds.set(job.key, id);
    // Materials for these jobs are already ordered, so they skip the
    // Approved – Need to Order list.
    statements.push({
      sql: `INSERT INTO job_drafts (id, customer_name, housecall_job_number, housecall_job_link, hcp_job_id, notes, deposit_status, status, created_at, updated_at, created_by, updated_by, is_preview_data)
        VALUES (?, ?, '', '', '', ?, 'Deposit received', 'Completed', ?, ?, ?, ?, 0)`,
      params: [id, job.customer_name, 'Imported from the Google Sheet.', now, now, actor, actor]
    });
    result.jobs += 1;
  }

  for (const order of orders) {
    const row = {
      id: `order-${randomUUID()}`,
      customer_name: order.customer_name,
      housecall_job_number: order.housecall_job_number,
      housecall_job_link: '',
      supplier: order.supplier,
      supplier_id: supplierIds.get(order.supplier),
      category: order.category,
      combined_group: getOrderGroup(order.category),
      po_number: '',
      date_ordered: order.date_ordered,
      expected_delivery_date: order.expected_delivery_date,
      date_received: order.date_received || null,
      ordered_by: order.ordered_by,
      ordered_by_id: staffIds.get(order.ordered_by),
      status: order.date_received ? 'Received' : 'Ordered',
      notes: order.notes,
      job_draft_id: jobIds.get(order.job_key) || null,
      created_at: now,
      updated_at: now,
      created_by: actor,
      updated_by: actor,
      is_preview_data: 0,
      shop_location: order.shop_location,
      job_scheduled: order.job_scheduled,
      scheduled_date: '',
      schedule_note: order.schedule_note,
      job_completed: order.job_completed,
      completed_date: '',
      invoiced: order.invoiced,
      invoice_reference: order.invoice_reference
    };
    statements.push({
      sql: `INSERT INTO orders (${ORDER_COLUMNS.join(', ')}) VALUES (${ORDER_COLUMNS.map(() => '?').join(', ')})`,
      params: ORDER_COLUMNS.map(column => row[column])
    });
    result.orders += 1;
  }
  return { statements, result };
}
