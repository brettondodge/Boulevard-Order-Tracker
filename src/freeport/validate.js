import {
  INVOICE_STATUSES,
  ITEM_TYPES,
  ITEM_UNITS,
  billingMonthFor,
  formatQuantity,
  isValidDate,
  isValidMonth,
  parseQuantity,
  parseTaxRate,
  pinMatchedItems,
  skuKey,
  summarizeInvoice
} from '../../public/freeport-billing.js';

export class FreeportError extends Error {
  constructor(status, message, details = {}) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

const invalid = (message, details) => new FreeportError(400, message, details);

function text(value, label, max, { required = false } = {}) {
  const result = typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
  if (required && !result) throw invalid(`${label} is required.`);
  if (result.length > max) throw invalid(`${label} must be ${max} characters or fewer.`);
  return result;
}

function optionalDate(value, label) {
  const result = text(value, label, 10);
  if (result && !isValidDate(result)) throw invalid(`${label} must be a valid date.`);
  return result;
}

function cents(value, label, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined || value === '')) return null;
  if (!Number.isInteger(value) || value < 0 || value > 100000000) throw invalid(`${label} must be a dollar amount.`);
  return value;
}

export function normalizeInvoiceInput(body = {}, config) {
  const number = text(body.number, 'Invoice number', 30, { required: true });
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(number)) throw invalid('Invoice number can only use letters, numbers and dashes.');

  const monthOverride = text(body.monthOverride, 'Billing month', 7);
  if (monthOverride && !isValidMonth(monthOverride)) throw invalid('Billing month must look like 2026-09.');

  const driveLink = text(body.driveLink, 'Google Drive link', 500);
  if (driveLink) {
    let url = null;
    try { url = new URL(driveLink); } catch {}
    if (!url || url.protocol !== 'https:') throw invalid('Google Drive link must start with https://');
  }

  const rawLines = Array.isArray(body.lines) ? body.lines : [];
  if (rawLines.length > 200) throw invalid('An invoice can have at most 200 line items.');
  const lines = rawLines.map((line, index) => {
    const label = `Line ${index + 1}`;
    const itemId = text(line?.itemId, `${label} item`, 60);
    const item = itemId ? config.items.find(candidate => candidate.id === itemId) : null;
    if (itemId && !item) throw invalid(`${label}: that item is no longer on the master list.`);
    const sku = item ? item.sku : text(line?.sku, `${label} SKU`, 120, { required: true });
    const quantity = parseQuantity(line?.quantity);
    if (!quantity) throw invalid(`${label}: quantity must be a number above zero (up to 3 decimals).`);
    return {
      sku,
      itemId: item ? item.id : '',
      description: text(line?.description, `${label} description`, 200),
      quantity: formatQuantity(quantity),
      rateCents: cents(line?.rateCents, `${label} rate`)
    };
  });

  const invoice = {
    lines: pinMatchedItems(lines, config.items),
    number,
    omegaDate: optionalDate(body.omegaDate, 'Invoice date'),
    installDate: optionalDate(body.installDate, 'Install date'),
    monthOverride,
    orderNumber: text(body.orderNumber, 'Order number', 40),
    accountCode: text(body.accountCode, 'Account code', 20),
    omegaTaxCents: cents(body.omegaTaxCents, 'Invoice tax', { nullable: true }),
    driveLink,
    notes: text(body.notes, 'Notes', 2000),
    status: INVOICE_STATUSES.includes(body.status) ? body.status : 'Needs review'
  };

  invoice.billingMonth = billingMonthFor(invoice);
  if (!invoice.billingMonth) throw invalid('Enter the install date so the invoice lands in a billing month.');

  if (invoice.status === 'Ready') {
    const { blockers } = summarizeInvoice(invoice, config);
    if (blockers.length) throw invalid('Fix these before marking the invoice ready.', { blockers });
  }
  return invoice;
}

export function normalizeSettingsInput(body = {}) {
  const settings = {
    poNumber: text(body.poNumber, 'PO number', 40, { required: true }),
    contractNumber: text(body.contractNumber, 'Contract number', 40, { required: true }),
    companyCode: text(body.companyCode, 'Company code', 20, { required: true }),
    taxRate: text(body.taxRate, 'Tax rate', 6, { required: true }),
    partsExpense: text(body.partsExpense, 'Parts expense element', 20, { required: true }),
    laborExpense: text(body.laborExpense, 'Labor expense element', 20, { required: true }),
    businessName: text(body.businessName, 'Business name', 120, { required: true }),
    businessAddress: text(body.businessAddress, 'Business address', 300),
    businessPhone: text(body.businessPhone, 'Phone', 40),
    rocNumber: text(body.rocNumber, 'AZ ROC #', 40),
    vendorId: text(body.vendorId, 'AZ Procure Vendor ID', 40),
    billTo: text(body.billTo, 'Bill to', 300, { required: true }),
    footerNote: text(body.footerNote, 'Footer note', 500)
  };
  if (parseTaxRate(settings.taxRate) === null) throw invalid('Tax rate must be a percent like 9.1');
  return settings;
}

export function normalizeAccountsInput(body = {}) {
  const rows = Array.isArray(body.accounts) ? body.accounts : [];
  const seen = new Set();
  return rows.map((row, index) => {
    const label = `Account row ${index + 1}`;
    const code = text(row?.code, `${label} code`, 20, { required: true });
    if (!/^\d+$/.test(code)) throw invalid(`${label}: code must be digits only.`);
    if (seen.has(code)) throw invalid(`Account code ${code} is listed twice.`);
    seen.add(code);
    return {
      code,
      name: text(row?.name, `${label} name`, 120, { required: true }),
      group: text(row?.group, `${label} area`, 60),
      usingAreaName: text(row?.usingAreaName, `${label} using area name`, 120, { required: true }),
      active: row?.active !== false
    };
  });
}

export function normalizeItemsInput(body = {}) {
  const rows = Array.isArray(body.items) ? body.items : [];
  const items = rows.map((row, index) => {
    const label = `Item row ${index + 1}`;
    const unit = text(row?.unit, `${label} unit`, 5);
    const type = text(row?.type, `${label} type`, 10);
    if (!ITEM_UNITS.includes(unit)) throw invalid(`${label}: unit must be ${ITEM_UNITS.join(' or ')}.`);
    if (!ITEM_TYPES.includes(type)) throw invalid(`${label}: type must be ${ITEM_TYPES.join(' or ')}.`);
    return {
      id: text(row?.id, `${label} id`, 60),
      sku: text(row?.sku, `${label} SKU`, 120, { required: true }),
      description: text(row?.description, `${label} description`, 200, { required: true }),
      unit,
      type,
      priceCents: cents(row?.priceCents, `${label} price`),
      customDescription: row?.customDescription === true,
      active: row?.active !== false
    };
  });

  // Two active items with the same SKU and price could never be told apart.
  const keys = new Set();
  for (const item of items.filter(candidate => candidate.active)) {
    const key = `${skuKey(item.sku)}|${item.priceCents}`;
    if (keys.has(key)) throw invalid(`Two active items share SKU "${item.sku}" and the same price, so invoice lines can't be matched. Change one or make it inactive.`);
    keys.add(key);
  }
  return items;
}
