import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import ExcelJS from 'exceljs';
import { PDFDocument } from 'pdf-lib';
import { inflateSync } from 'node:zlib';
import { buildInvoicePages } from '../src/freeport/pdf.js';
import {
  SPREADSHEET_COLUMNS,
  billingMonthFor,
  centsToDecimal,
  lineTotal,
  matchLine,
  parseMoney,
  pinMatchedItems,
  parseQuantity,
  spreadsheetRows,
  summarizeInvoice,
  summarizeMonth,
  taxOnParts
} from '../public/freeport-billing.js';

// Synthetic configuration and invoices only.
const config = {
  settings: { taxRate: '9.1', companyCode: '1328', poNumber: 'ZD00000669', partsExpense: '61040078', laborExpense: '61120032' },
  accounts: [{ code: '1060401328', name: 'Mine Maintenance - Truck', group: 'Mine', usingAreaName: 'Mine Maintenance', active: true }],
  items: [
    { id: 'lami-36', sku: '.090 Clear Laminate', description: '36 x 48 (.090 Clr Lami)', unit: 'ea', type: 'Parts', priceCents: 29928, active: true },
    { id: 'lami-48', sku: '.090 Clear Laminate', description: '48 x 48 (.090 Clr Lami)', unit: 'ea', type: 'Parts', priceCents: 39904, active: true },
    { id: 'silicone', sku: 'Silicone', description: 'Silicone', unit: 'ea', type: 'Parts', priceCents: 1850, active: true },
    { id: 'labor', sku: 'Labor', description: 'Tech Labor - Straight', unit: 'hr', type: 'Labor', priceCents: 12500, active: true },
    { id: 'old', sku: 'Old Item', description: 'Retired', unit: 'ea', type: 'Parts', priceCents: 100, active: false }
  ]
};

const invoice = (overrides = {}) => ({
  number: '90001', omegaDate: '2026-09-04', installDate: '2026-09-03', monthOverride: '', orderNumber: '100000900101',
  accountCode: '1060401328', omegaTaxCents: null, status: 'Needs review',
  lines: [
    { sku: '.090 Clear Laminate', itemId: '', quantity: '1', rateCents: 29928 },
    { sku: 'Silicone', itemId: '', quantity: '1', rateCents: 1850 },
    { sku: 'Labor', itemId: '', quantity: '2', rateCents: 12500 },
    { sku: 'Labor', itemId: '', quantity: '2', rateCents: 12500 }
  ],
  ...overrides
});

test('money, quantity and tax math is exact and rounds half up', () => {
  assert.equal(parseMoney('$1,234.5'), 123450);
  assert.equal(parseMoney('18.50'), 1850);
  assert.equal(parseMoney('1.234'), null);
  assert.equal(parseMoney('-5'), null);
  assert.equal(parseQuantity('3.5'), 3500);
  assert.equal(parseQuantity('0'), null);
  assert.equal(parseQuantity('1.2345'), null);
  assert.equal(lineTotal(parseQuantity('4.25'), 18500), 78625);
  assert.equal(lineTotal(parseQuantity('0.005'), 100), 1); // 0.5 cent rounds up
  // Past consolidated invoice: 9.1% of $7,998.02 parts = $727.82.
  assert.equal(taxOnParts(799802, '9.1'), 72782);
  // Omega invoice example: 9.1% of $609.28 parts = $55.44448 -> $55.44.
  assert.equal(taxOnParts(60928, '9.1'), 5544);
  assert.equal(centsToDecimal(1850), '18.5');
  assert.equal(centsToDecimal(12500), '125');
  assert.equal(centsToDecimal(29928), '299.28');
});

test('billing month comes from the install date, not the invoice date', () => {
  assert.equal(billingMonthFor({ installDate: '2026-09-29', omegaDate: '2026-10-06' }), '2026-09');
  assert.equal(billingMonthFor({ installDate: '', omegaDate: '2026-10-06' }), '2026-10');
  assert.equal(billingMonthFor({ installDate: '2026-09-29', omegaDate: '2026-10-06', monthOverride: '2026-08' }), '2026-08');
  assert.equal(billingMonthFor({ installDate: '2026-02-30' }), '');
});

test('lines match by SKU, then by price for multi-size SKUs, and never change billed prices', () => {
  const sized = matchLine({ sku: '.090 clear  laminate', quantity: '1', rateCents: 39904 }, config.items);
  assert.equal(sized.item.id, 'lami-48');
  const unknownSize = matchLine({ sku: '.090 Clear Laminate', quantity: '1', rateCents: 45000 }, config.items);
  assert.equal(unknownSize.item, null);
  assert.match(unknownSize.issue, /pick one/);
  const picked = matchLine({ sku: '.090 Clear Laminate', itemId: 'lami-36', quantity: '1', rateCents: 45000 }, config.items);
  assert.equal(picked.item.id, 'lami-36');
  assert.equal(picked.total, 45000);
  assert.match(picked.warning, /list price \$299\.28/);
  assert.match(matchLine({ sku: 'Window Film', quantity: '1', rateCents: 4000 }, config.items).issue, /not on the item master list/);
  assert.match(matchLine({ sku: 'Old Item', quantity: '1', rateCents: 100 }, config.items).issue, /not on the item master list/);
  assert.equal(matchLine({ sku: 'Old Item', itemId: 'old', quantity: '1', rateCents: 100 }, config.items).item.id, 'old');
});

test('invoice summary separates blockers from warnings', () => {
  const clean = summarizeInvoice(invoice(), config);
  assert.deepEqual(clean.blockers, []);
  assert.deepEqual(clean.warnings, []);
  assert.equal(clean.parts, 31778);
  assert.equal(clean.labor, 50000);
  assert.equal(clean.tax, taxOnParts(31778, '9.1'));

  const missing = summarizeInvoice(invoice({ installDate: '', orderNumber: '', accountCode: '9999', lines: [] }), config);
  assert.deepEqual(missing.blockers, ['Add at least one line item', 'Install date is missing', 'Order number is missing', 'Account code 9999 is not on the account list']);

  const odd = summarizeInvoice(invoice({ installDate: '2026-09-10', omegaDate: '2026-09-04', omegaTaxCents: 9999 }), config);
  assert.deepEqual(odd.blockers, []);
  assert.ok(odd.warnings.includes('Install date is after the invoice date'));
  assert.ok(odd.warnings.some(text => text.startsWith('Invoice tax $99.99 differs')));
  assert.equal(odd.tax, 9999);

  const late = summarizeInvoice(invoice({ installDate: '2026-07-01', omegaDate: '2026-09-04' }), config);
  assert.ok(late.warnings.some(text => /Installed 65 days before/.test(text)));
  // A one-cent rounding difference between the invoice and 9.1% is not flagged.
  assert.deepEqual(summarizeInvoice(invoice({ omegaTaxCents: taxOnParts(31778, '9.1') + 1 }), config).warnings, []);
});

test('month totals tax the month parts once and the spreadsheet keeps one row per line', () => {
  const month = summarizeMonth('2026-09', [invoice(), invoice({ number: '90002', installDate: '2026-09-01' })], config);
  assert.deepEqual(month.invoices.map(entry => entry.number), ['90002', '90001']);
  assert.equal(month.parts, 63556);
  assert.equal(month.labor, 100000);
  assert.equal(month.tax, taxOnParts(63556, '9.1'));
  assert.equal(month.packageNumber, 'FMI-2026-09');

  const rows = spreadsheetRows(month, config);
  assert.equal(SPREADSHEET_COLUMNS.length, 15);
  assert.equal(rows.length, 8);
  assert.deepEqual(rows[2].cells, ['Tech Labor - Straight', '', '2', 'hr', '125', 'Work Order', '1328', '100000900101', '', '1060401328', '', '61120032', '90002', 'Mine Maintenance', 'ZD00000669']);
  assert.deepEqual(rows[2].cells, rows[3].cells); // two technicians stay two rows
  assert.equal(rows[0].cells[0], '36 x 48 (.090 Clr Lami)');
  assert.equal(rows[0].cells[11], '61040078');
});

test('saved lines keep their matched item even if the master list changes later', () => {
  const pinned = pinMatchedItems(invoice().lines, config.items);
  assert.deepEqual(pinned.map(line => line.itemId), ['lami-36', 'silicone', 'labor', 'labor']);
  const repriced = { ...config, items: config.items.map(item => (item.id === 'lami-36' ? { ...item, priceCents: 31000, active: false } : item)) };
  const summary = summarizeInvoice(invoice({ lines: pinned }), repriced);
  assert.equal(summary.parts, 31778, 'billed amounts still count');
  assert.deepEqual(summary.blockers, []);

  // An unpinned Ready invoice that picks up a blocker counts as needing review.
  const priceOnly = { ...config, items: config.items.map(item => (item.id === 'lami-36' ? { ...item, priceCents: 31000 } : item)) };
  const month = summarizeMonth('2026-09', [invoice({ status: 'Ready' })], priceOnly);
  assert.equal(month.needsReview.length, 1);
  assert.equal(month.unmatched, 29928);
});

test('per-line description items take the spreadsheet description from the line', () => {
  const items = [
    ...config.items,
    { id: 'windshield', sku: 'Windshield', description: 'Windshield (type part # and name)', unit: 'ea', type: 'Parts', priceCents: 28500, customDescription: true, active: true },
    { id: 'special', sku: 'Special-order part', description: 'Special-order part (type description)', unit: 'ea', type: 'Parts', priceCents: 0, customDescription: true, active: true }
  ];
  const withParts = { ...config, items };
  assert.match(matchLine({ sku: 'Windshield', quantity: '1', rateCents: 28500 }, items).issue, /Type the description/);
  const cheaper = matchLine({ sku: 'Windshield', description: 'DW01851GBYN Windshield', quantity: '1', rateCents: 22900 }, items);
  assert.equal(cheaper.issue, '');
  assert.match(cheaper.warning, /list price \$285\.00/);
  assert.equal(matchLine({ sku: 'Special-order part', description: 'Crating/Packaging', quantity: '1', rateCents: 43200 }, items).warning, '', 'no list price, no warning');

  const month = summarizeMonth('2026-09', [invoice({ lines: [{ sku: 'Windshield', itemId: '', description: 'DW02153GTYN Windshield', quantity: '1', rateCents: 28500 }] })], withParts);
  assert.equal(month.parts, 28500);
  assert.equal(spreadsheetRows(month, withParts)[0].cells[0], 'DW02153GTYN Windshield');
  // The item is known before a rate is typed, so the screen can show its description box.
  const noRate = matchLine({ sku: 'Special-order part', quantity: '1', rateCents: null }, items);
  assert.equal(noRate.item.id, 'special');
  assert.equal(noRate.issue, 'Rate is missing');
  const undescribed = summarizeMonth('2026-09', [invoice({ lines: [{ sku: 'Windshield', itemId: '', description: '', quantity: '1', rateCents: 28500 }] })], withParts);
  assert.equal(spreadsheetRows(undescribed, withParts)[0].flagged, true, 'a line with a problem is highlighted in the preview');
});

// Reads back the text a pdf-lib file prints: inflates each content stream and
// decodes its hex-encoded text operators.
function pdfText(bytes) {
  const raw = Buffer.from(bytes);
  const latin = raw.toString('latin1');
  const texts = [];
  let from = 0;
  for (;;) {
    const start = latin.indexOf('stream\n', from);
    if (start < 0) break;
    const end = latin.indexOf('\nendstream', start + 7);
    if (end < 0) break;
    try {
      const content = inflateSync(raw.subarray(start + 7, end)).toString('latin1');
      for (const match of content.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)) texts.push(Buffer.from(match[1], 'hex').toString('latin1'));
    } catch {}
    from = end + 10;
  }
  return texts.join('\n');
}

test('merged invoice PDF continues long invoices onto extra pages', async () => {
  const pdfConfig = {
    ...config,
    settings: { ...config.settings, businessName: 'Synthetic Glass ✓', businessAddress: '1 Test Rd', businessPhone: '', billTo: 'Synthetic Customer', contractNumber: 'C-1', rocNumber: '1', vendorId: '2', footerNote: '' }
  };
  const labor = Array.from({ length: 60 }, () => ({ sku: 'Labor', itemId: 'labor', description: '', quantity: '1', rateCents: 12500 }));
  const month = summarizeMonth('2026-09', [invoice({ status: 'Ready', lines: [...labor, { sku: 'Silicone', itemId: 'silicone', description: '', quantity: '1', rateCents: 1850 }] })], pdfConfig);
  const bytes = await buildInvoicePages(month, pdfConfig);
  const pdf = await PDFDocument.load(bytes);
  assert.ok(pdf.getPageCount() >= 2);
  const text = pdfText(bytes);
  assert.ok(text.includes('INVOICE (continued)'));
  assert.ok(text.includes(`Page 1 of ${pdf.getPageCount()}`));
  assert.ok(text.includes('Synthetic Glass ?'), 'characters the PDF font lacks print as ?');
  assert.ok(text.includes('$7,518.50'), 'totals land after the last line');
});

// ---------- API ----------

const PORT = 4120;
const BASE = `http://127.0.0.1:${PORT}`;

async function startServer(dataDir, preview = false) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env, NODE_ENV: 'test', RENDER: 'false', SESSION_SECRET: 'test-secret', APP_PORT: String(PORT),
      PREVIEW_MODE: preview ? 'true' : 'false', SQLITE_DATA_DIR: dataDir,
      DEMO_STAFF_PASSWORD: 'staff-test', ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'admin-test'
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Server exited: ${errors}`);
    try { if ((await fetch(`${BASE}/healthz`)).ok) return child; } catch {}
    await delay(100);
  }
  throw new Error('Server start timed out');
}

async function stopServer(child) {
  if (child.exitCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }
}

function client() {
  let cookie = '';
  const send = async (route, { method = 'GET', body } = {}) => {
    const response = await fetch(`${BASE}${route}`, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return response;
  };
  const request = async (route, options) => {
    const response = await send(route, options);
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  request.raw = send;
  return request;
}

const newInvoice = (overrides = {}) => ({
  number: '91001', omegaDate: '2026-10-06', installDate: '2026-09-29', orderNumber: '100000910001', accountCode: '1060401328',
  lines: [{ sku: 'Labor', quantity: '2', rateCents: 12500 }, { sku: 'Labor', quantity: '2', rateCents: 12500 }],
  ...overrides
});

test('Freeport invoice records save, validate and persist', { timeout: 60000 }, async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'boulevard-freeport-'));
  let server = await startServer(dataDir);
  try {
    const request = client();
    assert.equal((await request('/api/freeport/config')).status, 401);
    assert.equal((await request('/api/login', { method: 'POST', body: { username: 'mary', password: 'staff-test' } })).status, 200);

    const config = (await request('/api/freeport/config')).body;
    assert.equal(config.accounts.length, 14);
    assert.equal(config.settings.poNumber, 'ZD00000669');
    assert.ok(config.items.some(item => item.sku === 'Labor' && item.priceCents === 12500));
    assert.ok(config.items.some(item => item.sku === 'Windshield' && item.customDescription && item.priceCents === 28500));
    assert.ok(config.items.some(item => item.sku === '36 x 48 (.090 Clr Lami)' && !item.customDescription));

    const windshield = await request('/api/freeport/invoices', { method: 'POST', body: newInvoice({ number: '91003', lines: [{ sku: 'Windshield', description: 'DW02153GTYN Windshield', quantity: '1', rateCents: 28500 }] }) });
    assert.equal(windshield.status, 201, JSON.stringify(windshield.body));
    assert.equal(windshield.body.lines[0].description, 'DW02153GTYN Windshield');
    assert.equal((await request(`/api/freeport/invoices/91003?version=1`, { method: 'DELETE' })).status, 200);

    // Created by install date: invoice dated October, billed in September.
    const created = await request('/api/freeport/invoices', { method: 'POST', body: newInvoice() });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.billingMonth, '2026-09');
    assert.equal(created.body.version, 1);
    assert.equal(created.body.createdBy, 'mary');
    assert.ok(created.body.lines.every(line => line.itemId), 'matched lines are saved with their item');

    assert.equal((await request('/api/freeport/invoices', { method: 'POST', body: newInvoice() })).status, 409);
    assert.equal((await request('/api/freeport/invoices', { method: 'POST', body: newInvoice({ number: '91002', installDate: '', omegaDate: '' }) })).status, 400);
    assert.equal((await request('/api/freeport/invoices', { method: 'POST', body: newInvoice({ number: '91002', driveLink: 'javascript:alert(1)' }) })).status, 400);
    assert.equal((await request('/api/freeport/invoices', { method: 'POST', body: newInvoice({ number: '91002', lines: [{ sku: 'Labor', quantity: '-1', rateCents: 12500 }] }) })).status, 400);

    const blocked = await request('/api/freeport/invoices', { method: 'POST', body: newInvoice({ number: '91002', status: 'Ready', lines: [{ sku: 'Window Film', quantity: '1', rateCents: 4000 }] }) });
    assert.equal(blocked.status, 400);
    assert.deepEqual(blocked.body.blockers, ['Line 1: SKU "Window Film" is not on the item master list']);

    // Saving needs the version that was loaded.
    const ready = await request('/api/freeport/invoices/91001', { method: 'PUT', body: { ...newInvoice(), status: 'Ready', version: 1 } });
    assert.equal(ready.status, 200, JSON.stringify(ready.body));
    assert.equal(ready.body.status, 'Ready');
    assert.equal((await request('/api/freeport/invoices/91001', { method: 'PUT', body: { ...newInvoice(), version: 1 } })).status, 409);

    // Renaming keeps one record; the old number is gone.
    const renamed = await request('/api/freeport/invoices/91001', { method: 'PUT', body: { ...newInvoice({ number: '91001-A' }), status: 'Ready', version: 2 } });
    assert.equal(renamed.status, 200);
    assert.equal((await request('/api/freeport/invoices/91001')).status, 404);
    assert.equal((await request('/api/freeport/invoices/91001-A')).body.lines.length, 2);

    assert.deepEqual((await request('/api/freeport/months')).body, [{ month: '2026-09', invoices: 1, needsReview: 0 }]);
    assert.equal((await request('/api/freeport/invoices?month=2026-09')).body.length, 1);
    assert.equal((await request('/api/freeport/invoices?month=2026-10')).body.length, 0);
    assert.equal((await request('/api/freeport/invoices?month=bad')).status, 400);

    // Spreadsheet download: refused while anything needs review, then Freeport's 15 columns.
    const pending = await request('/api/freeport/invoices', { method: 'POST', body: newInvoice({ number: '91002', installDate: '2026-09-15' }) });
    const refused = await request('/api/freeport/months/2026-09/spreadsheet.xlsx');
    assert.equal(refused.status, 409);
    assert.deepEqual(refused.body.invoices, ['91002']);
    assert.equal((await request('/api/freeport/months/2026-09/consolidated-invoice.pdf')).status, 409);
    assert.equal((await request('/api/freeport/months/2026-09/invoices.pdf')).status, 409);
    assert.equal((await request(`/api/freeport/invoices/91002?version=${pending.body.version}`, { method: 'DELETE' })).status, 200);
    assert.equal((await request('/api/freeport/months/2026-10/spreadsheet.xlsx')).status, 409);
    assert.equal((await request('/api/freeport/months/2026-9/spreadsheet.xlsx')).status, 400);

    const download = await request.raw('/api/freeport/months/2026-09/spreadsheet.xlsx');
    assert.equal(download.status, 200);
    assert.match(download.headers.get('content-type'), /spreadsheetml/);
    assert.equal(download.headers.get('content-disposition'), 'attachment; filename="FMI-2026-09 Line Items.xlsx"');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(await download.arrayBuffer()));
    const sheet = workbook.getWorksheet('September 2026');
    assert.ok(sheet, 'sheet is named like the Google Sheet tabs');
    const cells = rowNumber => SPREADSHEET_COLUMNS.map((_, index) => sheet.getRow(rowNumber).getCell(index + 1).value);
    assert.deepEqual(cells(1), SPREADSHEET_COLUMNS);
    assert.equal(sheet.actualRowCount, 3);
    const labor = ['Tech Labor - Straight', null, 2, 'hr', 125, 'Work Order', 1328, 100000910001, null, 1060401328, null, 61120032, '91001-A', 'Mine Maintenance', 'ZD00000669'];
    assert.deepEqual(cells(2), labor);
    assert.deepEqual(cells(3), labor); // one row per technician
    assert.equal(sheet.getRow(2).getCell(8).numFmt, '0', 'order numbers show every digit in Excel');

    // Consolidated invoice and merged invoice pages.
    const consolidated = await request.raw('/api/freeport/months/2026-09/consolidated-invoice.pdf');
    assert.equal(consolidated.status, 200);
    assert.equal(consolidated.headers.get('content-type'), 'application/pdf');
    assert.equal(consolidated.headers.get('content-disposition'), 'attachment; filename="FMI-2026-09 Consolidated Invoice.pdf"');
    const consolidatedBytes = Buffer.from(await consolidated.arrayBuffer());
    const consolidatedPdf = await PDFDocument.load(consolidatedBytes);
    assert.equal(consolidatedPdf.getPageCount(), 1);
    assert.equal(consolidatedPdf.getTitle(), 'FMI-2026-09 Consolidated Invoice');
    const consolidatedText = pdfText(consolidatedBytes);
    for (const expected of ['FMI-2026-09', 'September 30, 2026', 'ZD00000669', 'Contract No. 33282200158-001', 'Attn: September 2026', 'Labor - September 2026', '$500.00', 'Amount Due']) {
      assert.ok(consolidatedText.includes(expected), `consolidated invoice shows ${expected}`);
    }

    const merged = await request.raw('/api/freeport/months/2026-09/invoices.pdf');
    assert.equal(merged.status, 200);
    assert.equal(merged.headers.get('content-disposition'), 'attachment; filename="FMI-2026-09 Invoices.pdf"');
    const mergedBytes = Buffer.from(await merged.arrayBuffer());
    assert.equal((await PDFDocument.load(mergedBytes)).getPageCount(), 1);
    const mergedText = pdfText(mergedBytes);
    for (const expected of ['91001-A', 'September 29, 2026', '100000910001', '1060401328', 'Tech Labor - Straight', '$250.00', 'Page 1 of 1']) {
      assert.ok(mergedText.includes(expected), `invoice page shows ${expected}`);
    }
    assert.ok(!mergedText.includes('October 6, 2026'), 'the invoice date from another month is not printed');

    // Admin changes need the separate admin unlock.
    assert.equal((await request('/api/freeport/settings', { method: 'PUT', body: config.settings })).status, 401);
    assert.equal((await request('/api/admin/login', { method: 'POST', body: { username: 'admin', password: 'admin-test' } })).status, 200);
    assert.equal((await request('/api/freeport/settings', { method: 'PUT', body: { ...config.settings, taxRate: 'nine' } })).status, 400);
    const settings = await request('/api/freeport/settings', { method: 'PUT', body: { ...config.settings, taxRate: '9.2' } });
    assert.equal(settings.status, 200);
    assert.equal(settings.body.settings.taxRate, '9.2');

    const clash = config.items.map(item => (item.sku === 'Primer' ? { ...item, sku: 'Urethane', priceCents: 8500 } : item));
    assert.equal((await request('/api/freeport/items', { method: 'PUT', body: { items: clash } })).status, 400);
    const items = await request('/api/freeport/items', { method: 'PUT', body: { items: [...config.items, { sku: 'Window Film', description: 'Window Film', unit: 'ea', type: 'Parts', priceCents: 4000 }] } });
    assert.equal(items.status, 200);
    assert.equal(items.body.items.length, config.items.length + 1);

    const accounts = await request('/api/freeport/accounts', { method: 'PUT', body: { accounts: config.accounts.map(account => (account.code === '2500001328' ? { ...account, usingAreaName: 'Leaching' } : account)) } });
    assert.equal(accounts.status, 200);
    assert.equal(accounts.body.accounts.find(account => account.code === '2500001328').usingAreaName, 'Leaching');

    // Items on saved invoices keep their type and per-line setting; normal items never keep a typed description.
    const usingWindshield = await request('/api/freeport/invoices', { method: 'POST', body: newInvoice({ number: '91004', installDate: '2026-07-15', lines: [
      { sku: 'Windshield', description: 'DW02153GTYN Windshield', quantity: '1', rateCents: 28500 },
      { sku: 'Urethane', description: 'left over from a windshield line', quantity: '1', rateCents: 8500 }
    ] }) });
    assert.equal(usingWindshield.status, 201, JSON.stringify(usingWindshield.body));
    assert.equal(usingWindshield.body.lines[0].description, 'DW02153GTYN Windshield');
    assert.equal(usingWindshield.body.lines[1].description, '');
    const inUse = (await request('/api/freeport/config')).body.items;
    assert.equal(inUse.find(item => item.sku === 'Windshield').inUse, true);
    assert.equal(inUse.find(item => item.sku === 'Freight / crating').inUse, false);
    const changeItem = changes => inUse.map(item => (item.sku === 'Windshield' ? { ...item, ...changes } : item));
    const flipped = await request('/api/freeport/items', { method: 'PUT', body: { items: changeItem({ customDescription: false }) } });
    assert.equal(flipped.status, 400);
    assert.match(flipped.body.error, /already on saved invoices/);
    assert.equal((await request('/api/freeport/items', { method: 'PUT', body: { items: changeItem({ type: 'Labor' }) } })).status, 400);
    assert.equal((await request('/api/freeport/items', { method: 'PUT', body: { items: changeItem({ priceCents: 29500 }) } })).status, 200, 'other fields can still change');
    assert.equal((await request('/api/freeport/invoices/91004?version=1', { method: 'DELETE' })).status, 200);

    await stopServer(server);
    server = await startServer(dataDir);
    const again = client();
    await again('/api/login', { method: 'POST', body: { username: 'mary', password: 'staff-test' } });
    const reloaded = await again('/api/freeport/config');
    assert.equal(reloaded.body.accounts.length, 14, 'setup data is not inserted twice');
    assert.equal(reloaded.body.settings.taxRate, '9.2');
    const kept = await again('/api/freeport/invoices/91001-A');
    assert.equal(kept.body.status, 'Ready');

    assert.equal((await again(`/api/freeport/invoices/91001-A?version=1`, { method: 'DELETE' })).status, 409);
    assert.equal((await again(`/api/freeport/invoices/91001-A?version=${kept.body.version}`, { method: 'DELETE' })).status, 200);
    assert.equal((await again('/api/freeport/invoices/91001-A')).status, 404);
  } finally {
    await stopServer(server);
  }
});

test('preview databases get sample Freeport invoices', { timeout: 30000 }, async () => {
  const server = await startServer(mkdtempSync(path.join(tmpdir(), 'boulevard-freeport-preview-')), true);
  try {
    const request = client();
    await request('/api/login', { method: 'POST', body: { username: 'mary', password: 'staff-test' } });
    const months = (await request('/api/freeport/months')).body;
    assert.deepEqual(months.map(entry => entry.month), ['2026-09', '2026-08']);
    assert.equal(months[0].needsReview, 2);
  } finally {
    await stopServer(server);
  }
});
