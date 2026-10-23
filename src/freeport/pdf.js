import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { formatMoney, lineDescription } from '../../public/freeport-billing.js';
import { spreadsheetSheetName as monthLabel } from './spreadsheet.js';

// Letter-size pages in points.
const WIDTH = 612;
const HEIGHT = 792;
const MARGIN = 54;
const RIGHT = WIDTH - MARGIN;
const FOOTER_MIN_TOP = 96;
const FOOTER_MAX_NOTE_LINES = 5;
const HEADER_TEXT_WIDTH = 270;
const META_VALUE_WIDTH = 120;
const INK = rgb(0.13, 0.2, 0.29);
const MUTED = rgb(0.42, 0.47, 0.53);
const RULE = rgb(0.84, 0.87, 0.9);
const SHADE = rgb(0.95, 0.96, 0.97);

function lastDayOfMonth(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(Date.UTC(year, monthNumber, 0));
}

const longDate = date => date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const isoToDate = iso => new Date(`${iso}T12:00:00Z`);

// Invoices show quantities with at least two decimals, like 1.00 or 3.25.
function displayQuantity(quantity) {
  const [whole, fraction = ''] = String(quantity).split('.');
  return `${whole}.${fraction.padEnd(2, '0')}`;
}

// The standard PDF fonts only cover Windows-1252; anything else prints as "?"
// instead of failing the whole download.
const characterSets = new WeakMap();
function printable(font, value) {
  if (!characterSets.has(font)) characterSets.set(font, new Set(font.getCharacterSet()));
  const supported = characterSets.get(font);
  return [...String(value ?? '')].map(ch => (supported.has(ch.codePointAt(0)) ? ch : '?')).join('');
}

function wrapText(font, value, size, width) {
  const lines = [];
  let current = '';
  for (const word of printable(font, value).split(/\s+/).filter(Boolean)) {
    let piece = word;
    // Break a single word longer than the column.
    while (font.widthOfTextAtSize(piece, size) > width) {
      let cut = piece.length - 1;
      while (cut > 1 && font.widthOfTextAtSize(piece.slice(0, cut), size) > width) cut--;
      if (current) { lines.push(current); current = ''; }
      lines.push(piece.slice(0, cut));
      piece = piece.slice(cut);
    }
    const candidate = current ? `${current} ${piece}` : piece;
    if (font.widthOfTextAtSize(candidate, size) <= width) {
      current = candidate;
    } else {
      lines.push(current);
      current = piece;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

async function createDocument(title, settings) {
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setAuthor(settings.businessName);
  pdf.setCreator('Boulevard Glass Tools');
  const fonts = { regular: await pdf.embedFont(StandardFonts.Helvetica), bold: await pdf.embedFont(StandardFonts.HelveticaBold) };
  return { pdf, fonts };
}

// One page with small drawing helpers; y is the text baseline.
class Sheet {
  constructor(pdf, fonts) {
    this.page = pdf.addPage([WIDTH, HEIGHT]);
    this.fonts = fonts;
  }

  font(bold) {
    return bold ? this.fonts.bold : this.fonts.regular;
  }

  text(value, x, y, { size = 10, bold = false, color = INK } = {}) {
    const font = this.font(bold);
    this.page.drawText(printable(font, value), { x, y, size, font, color });
  }

  right(value, x, y, { size = 10, bold = false, color = INK } = {}) {
    const font = this.font(bold);
    const text = printable(font, value);
    this.page.drawText(text, { x: x - font.widthOfTextAtSize(text, size), y, size, font, color });
  }

  rule(y, { from = MARGIN, to = RIGHT, color = RULE, thickness = 0.75 } = {}) {
    this.page.drawLine({ start: { x: from, y }, end: { x: to, y }, thickness, color });
  }

  shade(y, height) {
    this.page.drawRectangle({ x: MARGIN, y, width: RIGHT - MARGIN, height, color: SHADE });
  }
}

// Business block on the left, "INVOICE" and labelled values on the right.
// Returns the y just below the taller of the two.
function drawHeader(sheet, settings, title, meta) {
  let left = HEIGHT - MARGIN - 14;
  for (const line of wrapText(sheet.fonts.bold, settings.businessName, 15, HEADER_TEXT_WIDTH)) {
    sheet.text(line, MARGIN, left, { size: 15, bold: true });
    left -= 17;
  }
  for (const part of [...settings.businessAddress.split('\n'), settings.businessPhone].filter(Boolean)) {
    for (const line of wrapText(sheet.fonts.regular, part, 9.5, HEADER_TEXT_WIDTH)) {
      sheet.text(line, MARGIN, left, { size: 9.5, color: MUTED });
      left -= 12.5;
    }
  }

  let right = HEIGHT - MARGIN - 16;
  sheet.right(title, RIGHT, right, { size: 20, bold: true });
  right -= 24;
  const valueWidth = (value, size) => sheet.fonts.bold.widthOfTextAtSize(printable(sheet.fonts.bold, value), size);
  for (const [label, value] of meta) {
    // A long invoice or order number shrinks a little; if it still doesn't fit
    // beside its label, it moves to its own line underneath.
    let size = 10;
    while (size > 8 && valueWidth(value, size) > META_VALUE_WIDTH) size -= 0.5;
    if (valueWidth(value, size) <= META_VALUE_WIDTH) {
      sheet.right(label, RIGHT - META_VALUE_WIDTH - 8, right, { size: 8.5, color: MUTED });
    } else {
      sheet.right(label, RIGHT, right, { size: 8.5, color: MUTED });
      right -= 12;
      while (size > 6 && valueWidth(value, size) > RIGHT - MARGIN - HEADER_TEXT_WIDTH - 20) size -= 0.5;
    }
    sheet.right(value, RIGHT, right, { size, bold: true });
    right -= 15;
  }
  return Math.min(left, right) - 6;
}

// Two labelled columns (e.g. BILL TO and FOR) between rules.
function drawParties(sheet, top, columns) {
  sheet.rule(top);
  let lowest = top;
  columns.forEach(([label, lines], index) => {
    const x = index === 0 ? MARGIN : WIDTH / 2 + 20;
    const width = index === 0 ? WIDTH / 2 + 20 - MARGIN - 14 : RIGHT - x;
    let y = top - 18;
    sheet.text(label, x, y, { size: 8, bold: true, color: MUTED });
    y -= 15;
    for (const part of lines.filter(Boolean)) {
      for (const line of wrapText(sheet.fonts.regular, part, 10, width)) {
        sheet.text(line, x, y, { size: 10 });
        y -= 13;
      }
    }
    lowest = Math.min(lowest, y);
  });
  sheet.rule(lowest - 4);
  return lowest - 4;
}

// Label/amount pairs aligned to the right edge; the last rows can be bold.
function drawTotals(sheet, top, rows) {
  let y = top;
  for (const { label, cents, strong, ruleAbove } of rows) {
    if (ruleAbove) {
      sheet.rule(y + 10, { from: RIGHT - 230 });
      y -= 4;
    }
    sheet.right(label, RIGHT - 110, y, { size: strong ? 11 : 10, bold: strong, color: strong ? INK : MUTED });
    sheet.right(formatMoney(cents), RIGHT, y, { size: strong ? 11 : 10, bold: strong });
    y -= strong ? 17 : 15;
  }
  return y;
}

// The license line plus the footer note, wrapped to the page and kept above the
// page-number line. The footer grows upward when the note is long.
function footerLayout(fonts, settings) {
  const wrap = text => wrapText(fonts.regular, text, 8.5, RIGHT - MARGIN);
  const license = wrap(`LICENSED-INSURED-BONDED AZ ROC# ${settings.rocNumber} ---- AZ Procure Vendor ID # ${settings.vendorId}`);
  let note = String(settings.footerNote || '').split(/\r?\n/).filter(part => part.trim()).flatMap(wrap);
  if (note.length > FOOTER_MAX_NOTE_LINES) note = [...note.slice(0, FOOTER_MAX_NOTE_LINES - 1), `${note[FOOTER_MAX_NOTE_LINES - 1]}…`];
  const lines = [...license, ...note];
  return { lines, top: Math.max(FOOTER_MIN_TOP, 70 + 11 * (lines.length - 1)) };
}

function drawFooter(sheet, footer, { left = '', right = '' } = {}) {
  sheet.rule(footer.top);
  footer.lines.forEach((line, index) => sheet.text(line, MARGIN, footer.top - 14 - index * 11, { size: 8.5, color: MUTED }));
  if (left || right) {
    sheet.text(left, MARGIN, 44, { size: 8, color: MUTED });
    sheet.right(right, RIGHT, 44, { size: 8, color: MUTED });
  }
}

// ---------- Consolidated invoice: the one Freeport writes the check from ----------

export async function buildConsolidatedInvoice(summary, config) {
  const { settings } = config;
  const label = monthLabel(summary.month);
  const { pdf, fonts } = await createDocument(`${summary.packageNumber} Consolidated Invoice`, settings);
  const sheet = new Sheet(pdf, fonts);

  let y = drawHeader(sheet, settings, 'INVOICE', [
    ['INVOICE NUMBER', summary.packageNumber],
    ['DATE', longDate(lastDayOfMonth(summary.month))],
    ['PO', settings.poNumber]
  ]);
  y = drawParties(sheet, y - 6, [
    ['BILL TO', settings.billTo.split('\n')],
    ['FOR', [`Contract No. ${settings.contractNumber}`, `Attn: ${label}`, `${summary.invoices.length} invoice${summary.invoices.length === 1 ? '' : 's'}`]]
  ]);

  y -= 26;
  sheet.shade(y - 6, 22);
  sheet.text('DESCRIPTION', MARGIN + 8, y, { size: 8.5, bold: true, color: MUTED });
  sheet.right('AMOUNT', RIGHT - 8, y, { size: 8.5, bold: true, color: MUTED });
  for (const [description, cents] of [[`Parts and Materials - ${label}`, summary.parts], [`Labor - ${label}`, summary.labor]]) {
    y -= 24;
    sheet.text(description, MARGIN + 8, y, { size: 10.5 });
    sheet.right(formatMoney(cents), RIGHT - 8, y, { size: 10.5 });
    sheet.rule(y - 9);
  }

  drawTotals(sheet, y - 34, [
    { label: 'Total Parts', cents: summary.parts },
    { label: 'Total Labor', cents: summary.labor },
    { label: 'Subtotal', cents: summary.parts + summary.labor },
    { label: `Tax (${settings.taxRate}% of parts)`, cents: summary.tax },
    { label: 'Invoice Total', cents: summary.total, strong: true, ruleAbove: true },
    { label: 'Amount Due', cents: summary.total, strong: true }
  ]);
  drawFooter(sheet, footerLayout(fonts, settings));
  return pdf.save();
}

// ---------- Merged invoices: one app-made page per invoice ----------

const COLUMNS = { quantity: MARGIN + 38, unit: MARGIN + 48, description: MARGIN + 84, rate: RIGHT - 82, amount: RIGHT - 8 };
const DESCRIPTION_WIDTH = COLUMNS.rate - 66 - COLUMNS.description;
const LINE_SIZE = 9.5;

function startInvoicePage(pdf, fonts, settings, invoice, continued, sheets) {
  const sheet = new Sheet(pdf, fonts);
  sheets.push(sheet);
  let y = drawHeader(sheet, settings, continued ? 'INVOICE (continued)' : 'INVOICE', [
    ['INVOICE NUMBER', invoice.number],
    ['INSTALL DATE', longDate(isoToDate(invoice.installDate))],
    ['ORDER NUMBER', invoice.orderNumber],
    ['PO', settings.poNumber]
  ]);
  y = drawParties(sheet, y - 6, [
    ['BILL TO', settings.billTo.split('\n')],
    ['ACCOUNT', [invoice.accountCode, invoice.account?.name ?? '', `Contract No. ${settings.contractNumber}`]]
  ]);

  y -= 26;
  sheet.shade(y - 6, 22);
  sheet.right('QTY', COLUMNS.quantity, y, { size: 8.5, bold: true, color: MUTED });
  sheet.text('UNIT', COLUMNS.unit, y, { size: 8.5, bold: true, color: MUTED });
  sheet.text('DESCRIPTION', COLUMNS.description, y, { size: 8.5, bold: true, color: MUTED });
  sheet.right('RATE', COLUMNS.rate, y, { size: 8.5, bold: true, color: MUTED });
  sheet.right('AMOUNT', COLUMNS.amount, y, { size: 8.5, bold: true, color: MUTED });
  return { sheet, y: y - 12 };
}

export async function buildInvoicePages(summary, config) {
  const { settings } = config;
  const label = monthLabel(summary.month);
  const { pdf, fonts } = await createDocument(`${summary.packageNumber} Invoices`, settings);
  const totalsHeight = 96;
  const footer = footerLayout(fonts, settings);
  const sheets = [];

  for (const invoice of summary.invoices) {
    let { sheet, y } = startInvoicePage(pdf, fonts, settings, invoice, false, sheets);
    for (const line of invoice.lines) {
      const wrapped = wrapText(fonts.regular, lineDescription(line), LINE_SIZE, DESCRIPTION_WIDTH);
      const rowHeight = 8 + wrapped.length * 12;
      if (y - rowHeight < footer.top + 16) ({ sheet, y } = startInvoicePage(pdf, fonts, settings, invoice, true, sheets));
      const baseline = y - 12;
      sheet.right(displayQuantity(line.quantity), COLUMNS.quantity, baseline, { size: LINE_SIZE });
      sheet.text(line.item?.unit ?? '', COLUMNS.unit, baseline, { size: LINE_SIZE });
      wrapped.forEach((text, index) => sheet.text(text, COLUMNS.description, baseline - index * 12, { size: LINE_SIZE }));
      sheet.right(formatMoney(line.rateCents), COLUMNS.rate, baseline, { size: LINE_SIZE });
      sheet.right(formatMoney(line.total), COLUMNS.amount, baseline, { size: LINE_SIZE });
      y -= rowHeight;
      sheet.rule(y);
    }
    if (y - totalsHeight < footer.top + 10) ({ sheet, y } = startInvoicePage(pdf, fonts, settings, invoice, true, sheets));
    drawTotals(sheet, y - 22, [
      { label: 'Parts', cents: invoice.parts },
      { label: 'Labor', cents: invoice.labor },
      { label: 'Subtotal', cents: invoice.parts + invoice.labor },
      { label: 'Tax', cents: invoice.tax },
      { label: 'Total', cents: invoice.total, strong: true, ruleAbove: true }
    ]);
  }

  // Footers go on last, once the page count is known.
  sheets.forEach((sheet, index) => drawFooter(sheet, footer, {
    left: `${summary.packageNumber} - ${label} invoices`,
    right: `Page ${index + 1} of ${sheets.length}`
  }));
  return pdf.save();
}
