import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProgressInput, orderStage } from '../src/utils.js';
import { importStatements, parseOrderSheet } from '../src/sheet-import.js';
import ExcelJS from 'exceljs';
import { syntheticOrderSheet } from './sheet-fixture.js';

test('stage is the furthest step reached', () => {
  assert.equal(orderStage({ date_received: '', expected_delivery_date: '2000-01-01' }), 'overdue');
  assert.equal(orderStage({ date_received: '', expected_delivery_date: '2999-01-01' }), 'ordered');
  assert.equal(orderStage({ date_received: '2026-10-01' }), 'received');
  assert.equal(orderStage({ date_received: '2026-10-01', job_scheduled: 1 }), 'scheduled');
  assert.equal(orderStage({ date_received: '2026-10-01', job_scheduled: 1, job_completed: 1 }), 'complete');
  assert.equal(orderStage({ date_received: '2026-10-01', job_completed: 1, invoiced: 1 }), 'invoiced');
  // Billed up front: still waiting to be scheduled.
  assert.equal(orderStage({ date_received: '2026-10-01', invoiced: 1 }), 'received');
  assert.equal(orderStage({ date_received: '2026-10-01', job_scheduled: 1, invoiced: 1 }), 'scheduled');
  // Not here yet beats scheduled: the material has to arrive first.
  assert.equal(orderStage({ date_received: '', job_scheduled: 1 }), 'ordered');
});

test('progress input clears dates that no longer apply and fills a completion date', () => {
  assert.deepEqual(normalizeProgressInput({ job_scheduled: false, scheduled_date: '2026-11-03', schedule_note: ' IGU ', job_completed: '1', invoiced: 'true', invoice_reference: ' 10239422 ' }), {
    job_scheduled: 0, scheduled_date: '', schedule_note: 'IGU', job_completed: 1, completed_date: normalizeProgressInput({ job_completed: 1 }).completed_date, invoiced: 1, invoice_reference: '10239422'
  });
  assert.match(normalizeProgressInput({ job_completed: 1 }).completed_date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(normalizeProgressInput({ job_completed: 1 }, { fillCompletedDate: false }).completed_date, '');
  assert.equal(normalizeProgressInput({ job_scheduled: 1, scheduled_date: 'not a date' }).scheduled_date, '');
});

test('the sheet import reads both order tabs and leaves out finished work', async () => {
  const plan = await parseOrderSheet(await syntheticOrderSheet(), { today: '2026-10-26' });
  assert.deepEqual(plan.tabs.map(tab => [tab.name, tab.imported, tab.skipped]), [['Window Orders', 4, 1], ['CW, Trulite, Arcadia & Glztech', 3, 1]]);
  assert.deepEqual(plan.skipped.map(row => [row.customer, row.reason]), [['Synthetic Done', 'Complete and billed'], ['Synthetic Glass Done', 'Complete and billed']]);
  const byName = Object.fromEntries(plan.orders.map(order => [order.customer_name, order]));

  const alpha = byName['Synthetic Alpha'];
  assert.equal(alpha.supplier, 'Jeld-Wen');
  assert.equal(alpha.category, 'Windows');
  assert.equal(alpha.date_ordered, '2026-09-24');
  assert.equal(alpha.date_received, '2026-10-23');
  assert.equal(alpha.shop_location, 'IGU Wall');
  assert.equal(alpha.invoice_reference, 'Material and labor @ $365 + tax');
  assert.equal(alpha.housecall_job_number, '');
  assert.equal(alpha.invoiced, 0);
  assert.equal(alpha.notes, 'Call first');
  assert.equal(byName['synthetic alpha'].schedule_note, 'IGU');
  // Every order stands on its own; nothing is grouped into jobs.
  assert.ok(plan.orders.every(order => !order.job_key));

  const bravo = byName['Synthetic Bravo'];
  assert.equal(bravo.supplier, 'Andersen');
  assert.equal(bravo.ordered_by, 'KL');
  assert.equal(bravo.date_ordered, '2026-08-25');
  assert.equal(bravo.job_scheduled, 1);
  assert.equal(bravo.job_completed, 1);
  assert.equal(bravo.invoiced, 0);
  assert.equal(bravo.housecall_job_number, '10238822');
  assert.match(bravo.notes, /Ordered by KLfor JC \(from the sheet\)/);
  assert.match(bravo.notes, /Delivery claim filed/);

  const noDate = byName['Synthetic No Date'];
  assert.equal(noDate.date_ordered, '2026-10-26');
  assert.equal(noDate.supplier, 'Unknown supplier (from sheet)');
  assert.equal(noDate.ordered_by, 'Unknown');
  assert.match(noDate.notes, /No order date in the sheet; used the import date/);

  const glass = byName['Synthetic Glass'];
  assert.equal(glass.category, 'Showers');
  assert.equal(glass.expected_delivery_date, '');
  assert.match(glass.notes, /Expected date in the sheet could not be read: "20206-08-10"/);
  assert.equal(glass.date_received, '2026-10-26');
  assert.equal(glass.schedule_note, 'Customer picking up');
  assert.equal(glass.invoiced, 1);
  assert.equal(glass.housecall_job_number, '14102178');
  assert.equal(byName['Synthetic Store'].category, 'Storefront');
  assert.equal(byName['Synthetic Store'].ordered_by, 'Unknown');
  assert.equal(byName['Synthetic Quote'].invoiced, 0);
  assert.equal(byName['Synthetic Quote'].job_completed, 1);
  assert.ok(!plan.orders.some(order => order.customer_name === 'Synthetic Warranty'));
  assert.deepEqual(plan.suppliers, ['Andersen', 'Arcadia', 'CW', 'Jeld-Wen', 'Oldcastle', 'Unknown supplier (from sheet)']);
  assert.deepEqual(plan.staff, ['AD', 'KL', 'RD', 'SD', 'Unknown']);
});

test('a file that is not the order sheet is refused', async () => {
  await assert.rejects(parseOrderSheet(Buffer.from('not a workbook'), { today: '2026-10-26' }));
});

test('import statements reuse existing names when adding and skip orders already present', async () => {
  const plan = await parseOrderSheet(await syntheticOrderSheet(), { today: '2026-10-26' });
  const existing = {
    suppliers: [{ id: 'sup-jw', name: 'jeld-wen', active: 0 }],
    staff: [{ id: 'staff-rd', name: 'RD' }],
    orders: [{ customer_name: 'Synthetic Alpha', supplier: 'Jeld-Wen', date_ordered: '2026-09-24' }]
  };
  const added = importStatements(plan, { mode: 'add', existing, now: '2026-10-26T00:00:00.000Z', actor: 'admin' });
  assert.equal(added.result.orders, 6);
  assert.equal(added.result.duplicates, 1);
  assert.equal(added.result.suppliers_added, 5);
  assert.equal(added.result.staff_added, 4);
  assert.ok(added.statements.some(statement => statement.sql.startsWith('UPDATE suppliers SET active = 1') && statement.params[1] === 'sup-jw'));
  assert.ok(!added.statements.some(statement => statement.sql.startsWith('DELETE')));
  assert.ok(!added.statements.some(statement => statement.sql.includes('INSERT INTO job_drafts')));

  const replaced = importStatements(plan, { mode: 'replace', existing, now: '2026-10-26T00:00:00.000Z', actor: 'admin' });
  assert.deepEqual(replaced.statements.slice(0, 4).map(statement => statement.sql), ['DELETE FROM orders', 'DELETE FROM job_drafts', 'DELETE FROM suppliers', 'DELETE FROM staff_names']);
  assert.equal(replaced.result.orders, 7);
  assert.equal(replaced.result.suppliers_added, 6);
});

test('supplier and staff names that differ only in capitals become one entry', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Window Orders');
  sheet.addRow(['Window Orders']);
  sheet.addRow(['Who Ordered', 'Customer', 'Vendor', 'Order Date']);
  sheet.addRow(['rd', 'Synthetic One', 'CW', new Date('2026-10-01T00:00:00Z')]);
  sheet.addRow(['RD', 'Synthetic Two', 'cw', new Date('2026-10-02T00:00:00Z')]);
  const plan = await parseOrderSheet(Buffer.from(await workbook.xlsx.writeBuffer()), { today: '2026-10-26' });
  assert.deepEqual(plan.suppliers, ['CW']);
  assert.deepEqual(plan.staff, ['RD']);
  assert.deepEqual(plan.orders.map(order => order.supplier), ['CW', 'CW']);
});

test('a finished job counts as finished even if one order was never ticked received', () => {
  assert.equal(orderStage({ date_received: '', job_completed: 1 }), 'complete');
  assert.equal(orderStage({ date_received: '', job_completed: 1, invoiced: 1 }), 'invoiced');
});

test('the sheet import refuses impossible dates, keeps names with "for" and lists customer-less rows', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Window Orders');
  sheet.addRow(['Window Orders']);
  sheet.addRow(['Who Ordered', 'Customer', 'Vendor', 'Order Date', 'Date to Received', 'Received', 'Job Scheduled', 'Shop Location', 'To Schedule', 'Job Complete', 'Billed -Invoice#', 'Del Claim', 'Billed Out', 'Notes']);
  sheet.addRow(['Ford', 'Synthetic Feb', 'JW', '2/30/2026', '1/5/99']);
  sheet.addRow(['Clifford', 'Synthetic Two Jobs', 'JW', '10/1/26', null, false, false, null, null, false, 11111111]);
  sheet.addRow(['KA for AD', 'Synthetic Two Jobs', 'AW', '10/2/26', null, false, false, null, null, false, 22222222]);
  sheet.addRow(['RD', null, 'JW', '10/3/26', null, false, false, null, null, false, null, false, false, 'stock']);
  sheet.addRow([null, null, null, null]);
  const plan = await parseOrderSheet(Buffer.from(await workbook.xlsx.writeBuffer()), { today: '2026-10-26' });
  const feb = plan.orders.find(order => order.customer_name === 'Synthetic Feb');
  assert.equal(feb.date_ordered, '2026-10-26');
  assert.equal(feb.missing_order_date, true);
  assert.match(feb.notes, /No order date in the sheet \("2\/30\/2026"\)/);
  assert.equal(feb.expected_delivery_date, '');
  assert.match(feb.notes, /Expected date in the sheet could not be read: "1\/5\/99"/);
  assert.deepEqual(plan.orders.map(order => order.ordered_by), ['FORD', 'CLIFFORD', 'KA']);
  assert.equal(plan.orders.find(order => order.housecall_job_number === '11111111').date_ordered, '2026-10-01');
  assert.deepEqual(plan.skipped.map(row => [row.row, row.reason]), [[6, 'No customer name']]);
});

test('re-running Add does not duplicate rows that had no order date', async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Window Orders');
  sheet.addRow(['Window Orders']);
  sheet.addRow(['Who Ordered', 'Customer', 'Vendor', 'Order Date']);
  sheet.addRow(['RD', 'Synthetic Undated', 'JW', null]);
  const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
  const firstRun = await parseOrderSheet(buffer, { today: '2026-10-26' });
  const secondRun = await parseOrderSheet(buffer, { today: '2026-10-27' });
  const existing = { suppliers: [], staff: [], orders: [{ customer_name: 'Synthetic Undated', supplier: 'Jeld-Wen', date_ordered: firstRun.orders[0].date_ordered }] };
  const again = importStatements(secondRun, { mode: 'add', existing, now: 'now', actor: 'admin' });
  assert.equal(again.result.orders, 0);
  assert.equal(again.result.duplicates, 1);
});
