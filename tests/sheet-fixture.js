import ExcelJS from 'exceljs';

const d = text => new Date(`${text}T00:00:00Z`);

// A made-up workbook shaped like the office's "Misc. Parts Ordered" sheet.
// Synthetic names only; never put real customer rows in tests.
export async function syntheticOrderSheet() {
  const workbook = new ExcelJS.Workbook();
  const windows = workbook.addWorksheet('Window Orders');
  windows.addRow(['Window Orders', 'Window Orders', null, null, null, null, null, null, null, null, 'No Invoice or $$ = Red']);
  windows.addRow(['Who Ordered', 'Customer', 'Vendor', 'Order Date', 'Date to Received', 'Received', 'Job Scheduled', 'Shop Location', 'To Schedule', 'Job Complete', 'Billed -Invoice#', 'Del Claim', 'Billed Out', 'Notes']);
  windows.addRow(['RD', 'Synthetic Alpha', 'JW', d('2026-09-24'), d('2026-10-23'), true, false, 'IGU Wall', null, false, 'Material and labor @ $365 + tax', false, false, 'Call first']);
  windows.addRow(['KLfor JC', 'Synthetic Bravo', 'AW', '08-25-26 (9/3)', d('2026-09-25'), true, true, 'A', null, true, 10238822, true, false]);
  windows.addRow(['BD', 'Synthetic Done', 'JW', d('2026-08-01'), d('2026-08-20'), true, true, null, null, true, 10230000, false, true]);
  windows.addRow([null, 'Synthetic No Date', null, null, d('2026-11-06'), false, false, null, null, false, null, false, false]);
  windows.addRow(['SD', 'synthetic alpha', 'JW', d('2026-10-01'), d('2026-11-02'), false, false, null, 'IGU', false, null, false, false]);
  const glass = workbook.addWorksheet('CW, Trulite, Arcadia & Glztech ');
  glass.addRow(['CW, Trulite, Arcadia & Glztech ORDERS']);
  glass.addRow(['Who Ordered', 'Customer', 'Vendor', 'Order Date', 'Date to Receive', 'Received', 'Job Scheduled', 'Pending date to schedule', 'Job Complete', 'Sales Order & Invoice', 'Emailed', 'Qty- Glass Panel', 'Qty- Hardware Complete', 'Notes']);
  glass.addRow(['AD', 'Synthetic Glass', 'Oldcastle', d('2026-07-22'), '20206-08-10', true, false, 'Customer picking up', false, 14102178, false]);
  glass.addRow(['?', 'Synthetic Store', 'Arcadia', d('2026-10-10'), null, false, false, null, false, null, false]);
  glass.addRow(['RD', 'Synthetic Glass Done', 'CW', d('2026-06-01'), null, true, true, null, true, '14087033- Sales Order: 3630415', false]);
  glass.addRow(['RD', 'Synthetic Quote', 'CW', d('2026-09-01'), d('2026-09-10'), true, true, null, true, 'Selling at $827 + tax', false]);
  const other = workbook.addWorksheet('Autoglass Warranties');
  other.addRow(['Fixed?', 'Name', 'Inv #:', 'Customer name:']);
  other.addRow([false, 'KA', 10215147, 'Synthetic Warranty']);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
