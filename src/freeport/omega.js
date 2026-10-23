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
import { createInvoice, getInvoice, updateInvoice } from './store.js';

// Read-only client for the Omega EDI API (GET requests only). The key lives in
// the server environment (OMEGA_API_KEY), never in the database or the browser.
const DEFAULT_BASE = 'https://app.omegaedi.com/api/2.0';
const PAGE_SIZE = 100;
const MAX_PAGES = 30;
const MAX_RANGE_DAYS = 124;
const INVOICED = new Set(['IN', 'CL']); // invoices and archived invoices
const WORK_ORDER = 'WO';

export const omegaConnected = () => Boolean(process.env.OMEGA_API_KEY);

async function omegaGet(path) {
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
  if (response.status === 401 || response.status === 403) throw new FreeportError(502, 'Omega rejected the API key. Check OMEGA_API_KEY.');
  if (response.status === 429) throw new FreeportError(502, 'Omega is limiting requests right now. Wait a minute and try again.');
  if (!response.ok) throw new FreeportError(502, `Omega returned an error (${response.status}). Try again in a minute.`);
  try {
    return await response.json();
  } catch {
    throw new FreeportError(502, "Omega sent a response the app couldn't read.");
  }
}

// Omega's date1/date2 filter on the job's document date, not the install date.
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

function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000);
}

function checkRange(from, to) {
  if (!isValidDate(from) || !isValidDate(to)) throw new FreeportError(400, 'Choose a From and To date.');
  if (from > to) throw new FreeportError(400, 'The From date must be on or before the To date.');
  if (daysBetween(from, to) > MAX_RANGE_DAYS) throw new FreeportError(400, 'Pick a range of about four months or less.');
}

// Turns an Omega job into an app invoice. Lines match by SKU; older invoices use
// one SKU for every glass size, so Omega's description (the size) is tried next.
// Unmatched lines keep "part number + description" for the per-line items.
export function mapOmegaInvoice(job, detail, items) {
  const notes = [];
  const lines = [];
  const omegaLines = Array.isArray(detail.Items) ? detail.Items : [];
  for (const [index, item] of omegaLines.entries()) {
    const sku = String(item.sku || item.final_sku || '').trim();
    const description = String(item.description ?? '').trim();
    const quantity = parseQuantity(item.quantity);
    const rateCents = parseMoney(item.price);
    if (!quantity) {
      notes.push(`Skipped Omega line ${index + 1} (${sku || 'no SKU'}, quantity ${item.quantity})`);
      continue;
    }
    if (rateCents === null) return { problem: `Omega line ${index + 1} (${sku || 'no SKU'}) has a price the app can't read: ${item.price}` };

    const line = { sku, itemId: '', description: '', quantity: formatQuantity(quantity), rateCents };
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

  const customField = label => (detail.InvoiceCustomFields || []).find(field => labelKey(field.label) === label)?.currentValue;
  const orderNumber = String(customField('orderno') ?? '').trim();
  const accountCode = String(customField('accountcode') ?? '').trim();
  const installDate = omegaDate(job.appointment_scheduled_date) || omegaDate(detail.appointment_scheduled_date);
  if (!installDate) notes.push('No scheduled (install) date in Omega');
  if (!orderNumber) notes.push('No ORDER NO. in Omega');

  const omegaSubtotal = parseMoney(detail.invoice_amount ?? job.invoice_amount);
  const linesSubtotal = lines.reduce((sum, line) => sum + lineTotal(parseQuantity(line.quantity), line.rateCents), 0);
  if (omegaSubtotal !== null && omegaSubtotal !== linesSubtotal) {
    notes.push(`Omega subtotal ${formatMoney(omegaSubtotal)}, but the lines add up to ${formatMoney(linesSubtotal)}`);
  }

  return {
    invoice: {
      number: String(detail.id ?? job.id),
      omegaDate: omegaDate(detail.date) || omegaDate(job.date) || omegaDate(detail.document_date),
      installDate,
      orderNumber,
      accountCode: /^\d+$/.test(accountCode) ? accountCode : '',
      omegaTaxCents: parseMoney(detail.invoice_tax ?? job.invoice_tax),
      lines
    },
    notes
  };
}

// Only the data that comes from Omega is compared, so an account code or an
// item picked in the app doesn't make an unchanged invoice look updated.
function omegaChanges(existing, imported) {
  const changes = [];
  for (const [field, label] of [['omegaDate', 'invoice date'], ['installDate', 'install date'], ['orderNumber', 'order number'], ['omegaTaxCents', 'tax']]) {
    if ((existing[field] ?? '') !== (imported[field] ?? '')) changes.push(label);
  }
  const lineKey = line => `${skuKey(line.sku)}|${line.quantity}|${line.rateCents}`;
  if (existing.lines.map(lineKey).join('\n') !== imported.lines.map(lineKey).join('\n')) changes.push('line items');
  return changes;
}

function previewRow(action, invoice, config, extra = {}) {
  const summary = invoice ? summarizeInvoice(invoice, config) : null;
  return {
    action,
    number: invoice?.number ?? extra.number,
    installDate: invoice?.installDate ?? '',
    omegaDate: invoice?.omegaDate ?? '',
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

async function buildImport({ from, to }, config) {
  checkRange(from, to);
  const jobs = (await listJobs(from, to)).filter(job => isFreeport(job, config.settings) && INVOICED.has(String(job.job_status)));
  const plan = [];
  for (const job of jobs) {
    const detail = await omegaGet(`/Invoices/${encodeURIComponent(job.id)}`);
    const mapped = mapOmegaInvoice(job, detail, config.items);
    if (mapped.problem) {
      plan.push({ row: previewRow('skip', null, config, { number: String(job.id), reason: mapped.problem }) });
      continue;
    }
    const existing = await getInvoice(mapped.invoice.number);
    // App-only fields (account, Drive link, notes, month override) are kept on update.
    const body = existing
      ? { ...mapped.invoice, accountCode: existing.accountCode || mapped.invoice.accountCode, monthOverride: existing.monthOverride, driveLink: existing.driveLink, notes: existing.notes, status: 'Needs review' }
      : { ...mapped.invoice, status: 'Needs review' };
    let invoice;
    try {
      invoice = normalizeInvoiceInput(body, config);
    } catch (error) {
      if (!(error instanceof FreeportError)) throw error;
      plan.push({ row: previewRow('skip', null, config, { number: mapped.invoice.number, reason: error.message, notes: mapped.notes }) });
      continue;
    }
    if (!existing) {
      plan.push({ invoice, row: previewRow('new', invoice, config, { notes: mapped.notes }) });
      continue;
    }
    const changes = omegaChanges(existing, invoice);
    const notes = existing.status === 'Ready' ? [...mapped.notes, 'Was Ready; goes back to Needs review'] : mapped.notes;
    plan.push(changes.length
      ? { invoice, existing, row: previewRow('update', invoice, config, { notes, changes }) }
      : { row: previewRow('unchanged', existing, config, { notes: mapped.notes }) });
  }
  plan.sort((a, b) => (a.row.installDate || a.row.omegaDate).localeCompare(b.row.installDate || b.row.omegaDate) || a.row.number.localeCompare(b.row.number));
  return plan;
}

export async function previewImport(range, config) {
  return { rows: (await buildImport(range, config)).map(entry => entry.row) };
}

// Omega is read again at import time rather than trusting what the browser
// sends back. Only invoices the person saw in the preview are imported.
export async function applyImport({ from, to, numbers }, config, actor) {
  const chosen = new Set((Array.isArray(numbers) ? numbers : []).map(String));
  const result = { created: [], updated: [], unchanged: 0, skipped: [] };
  for (const entry of await buildImport({ from, to }, config)) {
    const { row } = entry;
    if (row.action === 'unchanged') {
      result.unchanged++;
      continue;
    }
    if (row.action === 'skip') {
      result.skipped.push({ number: row.number, reason: row.reason });
      continue;
    }
    if (!chosen.has(row.number)) continue;
    try {
      if (row.action === 'new') {
        await createInvoice(entry.invoice, actor);
        result.created.push(row.number);
      } else {
        await updateInvoice(entry.existing.number, entry.existing.version, entry.invoice, actor);
        result.updated.push(row.number);
      }
    } catch (error) {
      if (!(error instanceof FreeportError)) throw error;
      result.skipped.push({ number: row.number, reason: error.message });
    }
  }
  return result;
}

// Freeport jobs still open as work orders (scheduled, not invoiced) with an
// install date in the month, for the Month close checklist.
export async function openWorkOrders(month, config) {
  const [year, monthNumber] = month.split('-').map(Number);
  const from = new Date(Date.UTC(year, monthNumber - 2, 1)).toISOString().slice(0, 10);
  const today = todayPhoenixString();
  const to = today > from ? today : from;
  const jobs = await listJobs(from, daysBetween(from, to) > MAX_RANGE_DAYS ? new Date(Date.parse(`${from}T00:00:00Z`) + MAX_RANGE_DAYS * 86400000).toISOString().slice(0, 10) : to);
  return jobs
    .filter(job => isFreeport(job, config.settings) && String(job.job_status) === WORK_ORDER && omegaDate(job.appointment_scheduled_date).startsWith(month))
    .map(job => ({ number: String(job.id), scheduledDate: omegaDate(job.appointment_scheduled_date) }))
    .sort((a, b) => a.scheduledDate.localeCompare(b.scheduledDate));
}
