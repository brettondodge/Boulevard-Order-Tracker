import ExcelJS from 'exceljs';
import { SPREADSHEET_COLUMNS, spreadsheetRows } from '../../public/freeport-billing.js';

// Columns Freeport's sheet stores as numbers. Values that aren't plain digits
// (an invoice number with a dash, say) stay text rather than being mangled.
const CODE_COLUMNS = new Set(['COMPANY CODE', 'ORDER NUMBER', 'ACCOUNT CODE', 'EXPENSE ELEMENT', 'SUPPLIER REFERENCE']);
const AMOUNT_COLUMNS = new Set(['QUANTITY', 'UNIT RATE']);
const COLUMN_WIDTHS = { DESCRIPTION: 34, 'ORDER NUMBER': 16, 'ACCOUNT CODE': 14, 'EXPENSE ELEMENT': 16, 'SUPPLIER REFERENCE': 19, 'USING AREA NAME': 19, 'PO NUMBER': 14 };

function cellValue(column, value) {
  if (value === '' || value === null || value === undefined) return null;
  if (AMOUNT_COLUMNS.has(column)) return Number(value);
  if (CODE_COLUMNS.has(column) && /^[1-9]\d{0,14}$/.test(value)) return Number(value);
  return value;
}

export function spreadsheetSheetName(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(Date.UTC(year, monthNumber - 1, 1)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

export async function buildSpreadsheet(monthSummary, config) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = config.settings.businessName;
  const sheet = workbook.addWorksheet(spreadsheetSheetName(monthSummary.month), { views: [{ state: 'frozen', ySplit: 1 }] });

  sheet.columns = SPREADSHEET_COLUMNS.map(column => ({ header: column, key: column, width: COLUMN_WIDTHS[column] ?? Math.max(10, column.length + 2) }));
  // Excel's General format shows 12+ digit numbers (order numbers) as 1.00001E+11.
  for (const column of CODE_COLUMNS) sheet.getColumn(column).numFmt = '0';
  sheet.getRow(1).font = { bold: true };

  for (const row of spreadsheetRows(monthSummary, config)) {
    sheet.addRow(row.cells.map((value, index) => cellValue(SPREADSHEET_COLUMNS[index], value)));
  }
  return workbook.xlsx.writeBuffer();
}
