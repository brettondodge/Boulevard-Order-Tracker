import {
  formatMoney,
  formatQuantity,
  isValidDate,
  lineTotal,
  matchLine,
  parseMoney,
  parseQuantity,
  skuKey,
  summarizeInvoice
} from '../../public/freeport-billing.js';
import { todayPhoenixString } from '../utils.js';
import { FreeportError, normalizeInvoiceInput } from './validate.js';
import { createInvoice, findInvoiceNumbers, flagOmegaInvoice, getInvoice, listInvoices, lockedMonths, saveOmegaSnapshot, updateInvoice } from './store.js';
import { spreadsheetSheetName as monthLabel } from './spreadsheet.js';

// Read-only client for the Omega EDI API (GET requests only). The key lives in
// the server environment (OMEGA_API_KEY), never in the database or the browser.
const DEFAULT_BASE = 'https://app.omegaedi.com/api/2.0';
const PAGE_SIZE = 100;
const MAX_PAGES = 30;
const MAX_RANGE_DAYS = 124;
const WORK_ORDER_LOOKBACK_MONTHS = 4;
const MAX_RECHECKS = 200;
const INVOICED = new Set(['IN', 'CL']); // invoices and archived invoices
const WORK_ORDER = 'WO';
const STATUS_NAMES = { WO: 'a work order', QO: 'a quote', LE: 'a lead', VO: 'void' };

export const omegaConnected = () => Boolean(process.env.OMEGA_API_KEY);

async function omegaGet(path, { allowNotFound = false } = {}) {
  const key = process.env.OMEGA_API_KEY;
  if (!key) throw new FreeportError(503, "Omega isn't connected. Add OMEGA_API_KEY to the server settings.");
  let response;
  try {
    response = await fetch(`${process.env.OMEGA_API_BASE || DEFAULT_BASE}${path}`, {
      headers: { api_key: key, Accept: 'application/json' },
      signal: AbortSignal.timeout(20000)
    });
  } catch {
    throw new FreeportError(502, "Couldn't reach Omega. Try again in a minute.");
  }
  if (response.status === 404 && allowNotFound) return null;
  if (response.status === 401 || response.status === 403) throw new FreeportError(502, 'Omega rejected the API key. Check OMEGA_API_KEY.');
  if (response.status === 429) throw new FreeportError(502, 'Omega is limiting requests right now. Wait a minute and try again.');
  if (!response.ok) throw new FreeportError(502, `Omega returned an error (${response.status}). Try again in a minute.`);
  try {
    return await response.json();
  } catch {
    throw new FreeportError(502, "Omega sent a response the app couldn't read.");
  }
}

// Omega's date1/date2 filter on the job's document date: the invoice date for
// invoices, and the day it was written up for work orders.
async function listJobs(from, to) {
  const jobs = new Map();
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = await omegaGet(`/Invoices?date1=${from}&date2=${to}&page=${page}`);
    if (!Array.isArray(batch)) throw new FreeportError(502, "Omega sent a job list the app couldn't read.");
    for (const job of batch) jobs.set(String(job.id), job);
    if (batch.length < PAGE_SIZE) return [...jobs.values()];
  }
  throw new FreeportError(400, 'That date range has too many Omega jobs to check at once. Pick a shorter range.');
}

const omegaDate = value => (isValidDate(String(value ?? '').slice(0, 10)) ? String(value).slice(0, 10) : '');
const labelKey = label => String(label ?? '').toLowerCase().replace(/[^a-z]/g, '');
const isFreeport = (job, settings) => String(job.account_company ?? '').trim().toLowerCase() === String(settings.omegaAccountName ?? '').trim().toLowerCase();

function nextMonth(month) {
  const [year, number] = month.split('-').map(Number);
  return number === 12 ? `${year + 1}-01` : `${year}-${String(number + 1).padStart(2, '0')}`;
}

// Why an Omega job (list row or invoice detail) can't be billed to Freeport, or ''.
function notBillableReason(job, settings) {
  if (!isFreeport(job, settings)) return 'No longer billed to Freeport in Omega';
  const status = String(job.job_status);
  if (INVOICED.has(status)) return '';
  return status === 'VO' ? 'Voided in Omega' : `Now ${STATUS_NAMES[status] || status} in Omega`;
}

function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

function checkRange(from, to) {
  if (!isValidDate(from) || !isValidDate(to)) throw new FreeportError(400, 'Choose a From and To date.');
  if (from > to) throw new FreeportError(400, 'The From date must be on or before the To date.');
  if (daysBetween(from, to) > MAX_RANGE_DAYS) throw new FreeportError(400, 'Pick a range of about four months or less.');
}

// Turns an Omega job into an app invoice plus a snapshot of exactly what Omega
// said. Lines match by SKU; older invoices use one SKU for every glass size, so
// Omega's description (the size) is tried next. Unmatched lines keep
// "part number + description" for the per-line items.
export function mapOmegaInvoice(job, detail, items) {
  const notes = [];
  const lines = [];
  const omegaLines = [];
  for (const [index, item] of (Array.isArray(detail.Items) ? detail.Items : []).entries()) {
    const sku = String(item.sku || item.final_sku || '').trim();
    const description = String(item.description ?? '').trim();
    const rawQuantity = String(item.quantity ?? '').trim();
    if (Number(rawQuantity) === 0) {
      notes.push(`Skipped Omega line ${index + 1} (${sku || 'no SKU'}, quantity ${rawQuantity || 'blank'})`);
      continue;
    }
    const quantity = parseQuantity(rawQuantity);
    if (!quantity) return { problem: `Omega line ${index + 1} (${sku || 'no SKU'}) has quantity ${rawQuantity}. Credits and returns can't be imported yet.` };
    const rateCents = parseMoney(item.price);
    if (rateCents === null) return { problem: `Omega line ${index + 1} (${sku || 'no SKU'}) has a price the app can't read: ${item.price}` };

    const line = { sku, itemId: '', description: '', quantity: formatQuantity(quantity), rateCents };
    omegaLines.push({ sku, description, quantity: line.quantity, rateCents });
    const partText = description && !skuKey(description).startsWith(skuKey(sku)) ? `${sku} ${description}`.trim() : description || sku;
    const matched = matchLine(line, items).item;
    if (matched) {
      if (matched.customDescription) line.description = partText;
    } else {
      const byDescription = description && items.find(candidate => candidate.active && !candidate.customDescription
        && (skuKey(candidate.sku) === skuKey(description) || skuKey(candidate.description) === skuKey(description)));
      if (byDescription) line.itemId = byDescription.id;
      else line.description = partText;
    }
    lines.push(line);
  }

  const customField = (...labels) => (detail.InvoiceCustomFields || []).find(field => labels.includes(labelKey(field.label)))?.currentValue;
  const orderNumber = String(customField('orderno', 'ordernumber') ?? '').trim();
  const equipmentNumber = String(customField('equipmentno', 'equipmentnumber') ?? '').trim();
  const serialNumber = String(customField('serialno', 'serialnumber') ?? '').trim();
  // Omega's ACCOUNT NO. dropdown gives "1060401328 - Mine Maintenance - Truck"; the leading code is used.
  const rawAccount = String(customField('accountno', 'accountcode', 'accountnumber') ?? '').trim();
  const accountCode = rawAccount.match(/^(\d{6,})\b/)?.[1] ?? '';
  if (rawAccount && !accountCode) notes.push(`ACCOUNT NO. "${rawAccount}" in Omega isn't a code number`);
  const installDate = omegaDate(job.appointment_scheduled_date) || omegaDate(detail.appointment_scheduled_date);
  if (!installDate) notes.push('No scheduled (install) date in Omega');
  if (!orderNumber) notes.push('No ORDER NO. in Omega');

  const subtotalCents = parseMoney(detail.invoice_amount ?? job.invoice_amount);
  const linesSubtotal = lines.reduce((sum, line) => sum + lineTotal(parseQuantity(line.quantity), line.rateCents), 0);
  if (subtotalCents !== null && subtotalCents !== linesSubtotal) {
    notes.push(`Omega subtotal ${formatMoney(subtotalCents)}, but the lines add up to ${formatMoney(linesSubtotal)}`);
  }

  const invoice = {
    number: String(detail.id ?? job.id),
    omegaDate: omegaDate(detail.date) || omegaDate(job.date) || omegaDate(detail.document_date),
    installDate,
    orderNumber,
    accountCode,
    equipmentNumber,
    serialNumber,
    omegaTaxCents: parseMoney(detail.invoice_tax ?? job.invoice_tax),
    lines
  };
  const snapshot = {
    omegaDate: invoice.omegaDate,
    installDate,
    orderNumber,
    accountCode,
    equipmentNumber,
    serialNumber,
    omegaTaxCents: invoice.omegaTaxCents,
    subtotalCents,
    lines: omegaLines,
    flag: ''
  };
  return { invoice, snapshot, notes };
}

const SNAPSHOT_FIELDS = [
  ['omegaDate', 'invoice date'], ['installDate', 'install date'], ['orderNumber', 'order number'], ['accountCode', 'account code'],
  ['equipmentNumber', 'equipment number'], ['serialNumber', 'serial number'],
  ['omegaTaxCents', 'tax'], ['subtotalCents', 'subtotal'], ['lines', 'line items'], ['flag', 'Omega status']
];
const INVOICE_FIELDS = new Set(['omegaDate', 'installDate', 'orderNumber', 'accountCode', 'equipmentNumber', 'serialNumber', 'omegaTaxCents']);
// Reference-only fields: filling them in doesn't send a Ready invoice back to review.
const REFERENCE_FIELDS = new Set(['equipmentNumber', 'serialNumber']);

// Lines Omega didn't change keep the app's version (item picked, description
// typed); only added or changed lines are mapped fresh. Lines are matched by
// content, so a line Omega inserted or removed elsewhere doesn't shift the rest.
function mergeLines(beforeLines, afterLines, appLines, mappedLines) {
  if (appLines.length !== beforeLines.length) return mappedLines;
  const unused = beforeLines.map((line, index) => ({ key: JSON.stringify(line), index }));
  return mappedLines.map((line, index) => {
    const match = unused.findIndex(entry => entry.key === JSON.stringify(afterLines[index]));
    if (match < 0) return line;
    const [{ index: oldIndex }] = unused.splice(match, 1);
    return appLines[oldIndex];
  });
}

// What Omega changed since the last import. Edits made in the app are not
// compared, so they never show up as "changed in Omega" or get overwritten.
function omegaChanges(before, after) {
  return SNAPSHOT_FIELDS.filter(([field]) => JSON.stringify(before[field] ?? null) !== JSON.stringify(after[field] ?? null));
}

// Starts from the saved invoice and applies only what Omega changed. An empty
// Omega value never blanks something filled in on the app.
function mergeImport(existing, before, mapped, changes) {
  const body = {
    number: existing.number, omegaDate: existing.omegaDate, installDate: existing.installDate, monthOverride: existing.monthOverride,
    orderNumber: existing.orderNumber, accountCode: existing.accountCode, omegaTaxCents: existing.omegaTaxCents,
    equipmentNumber: existing.equipmentNumber, serialNumber: existing.serialNumber,
    driveLink: existing.driveLink, notes: existing.notes, lines: existing.lines,
    status: changes.every(([field]) => REFERENCE_FIELDS.has(field)) ? existing.status : 'Needs review'
  };
  for (const [field] of changes) {
    if (field === 'lines') body.lines = mergeLines(before.lines || [], mapped.snapshot.lines, existing.lines, mapped.invoice.lines);
    else if (INVOICE_FIELDS.has(field) && mapped.invoice[field] !== '' && mapped.invoice[field] !== null) body[field] = mapped.invoice[field];
  }
  return body;
}

const jobDates = job => ({ number: String(job.id), installDate: omegaDate(job.appointment_scheduled_date), omegaDate: omegaDate(job.date) });

function previewRow(action, invoice, config, extra = {}) {
  const summary = invoice ? summarizeInvoice(invoice, config) : null;
  return {
    action,
    number: invoice?.number ?? extra.number,
    installDate: invoice?.installDate ?? extra.installDate ?? '',
    omegaDate: invoice?.omegaDate ?? extra.omegaDate ?? '',
    billingMonth: invoice?.billingMonth ?? '',
    orderNumber: invoice?.orderNumber ?? '',
    lineCount: invoice?.lines.length ?? 0,
    totalCents: summary?.total ?? 0,
    blockers: summary?.blockers.length ?? 0,
    notes: extra.notes ?? [],
    changes: extra.changes ?? [],
    reason: extra.reason ?? ''
  };
}

async function planInvoice(job, config) {
  const detail = await omegaGet(`/Invoices/${encodeURIComponent(job.id)}`);
  const mapped = mapOmegaInvoice(job, detail, config.items);
  if (mapped.problem) return { row: previewRow('skip', null, config, { ...jobDates(job), reason: mapped.problem }) };

  const existing = await getInvoice(mapped.invoice.number);
  const stored = { omegaFlag: '', omegaSubtotalCents: mapped.snapshot.subtotalCents };
  if (!existing) {
    const invoice = normalizeInvoiceInput({ ...mapped.invoice, status: 'Needs review' }, config, stored);
    const preview = { ...invoice, omegaSubtotalCents: mapped.snapshot.subtotalCents };
    return { invoice, snapshot: mapped.snapshot, row: previewRow('new', preview, config, { notes: mapped.notes }) };
  }

  if (!existing.omegaSnapshot) {
    // Saved before the app kept Omega's values: take today's as the baseline
    // (saved at import) without changing the invoice.
    return { adopt: true, existing, snapshot: mapped.snapshot, row: previewRow('unchanged', existing, config, { notes: mapped.notes }) };
  }
  const before = existing.omegaSnapshot;
  const changes = omegaChanges(before, mapped.snapshot);
  if (!changes.length) return { row: previewRow('unchanged', existing, config, { notes: mapped.notes }) };
  const invoice = normalizeInvoiceInput(mergeImport(existing, before, mapped, changes), config, stored);
  const backToReview = existing.status === 'Ready' && invoice.status !== 'Ready';
  const notes = backToReview ? [...mapped.notes, 'Was Ready; goes back to Needs review'] : mapped.notes;
  const preview = { ...invoice, omegaSubtotalCents: mapped.snapshot.subtotalCents };
  return { invoice, existing, snapshot: mapped.snapshot, row: previewRow('update', preview, config, { notes, changes: changes.map(([, label]) => label) }) };
}

async function buildImport({ from, to }, config) {
  checkRange(from, to);
  const jobs = await listJobs(from, to);
  const billable = job => isFreeport(job, config.settings) && INVOICED.has(String(job.job_status));
  const plan = [];

  for (const job of jobs.filter(billable)) {
    try {
      plan.push(await planInvoice(job, config));
    } catch (error) {
      if (!(error instanceof FreeportError) || error.status >= 500) throw error;
      plan.push({ row: previewRow('skip', null, config, { ...jobDates(job), reason: error.message }) });
    }
  }

  // Invoices already imported that Omega has since voided, turned back into
  // something else, or moved off the Freeport account.
  const planned = new Set(plan.map(entry => entry.row.number));
  const flagEntry = (existing, flag) => (existing.omegaFlag === flag
    ? { row: previewRow('unchanged', existing, config, { reason: flag }) }
    : { existing, snapshot: { ...existing.omegaSnapshot, flag }, row: previewRow('flag', existing, config, { reason: flag }) });
  const others = jobs.filter(job => !billable(job));
  const known = await findInvoiceNumbers(others.map(job => String(job.id)));
  for (const job of others.filter(candidate => known.has(String(candidate.id)))) {
    const existing = await getInvoice(String(job.id));
    if (!existing?.omegaSnapshot) continue; // entered by hand, not from Omega
    planned.add(existing.number);
    plan.push(flagEntry(existing, notBillableReason(job, config.settings)));
  }

  // A voided invoice is often re-issued with a later invoice date, outside this
  // range, while both bill the same month. So every month this import touches
  // has its other imported invoices re-checked directly in Omega.
  const months = new Set(plan.map(entry => entry.row.billingMonth).filter(Boolean));
  for (let month = from.slice(0, 7); month <= to.slice(0, 7); month = nextMonth(month)) months.add(month);
  let rechecks = 0;
  for (const month of [...months].sort()) {
    for (const existing of await listInvoices(month)) {
      if (planned.has(existing.number) || !existing.omegaSnapshot || existing.omegaFlag) continue;
      if (++rechecks > MAX_RECHECKS) break;
      planned.add(existing.number);
      const detail = await omegaGet(`/Invoices/${encodeURIComponent(existing.number)}`, { allowNotFound: true });
      const flag = detail ? notBillableReason(detail, config.settings) : 'Deleted in Omega';
      if (flag) plan.push(flagEntry(existing, flag));
    }
  }

  // Nothing is written into a month already sent to Freeport; those rows say
  // to start a correction first.
  const locked = await lockedMonths();
  const lockedMonth = entry => [entry.invoice?.billingMonth, entry.existing?.billingMonth].find(month => month && locked.has(month));
  const guarded = plan.map(entry => {
    const month = lockedMonth(entry);
    if (!month || !(entry.adopt || ['new', 'update', 'flag'].includes(entry.row.action))) return entry;
    if (entry.row.action === 'unchanged') return { row: entry.row };
    const sent = `${monthLabel(month)} was sent to Freeport. Start a correction on Month close to bring this in.`;
    return { row: { ...entry.row, action: 'locked', reason: entry.row.reason ? `${entry.row.reason}. ${sent}` : sent } };
  });

  guarded.sort((a, b) => (a.row.installDate || a.row.omegaDate).localeCompare(b.row.installDate || b.row.omegaDate) || a.row.number.localeCompare(b.row.number));
  return guarded;
}

export async function previewImport(range, config) {
  return { rows: (await buildImport(range, config)).map(entry => entry.row) };
}

// Omega is read again at import time rather than trusting what the browser
// sends back. Only invoices the person ticked in the preview are imported.
export async function applyImport({ from, to, numbers }, config, actor) {
  const chosen = new Set((Array.isArray(numbers) ? numbers : []).map(String));
  const result = { created: [], updated: [], flagged: [], unchanged: 0, skipped: [], locked: [] };
  for (const entry of await buildImport({ from, to }, config)) {
    const { row } = entry;
    if (row.action === 'unchanged') {
      if (entry.adopt) await saveOmegaSnapshot(entry.existing.number, entry.snapshot);
      result.unchanged++;
      continue;
    }
    if (row.action === 'skip') {
      result.skipped.push({ number: row.number, reason: row.reason });
      continue;
    }
    if (row.action === 'locked') {
      result.locked.push({ number: row.number, reason: row.reason });
      continue;
    }
    if (!chosen.has(row.number)) continue;
    try {
      if (row.action === 'new') {
        await createInvoice(entry.invoice, actor, { omegaSnapshot: entry.snapshot });
        result.created.push(row.number);
      } else if (row.action === 'update') {
        await updateInvoice(entry.existing.number, entry.existing.version, entry.invoice, actor, { omegaSnapshot: entry.snapshot });
        result.updated.push(row.number);
      } else {
        await flagOmegaInvoice(entry.existing.number, entry.existing.version, entry.snapshot, actor);
        result.flagged.push(row.number);
      }
    } catch (error) {
      if (!(error instanceof FreeportError)) throw error;
      result.skipped.push({ number: row.number, reason: error.message });
    }
  }
  return result;
}

// Month close checks against Omega (read-only):
// - Freeport jobs installed in the month that are still work orders. Work
//   orders are found by the day they were written up, so the search covers the
//   four months before the month through its last day, and says so.
// - This month's imported invoices that Omega has since voided or moved.
export async function monthCheck(month, config) {
  const [year, monthNumber] = month.split('-').map(Number);
  const checkedFrom = new Date(Date.UTC(year, monthNumber - 1 - WORK_ORDER_LOOKBACK_MONTHS, 1)).toISOString().slice(0, 10);
  const today = todayPhoenixString();
  // Work orders are sometimes written up a little after the install.
  const searchEnd = new Date(Date.UTC(year, monthNumber, 15)).toISOString().slice(0, 10);
  const checkedTo = today < searchEnd ? (today > checkedFrom ? today : checkedFrom) : searchEnd;
  const jobs = await listJobs(checkedFrom, checkedTo);
  const workOrders = jobs
    .filter(job => isFreeport(job, config.settings) && String(job.job_status) === WORK_ORDER && omegaDate(job.appointment_scheduled_date).startsWith(month))
    .map(job => ({ number: String(job.id), scheduledDate: omegaDate(job.appointment_scheduled_date) }))
    .sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate));

  const notBillable = [];
  for (const invoice of (await listInvoices(month)).filter(candidate => candidate.omegaSnapshot && !candidate.omegaFlag).slice(0, MAX_RECHECKS)) {
    const detail = await omegaGet(`/Invoices/${encodeURIComponent(invoice.number)}`, { allowNotFound: true });
    const reason = detail ? notBillableReason(detail, config.settings) : 'Deleted in Omega';
    if (reason) notBillable.push({ number: invoice.number, reason });
  }
  return { workOrders, checkedFrom, checkedTo, notBillable };
}
