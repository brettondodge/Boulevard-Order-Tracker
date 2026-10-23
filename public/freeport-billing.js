// Freeport billing rules shared by the server and the browser. Pure functions,
// no dependencies. Money is integer cents, quantities are integer thousandths,
// and the tax rate is in thousandths of a percent (9.1% = 9100), so every
// calculation is exact integer math with half-up rounding.

export const SPREADSHEET_COLUMNS = [
  'DESCRIPTION', 'Classification', 'QUANTITY', 'UNIT OF MEASURE', 'UNIT RATE', 'TYPE', 'COMPANY CODE',
  'ORDER NUMBER', 'WBS ELEMENT', 'ACCOUNT CODE', 'Cash Pay', 'EXPENSE ELEMENT', 'SUPPLIER REFERENCE',
  'USING AREA NAME', 'PO NUMBER'
];

export const INVOICE_STATUSES = ['Needs review', 'Ready'];
export const ITEM_TYPES = ['Parts', 'Labor'];
export const ITEM_UNITS = ['ea', 'hr'];
export const MAX_DAYS_INSTALL_BEFORE_INVOICE = 30;

// ---------- Parsing and formatting ----------

export function parseMoney(value) {
  const text = String(value ?? '').replace(/[$,\s]/g, '');
  const match = text.match(/^(\d{1,8})(?:\.(\d{1,2}))?$/);
  if (!match) return null;
  return Number(match[1]) * 100 + Number((match[2] || '').padEnd(2, '0'));
}

export function formatMoney(cents) {
  const sign = cents < 0 ? '-' : '';
  const absolute = Math.abs(cents);
  const dollars = Math.floor(absolute / 100).toLocaleString('en-US');
  return `${sign}$${dollars}.${String(absolute % 100).padStart(2, '0')}`;
}

// Plain decimal for the spreadsheet's UNIT RATE column, e.g. 18.5 or 299.28.
export function centsToDecimal(cents) {
  const whole = Math.floor(cents / 100);
  const fraction = String(cents % 100).padStart(2, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

export function parseQuantity(value) {
  const match = String(value ?? '').trim().match(/^(\d{1,5})(?:\.(\d{1,3}))?$/);
  if (!match) return null;
  const thousandths = Number(match[1]) * 1000 + Number((match[2] || '').padEnd(3, '0'));
  return thousandths > 0 ? thousandths : null;
}

export function formatQuantity(thousandths) {
  const whole = Math.floor(thousandths / 1000);
  const fraction = String(thousandths % 1000).padStart(3, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : String(whole);
}

export function parseTaxRate(value) {
  const match = String(value ?? '').trim().match(/^(\d{1,2})(?:\.(\d{1,3}))?$/);
  if (!match) return null;
  return Number(match[1]) * 1000 + Number((match[2] || '').padEnd(3, '0'));
}

export function lineTotal(quantityThousandths, rateCents) {
  return Math.floor((quantityThousandths * rateCents + 500) / 1000);
}

export function taxOnParts(partsCents, taxRate) {
  const rate = parseTaxRate(taxRate) ?? 0;
  return Math.floor((partsCents * rate + 50000) / 100000);
}

// ---------- Dates ----------

export function isValidDate(value) {
  const match = String(value ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1]) && date.getUTCMonth() === Number(match[2]) - 1 && date.getUTCDate() === Number(match[3]);
}

export function isValidMonth(value) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value ?? ''));
}

function daysBetween(fromIso, toIso) {
  const [a, b] = [fromIso, toIso].map(iso => Date.UTC(Number(iso.slice(0, 4)), Number(iso.slice(5, 7)) - 1, Number(iso.slice(8, 10))));
  return Math.round((b - a) / 86400000);
}

// The install date decides the month. The invoice date is only a fallback
// so a record without an install date still shows up somewhere (flagged).
export function billingMonthFor(invoice) {
  if (isValidMonth(invoice.monthOverride)) return invoice.monthOverride;
  if (isValidDate(invoice.installDate)) return invoice.installDate.slice(0, 7);
  if (isValidDate(invoice.omegaDate)) return invoice.omegaDate.slice(0, 7);
  return '';
}

// ---------- Item matching ----------

export function skuKey(sku) {
  return String(sku ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

// Per-line description items with a list price of 0 have their price entered on each line.
export function hasListPrice(item) {
  return !(item.customDescription && item.priceCents === 0);
}

// A line matches by explicit pick, then by SKU. While one SKU still covers
// several glass sizes, the billed price decides which size it is. The item is
// found before quantity and rate are checked, so the screen can show its unit,
// type and description box while those are still being typed.
export function matchLine(line, items) {
  const quantity = parseQuantity(line.quantity);
  const hasRate = Number.isInteger(line.rateCents);
  const total = quantity && hasRate ? lineTotal(quantity, line.rateCents) : 0;
  const result = { ...line, total, item: null, issue: '', warning: '' };

  let item = line.itemId ? items.find(candidate => candidate.id === line.itemId) : null;
  if (!item) {
    const candidates = items.filter(candidate => candidate.active && skuKey(candidate.sku) === skuKey(line.sku));
    if (!candidates.length) {
      return { ...result, issue: line.sku ? `SKU "${line.sku}" is not on the item master list` : 'Pick an item' };
    }
    item = candidates.length === 1 ? candidates[0] : candidates.find(candidate => hasRate && candidate.priceCents === line.rateCents);
    if (!item) return { ...result, issue: hasRate ? `Price matches no "${line.sku}" size; pick one` : 'Rate is missing' };
  }

  if (!quantity) return { ...result, item, issue: 'Quantity must be a number above zero' };
  if (!hasRate) return { ...result, item, issue: 'Rate is missing' };
  // Per-line description items (windshields, special-order parts) carry their own description.
  if (item.customDescription && !String(line.description ?? '').trim()) {
    return { ...result, item, issue: 'Type the description for the spreadsheet' };
  }
  const warning = !hasListPrice(item) || item.priceCents === line.rateCents ? '' : `Billed ${formatMoney(line.rateCents)}, list price ${formatMoney(item.priceCents)}`;
  return { ...result, item, warning };
}

export function lineDescription(line) {
  if (!line.item) return String(line.description || line.sku || '');
  return line.item.customDescription ? String(line.description ?? '').trim() : line.item.description;
}

// Records the item each line matched when it's saved, so later price edits,
// deactivations or SKU renames on the master list can't re-match saved invoices.
export function pinMatchedItems(lines, items) {
  return lines.map(line => {
    const { item } = matchLine(line, items);
    return item ? { ...line, itemId: item.id } : line;
  });
}

// ---------- Invoice and month summaries ----------

export function summarizeInvoice(invoice, config) {
  const { settings, items, accounts } = config;
  const lines = (invoice.lines || []).map(line => matchLine(line, items));
  const sum = predicate => lines.filter(predicate).reduce((total, line) => total + line.total, 0);
  const parts = sum(line => line.item?.type === 'Parts');
  const labor = sum(line => line.item?.type === 'Labor');
  const unmatched = sum(line => !line.item);
  const expectedTax = taxOnParts(parts, settings.taxRate);
  const tax = Number.isInteger(invoice.omegaTaxCents) ? invoice.omegaTaxCents : expectedTax;
  const account = accounts.find(candidate => candidate.code === invoice.accountCode) || null;
  const billingMonth = billingMonthFor(invoice);

  const blockers = [];
  const warnings = [];
  if (!lines.length) blockers.push('Add at least one line item');
  if (!isValidDate(invoice.installDate)) blockers.push('Install date is missing');
  if (!String(invoice.orderNumber ?? '').trim()) blockers.push('Order number is missing');
  if (!invoice.accountCode) blockers.push('Account code is missing');
  else if (!account) blockers.push(`Account code ${invoice.accountCode} is not on the account list`);
  lines.forEach((line, index) => {
    if (line.issue) blockers.push(`Line ${index + 1}: ${line.issue}`);
    if (line.warning) warnings.push(`Line ${index + 1}: ${line.warning}`);
  });
  // Imported invoices must still be billable in Omega and add up to Omega's subtotal.
  if (invoice.omegaFlag) blockers.push(`${invoice.omegaFlag}: delete this invoice, or fix it in Omega and import again`);
  if (Number.isInteger(invoice.omegaSubtotalCents) && parts + labor + unmatched !== invoice.omegaSubtotalCents) {
    blockers.push(`Lines add up to ${formatMoney(parts + labor + unmatched)}, but Omega's subtotal is ${formatMoney(invoice.omegaSubtotalCents)}`);
  }

  if (isValidDate(invoice.installDate) && isValidDate(invoice.omegaDate)) {
    const days = daysBetween(invoice.installDate, invoice.omegaDate);
    if (days < 0) warnings.push('Install date is after the invoice date');
    else if (days > MAX_DAYS_INSTALL_BEFORE_INVOICE) warnings.push(`Installed ${days} days before it was invoiced; check the install date`);
  }
  if (Number.isInteger(invoice.omegaTaxCents) && Math.abs(invoice.omegaTaxCents - expectedTax) > 1) {
    warnings.push(`Invoice tax ${formatMoney(invoice.omegaTaxCents)} differs from ${settings.taxRate}% of parts (${formatMoney(expectedTax)})`);
  }
  if (isValidMonth(invoice.monthOverride) && isValidDate(invoice.installDate) && invoice.monthOverride !== invoice.installDate.slice(0, 7)) {
    warnings.push(`Billing month set by hand; install date is in ${invoice.installDate.slice(0, 7)}`);
  }

  return {
    ...invoice,
    lines,
    account,
    billingMonth,
    parts,
    labor,
    unmatched,
    expectedTax,
    tax,
    total: parts + labor + unmatched + tax,
    blockers,
    warnings
  };
}

export function summarizeMonth(month, invoices, config) {
  const summaries = invoices
    .map(invoice => summarizeInvoice(invoice, config))
    .sort((a, b) => (a.installDate || a.omegaDate || '').localeCompare(b.installDate || b.omegaDate || '') || a.number.localeCompare(b.number));
  const parts = summaries.reduce((total, invoice) => total + invoice.parts, 0);
  const labor = summaries.reduce((total, invoice) => total + invoice.labor, 0);
  const tax = taxOnParts(parts, config.settings.taxRate);
  return {
    month,
    invoices: summaries,
    parts,
    labor,
    tax,
    invoiceTaxTotal: summaries.reduce((total, invoice) => total + invoice.tax, 0),
    unmatched: summaries.reduce((total, invoice) => total + invoice.unmatched, 0),
    total: parts + labor + tax,
    // A Ready invoice that has since picked up a blocker still needs review.
    needsReview: summaries.filter(invoice => invoice.status !== 'Ready' || invoice.blockers.length),
    packageNumber: `FMI-${month}`
  };
}

export function spreadsheetRows(monthSummary, config) {
  const { settings } = config;
  return monthSummary.invoices.flatMap(invoice => invoice.lines.map(line => ({
    flagged: !line.item || Boolean(line.issue),
    cells: [
      lineDescription(line),
      '',
      line.quantity,
      line.item?.unit ?? '',
      Number.isInteger(line.rateCents) ? centsToDecimal(line.rateCents) : '',
      'Work Order',
      settings.companyCode,
      invoice.orderNumber,
      '',
      invoice.accountCode,
      '',
      line.item ? (line.item.type === 'Labor' ? settings.laborExpense : settings.partsExpense) : '',
      invoice.number,
      invoice.account?.usingAreaName ?? '',
      settings.poNumber
    ]
  })));
}
