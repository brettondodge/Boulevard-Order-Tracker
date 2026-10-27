import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { dbAll, dbGet, dbRun, runInTransaction } from '../db.js';
import { isoNow, PROGRESS_FIELDS } from '../utils.js';
import { createHcpClient, hcpApiConfigured } from './client.js';

// Keeps tracker orders in step with their Housecall Pro jobs. HCP is the
// source of truth for whether a job is scheduled and complete; the tracker
// adds what HCP doesn't know (materials received, shop location, notes).
// Webhooks give changes as they happen; the hourly sync catches anything
// missed, since HCP documents no retries.

export const HCP_ACTOR = 'Housecall Pro';
const PHOENIX = 'America/Phoenix';

export const hcpWebhookConfigured = () => Boolean(process.env.HCP_WEBHOOK_SECRET);
export const hcpConfigured = () => hcpApiConfigured() || hcpWebhookConfigured();
export const hcpJobUrl = id => `https://pro.housecallpro.com/app/jobs/${encodeURIComponent(id)}`;

// The API id inside an HCP job link (https://pro.housecallpro.com/app/jobs/job_...).
export function hcpJobIdFromLink(link) {
  return /\/jobs\/(job_[A-Za-z0-9]+)/.exec(String(link || ''))?.[1] || '';
}

const isoTime = value => {
  const date = new Date(String(value || ''));
  return value && !Number.isNaN(date.getTime()) ? date.toISOString() : '';
};

// Calendar day in Phoenix for an HCP timestamp. HCP documents schedule times
// as UTC; times without a zone are read as UTC.
export function phoenixDate(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const date = new Date(/([zZ]|[+-]\d{2}:?\d{2})$/.test(text) ? text : `${text}Z`);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: PHOENIX, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

// HCP spells statuses differently in different places ("needs scheduling",
// "unscheduled", "complete rated", "in_progress"...). Reduce to five.
export function workStatusOf(row) {
  if (!row) return '';
  if (row.deleted_at || row.canceled_at) return 'canceled';
  const status = String(row.work_status || '').toLowerCase().replace(/_/g, ' ').trim();
  if (status.includes('cancel')) return 'canceled';
  if (status.startsWith('complete') || row.completed_at) return 'completed';
  if (status === 'in progress') return 'in_progress';
  if (status === 'scheduled') return 'scheduled';
  if (status === 'needs scheduling' || status === 'unscheduled') return 'unscheduled';
  return row.scheduled_start ? 'scheduled' : 'unscheduled';
}

// Webhook check from the HCP docs: HMAC-SHA256 of "<Api-Timestamp>.<body>"
// keyed with the signing secret, compared with Api-Signature. The docs don't
// say hex or base64, so exactly those two spellings are accepted. Deliveries
// more than 30 minutes off are refused (the hourly sync covers anything
// late); repeats inside the window are caught by the event log, whose id
// comes from the timestamp and body (webhookEventId), not the header text.
export function verifyWebhookSignature({ secret, timestamp, signature, rawBody, now = Date.now(), toleranceSeconds = 1800 }) {
  if (!secret || !timestamp || !signature || !Buffer.isBuffer(rawBody)) return false;
  if (!/^\d{9,11}$/.test(String(timestamp)) || Math.abs(now / 1000 - Number(timestamp)) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.`).update(rawBody).digest();
  const given = String(signature).trim();
  const candidate = /^[0-9a-f]{64}$/i.test(given) ? Buffer.from(given, 'hex')
    : /^[A-Za-z0-9+/]{43}=$/.test(given) ? Buffer.from(given, 'base64')
      : null;
  return Boolean(candidate) && candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export function webhookEventId(timestamp, rawBody) {
  return createHash('sha256').update(`${timestamp}.`).update(rawBody).digest('hex');
}

// Only HCP job ids (job_...) count; the approved-job form's free-text
// "Stable HCP job ID" box may hold a job number or a pasted link.
export function hcpJobIdFrom(value) {
  const text = String(value || '').trim();
  return /^job_[A-Za-z0-9]+$/.test(text) ? text : hcpJobIdFromLink(text);
}

function customerName(customer = {}) {
  const person = [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim();
  const company = String(customer.company || '').trim();
  return person && company ? `${person} (${company})` : person || company;
}

const amount = value => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value)) ? null : Math.round(Number(value)));

// The hcp_jobs row for a job object from the API or a job webhook.
export function hcpJobRow(job, sourceTime, previous = null) {
  const schedule = job.schedule || {};
  const local = String(schedule.scheduled_start_local || '');
  return {
    id: String(job.id),
    invoice_number: String(job.invoice_number ?? previous?.invoice_number ?? '').trim(),
    work_status: String(job.work_status ?? previous?.work_status ?? ''),
    scheduled_start: schedule.scheduled_start || null,
    scheduled_end: schedule.scheduled_end || null,
    scheduled_local_date: (/^\d{4}-\d{2}-\d{2}/.test(local) ? local.slice(0, 10) : phoenixDate(schedule.scheduled_start)) || null,
    assigned_names: (job.assigned_employees || []).map(person => [person.first_name, person.last_name].filter(Boolean).join(' ').trim()).filter(Boolean).join(', ') || null,
    completed_at: job.work_timestamps?.completed_at || null,
    canceled_at: job.canceled_at || null,
    deleted_at: job.deleted_at || null,
    invoice_sent_at: previous?.invoice_sent_at || null,
    invoice_paid_at: previous?.invoice_paid_at || null,
    outstanding_balance: amount(job.outstanding_balance),
    total_amount: amount(job.total_amount),
    customer_name: customerName(job.customer) || previous?.customer_name || null,
    original_estimate_id: job.original_estimate_id || previous?.original_estimate_id || null,
    source_time: sourceTime,
    synced_at: isoNow()
  };
}

const HCP_JOB_COLUMNS = ['id', 'invoice_number', 'work_status', 'scheduled_start', 'scheduled_end', 'scheduled_local_date', 'assigned_names', 'completed_at', 'canceled_at', 'deleted_at', 'invoice_sent_at', 'invoice_paid_at', 'outstanding_balance', 'total_amount', 'customer_name', 'original_estimate_id', 'source_time', 'synced_at'];

const getHcpJob = id => dbGet('SELECT * FROM hcp_jobs WHERE id = ?', [id]);

// Saves the row in one statement, unless a newer version is already stored
// (webhooks can arrive out of order or at the same moment). Invoice times
// already known are kept. Returns the row now stored.
const KEEP_IF_BLANK = new Set(['invoice_sent_at', 'invoice_paid_at', 'customer_name', 'original_estimate_id']);
async function saveHcpJob(row) {
  await dbRun(
    `INSERT INTO hcp_jobs (${HCP_JOB_COLUMNS.join(', ')}) VALUES (${HCP_JOB_COLUMNS.map(() => '?').join(', ')})
     ON CONFLICT (id) DO UPDATE SET ${HCP_JOB_COLUMNS.filter(column => column !== 'id').map(column => (KEEP_IF_BLANK.has(column) ? `${column} = COALESCE(excluded.${column}, hcp_jobs.${column})` : `${column} = excluded.${column}`)).join(', ')}
     WHERE hcp_jobs.source_time <= excluded.source_time`,
    HCP_JOB_COLUMNS.map(column => row[column] ?? null)
  );
  return getHcpJob(row.id);
}

// Tracker progress implied by the HCP job. Scheduled and complete mirror HCP;
// invoiced only ever turns on (billing can also happen outside HCP).
// Canceled jobs leave orders alone; the screen shows a warning instead.
export function progressFromHcp(row, current) {
  const status = workStatusOf(row);
  if (status === 'canceled') return null;
  // Finished and billed in the tracker stays that way (old history matched
  // by job number, or a job paid but never closed in HCP).
  const settled = Number(current.job_completed) && Number(current.invoiced);
  const completed = status === 'completed' || Boolean(settled);
  const scheduled = completed || status === 'scheduled' || status === 'in_progress';
  const billed = Boolean(row.invoice_sent_at || row.invoice_paid_at);
  return {
    job_scheduled: scheduled ? 1 : 0,
    scheduled_date: scheduled ? (row.scheduled_local_date || current.scheduled_date || '') : '',
    schedule_note: current.schedule_note || '',
    job_completed: completed ? 1 : 0,
    completed_date: completed ? (phoenixDate(row.completed_at) || current.completed_date || phoenixDate(row.source_time)) : '',
    invoiced: Number(current.invoiced) || billed ? 1 : 0,
    invoice_reference: current.invoice_reference || (billed ? row.invoice_number : '') || ''
  };
}

// Applies an HCP job to its orders: those linked by id, by a pasted HCP link
// or by an approved job from HCP, and those with the same job number. Links
// them too.
export async function applyHcpJob(row) {
  const active = await dbAll('SELECT * FROM orders WHERE is_archived = 0');
  const draftIds = new Set((await dbAll('SELECT id FROM job_drafts WHERE hcp_job_id = ?', [row.id])).map(draft => draft.id));
  const number = String(row.invoice_number || '').trim().toLowerCase();
  const byNumber = /[1-9]/.test(number);
  const direct = active.filter(order => order.hcp_job_id === row.id || (!order.hcp_job_id && (
    hcpJobIdFromLink(order.housecall_job_link) === row.id
    || draftIds.has(order.job_draft_id)
    || (byNumber && String(order.housecall_job_number ?? '').trim().toLowerCase() === number))));
  if (!direct.length) return [];
  const now = isoNow();
  const statements = [];
  const changedIds = [];
  for (const order of direct) {
    const next = progressFromHcp(row, order);
    const changed = Boolean(next) && PROGRESS_FIELDS.some(field => String(next[field] ?? '') !== String(order[field] ?? ''));
    if (!changed && order.hcp_job_id === row.id) continue;
    const fields = changed ? PROGRESS_FIELDS : [];
    statements.push({
      sql: `UPDATE orders SET hcp_job_id = ?, ${fields.map(field => `${field} = ?, `).join('')}updated_at = ?, updated_by = ? WHERE id = ?`,
      params: [row.id, ...fields.map(field => next[field]), now, HCP_ACTOR, order.id]
    });
    changedIds.push(order.id);
  }
  if (statements.length) await runInTransaction(statements);
  return changedIds;
}

// Whether any active order or approved job belongs to this HCP job.
async function jobIsTracked(job) {
  if (await getHcpJob(job.id)) return true;
  const number = String(job.invoice_number ?? '').trim();
  const byNumber = /[1-9]/.test(number) ? number : '';
  return Boolean(
    await dbGet("SELECT id FROM orders WHERE is_archived = 0 AND (hcp_job_id = ? OR housecall_job_link LIKE ? OR (? <> '' AND lower(trim(housecall_job_number)) = lower(?)))", [job.id, `%/jobs/${job.id}%`, byNumber, byNumber])
    || await dbGet('SELECT id FROM job_drafts WHERE is_archived = 0 AND hcp_job_id = ?', [job.id])
  );
}

// A job made from an approved estimate becomes an approved job in the
// tracker (Approved – Need to Order), unless it is already there or already
// has orders. HCP_AUTO_APPROVED_JOBS=off turns this off.
export async function addApprovedJobFromHcp(job) {
  if (String(process.env.HCP_AUTO_APPROVED_JOBS || 'estimates').toLowerCase() === 'off') return null;
  if (!job.original_estimate_id && !(job.original_estimate_uuids || []).length) return null;
  const number = String(job.invoice_number || '').trim();
  if (await dbGet('SELECT id FROM job_drafts WHERE hcp_job_id = ?', [job.id])) return null;
  if (await dbGet("SELECT id FROM orders WHERE hcp_job_id = ? OR (? <> '' AND lower(trim(housecall_job_number)) = lower(?))", [job.id, number, number])) return null;
  const now = isoNow();
  const id = `draft-${randomUUID()}`;
  const notes = [String(job.description || '').trim(), 'Added from Housecall Pro when the estimate was approved.'].filter(Boolean).join('\n');
  await dbRun(
    `INSERT INTO job_drafts (id, customer_name, housecall_job_number, housecall_job_link, hcp_job_id, notes, deposit_status, status, created_at, updated_at, created_by, updated_by, is_preview_data)
     VALUES (?, ?, ?, ?, ?, ?, 'Awaiting deposit', 'Open', ?, ?, ?, ?, 0)`,
    [id, customerName(job.customer) || `Job ${number || job.id}`, number, hcpJobUrl(job.id), job.id, notes, now, now, HCP_ACTOR, HCP_ACTOR]
  );
  return id;
}

async function setState(name, value) {
  await dbRun('INSERT INTO hcp_state (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', [name, value, isoNow()]);
}

// Invoice sent / paid times for a job, from its invoices.
function invoiceTimes(invoices) {
  const sent = invoices.map(invoice => isoTime(invoice.sent_at)).filter(Boolean).sort()[0] || null;
  const paid = invoices.length && invoices.every(invoice => invoice.paid_at || String(invoice.status).toLowerCase() === 'paid' || ['voided', 'canceled'].includes(String(invoice.status).toLowerCase()))
    ? invoices.map(invoice => isoTime(invoice.paid_at)).filter(Boolean).sort().at(-1) || null
    : null;
  return { sent, paid };
}

async function refreshJobFromApi(client, id, { withInvoices = false } = {}) {
  const job = await client.getJob(id);
  const previous = await getHcpJob(id);
  if (!job) {
    // Gone from HCP: keep what we knew and mark it deleted.
    if (previous && !previous.deleted_at) await dbRun('UPDATE hcp_jobs SET deleted_at = ?, synced_at = ? WHERE id = ?', [isoNow(), isoNow(), id]);
    return previous ? { ...previous, deleted_at: previous.deleted_at || isoNow() } : null;
  }
  const row = hcpJobRow(job, isoNow(), previous);
  if (withInvoices) {
    const times = invoiceTimes(await client.getJobInvoices(id));
    row.invoice_sent_at = times.sent || row.invoice_sent_at;
    row.invoice_paid_at = times.paid || row.invoice_paid_at;
  }
  return saveHcpJob(row);
}

const JOB_EVENTS = new Set(['job.created', 'job.updated', 'job.scheduled', 'job.on_my_way', 'job.started', 'job.completed', 'job.paid', 'job.canceled', 'job.deleted']);

async function processEvent(event, payload, occurredAt) {
  if (JOB_EVENTS.has(event)) {
    const job = payload.job;
    if (!job?.id) return { outcome: 'ignored', detail: 'No job in the event.' };
    const draftId = event === 'job.created' ? await addApprovedJobFromHcp(job) : null;
    // HCP sends events for every job in the company; keep only the ones the
    // tracker has orders or an approved job for.
    if (!draftId && !(await jobIsTracked(job))) return { outcome: 'ignored', jobId: job.id, detail: 'Job is not in the tracker.' };
    const previous = await getHcpJob(job.id);
    const row = hcpJobRow(job, occurredAt, previous);
    if (event === 'job.deleted' && !row.deleted_at) row.deleted_at = occurredAt;
    if (event === 'job.paid' && row.outstanding_balance === 0) row.invoice_paid_at = row.invoice_paid_at || occurredAt;
    const saved = await saveHcpJob(row);
    const orderIds = await applyHcpJob(saved);
    return { outcome: 'applied', jobId: job.id, orderIds, draftId };
  }

  if (event.startsWith('job.appointment.')) {
    const jobId = payload.appointment?.job_id;
    if (!jobId) return { outcome: 'ignored', detail: 'No job in the event.' };
    if (!(await jobIsTracked({ id: jobId }))) return { outcome: 'ignored', jobId, detail: 'Job is not in the tracker.' };
    if (hcpApiConfigured()) {
      // Appointment events carry only the visit, so read the whole job.
      const saved = await refreshJobFromApi(createHcpClient(), jobId);
      return saved ? { outcome: 'applied', jobId, orderIds: await applyHcpJob(saved) } : { outcome: 'ignored', jobId, detail: 'Job not found in HCP.' };
    }
    const previous = await getHcpJob(jobId);
    const start = payload.appointment?.start_time;
    if (!previous || !start || event === 'job.appointment.appointment_discarded') return { outcome: 'ignored', jobId, detail: 'Needs HCP_API_KEY to read the job.' };
    const row = { ...previous, scheduled_start: start, scheduled_local_date: phoenixDate(start), work_status: workStatusOf(previous) === 'unscheduled' ? 'scheduled' : previous.work_status, source_time: occurredAt, synced_at: isoNow() };
    const saved = await saveHcpJob(row);
    return { outcome: 'applied', jobId, orderIds: await applyHcpJob(saved) };
  }

  if (event.startsWith('invoice.')) {
    const invoice = payload.invoice || {};
    const jobId = invoice.job_id;
    if (!jobId) return { outcome: 'ignored', detail: 'Invoice is not tied to a job.' };
    let row = await getHcpJob(jobId);
    if (!row && hcpApiConfigured() && (await jobIsTracked({ id: jobId }))) row = await refreshJobFromApi(createHcpClient(), jobId);
    if (!row) return { outcome: 'ignored', jobId, detail: 'Job is not in the tracker.' };
    const sent = isoTime(invoice.sent_at) || (event === 'invoice.sent' ? occurredAt : '');
    const paid = isoTime(invoice.paid_at) || (event === 'invoice.paid' ? occurredAt : '');
    await dbRun('UPDATE hcp_jobs SET invoice_sent_at = COALESCE(invoice_sent_at, ?), invoice_paid_at = COALESCE(invoice_paid_at, ?), synced_at = ? WHERE id = ?', [sent || null, paid || null, isoNow(), jobId]);
    return { outcome: 'applied', jobId, orderIds: await applyHcpJob(await getHcpJob(jobId)) };
  }

  return { outcome: 'ignored', detail: 'Event not used by the tracker.' };
}

// Records and applies one verified webhook delivery. A delivery already
// seen (same signature) is skipped.
export async function handleHcpWebhook(payload, { eventId }) {
  const event = String(payload?.event || '');
  const receivedAt = isoNow();
  const occurredAt = isoTime(payload?.event_occurred_at || payload?.event_created_at) || receivedAt;
  const jobId = payload?.job?.id || payload?.appointment?.job_id || payload?.invoice?.job_id || null;
  const recorded = await dbRun('INSERT INTO hcp_events (id, event, job_id, occurred_at, received_at, outcome) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING', [eventId, event || 'unknown', jobId, occurredAt, receivedAt, 'received']);
  if (!recorded.changes) return { outcome: 'duplicate' };
  await setState('last_event_at', receivedAt);
  try {
    const result = await processEvent(event, payload, occurredAt);
    await dbRun('UPDATE hcp_events SET outcome = ?, detail = ? WHERE id = ?', [result.outcome, result.detail || null, eventId]);
    return result;
  } catch (error) {
    await dbRun('UPDATE hcp_events SET outcome = ?, detail = ? WHERE id = ?', ['failed', String(error.message || 'Failed').slice(0, 200), eventId]);
    await setState('last_error', `${receivedAt} ${event}: ${String(error.message || 'Failed').slice(0, 200)}`);
    return { outcome: 'failed' };
  }
}

let runningSync = null;

// Catch-up with HCP: refreshes every unfinished job the tracker's orders
// belong to, and finds the HCP job for orders that only have a job number.
export function syncHcp(options = {}) {
  runningSync ||= runSync(options).finally(() => { runningSync = null; });
  return runningSync;
}

async function runSync({ client = createHcpClient(), maxPages = 30 } = {}) {
  const summary = { jobs_refreshed: 0, jobs_found_by_number: 0, numbers_not_found: 0, orders_updated: 0 };
  const changed = new Set();
  try {
    const orders = await dbAll('SELECT id, hcp_job_id, housecall_job_number, housecall_job_link, job_draft_id, job_completed, invoiced FROM orders WHERE is_archived = 0');
    const drafts = new Map((await dbAll("SELECT id, hcp_job_id FROM job_drafts WHERE hcp_job_id IS NOT NULL AND hcp_job_id <> ''")).map(row => [row.id, hcpJobIdFrom(row.hcp_job_id)]).filter(([, id]) => id));
    const cached = await dbAll('SELECT id, invoice_number FROM hcp_jobs');
    const cachedByNumber = new Map(cached.filter(row => row.invoice_number).map(row => [row.invoice_number.toLowerCase(), row.id]));

    // Which HCP job each order belongs to, as far as the tracker can tell.
    const jobIds = new Map();
    const wantedNumbers = new Set();
    for (const order of orders) {
      const number = String(order.housecall_job_number ?? '').trim().toLowerCase();
      const id = order.hcp_job_id || hcpJobIdFromLink(order.housecall_job_link) || drafts.get(order.job_draft_id) || cachedByNumber.get(number) || '';
      const settled = Boolean(Number(order.job_completed) && Number(order.invoiced));
      if (id) {
        const entry = jobIds.get(id) || { settled: true };
        entry.settled &&= settled;
        jobIds.set(id, entry);
      } else if (/[1-9]/.test(number) && !settled) {
        wantedNumbers.add(number);
      }
    }

    // Finished and billed jobs need no more checking. One job failing (for
    // example a mistyped link) doesn't stop the rest; a rejected key does.
    for (const [id, entry] of jobIds) {
      if (entry.settled) continue;
      try {
        const saved = await refreshJobFromApi(client, id, { withInvoices: true });
        summary.jobs_refreshed += 1;
        if (saved) (await applyHcpJob(saved)).forEach(orderId => changed.add(orderId));
      } catch (error) {
        if (error.status === 401 || error.status === 403) throw error;
        summary.jobs_failed = (summary.jobs_failed || 0) + 1;
      }
    }

    // HCP can't look a job up by number, so read recent jobs, newest first.
    for (let page = 1; wantedNumbers.size && page <= maxPages; page += 1) {
      const result = await client.listJobs({ page, pageSize: 100, sortBy: 'created_at', sortDirection: 'desc' });
      const jobs = result?.jobs || [];
      for (const job of jobs) {
        const number = String(job.invoice_number ?? '').trim().toLowerCase();
        if (!wantedNumbers.has(number)) continue;
        wantedNumbers.delete(number);
        const saved = await saveHcpJob(hcpJobRow(job, isoNow(), await getHcpJob(job.id)));
        summary.jobs_found_by_number += 1;
        (await applyHcpJob(saved)).forEach(orderId => changed.add(orderId));
      }
      if (!jobs.length || page >= Number(result?.total_pages || page)) break;
    }
    summary.numbers_not_found = wantedNumbers.size;
    summary.orders_updated = changed.size;
    await setState('last_sync_at', isoNow());
    await setState('last_sync_summary', JSON.stringify(summary));
    await setState('last_error', summary.jobs_failed ? `${isoNow()} sync: ${summary.jobs_failed} jobs could not be read from HCP.` : '');
    await dbRun('DELETE FROM hcp_events WHERE received_at < ?', [new Date(Date.now() - 90 * 86400000).toISOString()]);
    return { ...summary, order_ids: [...changed] };
  } catch (error) {
    await setState('last_error', `${isoNow()} sync: ${String(error.message || 'Failed').slice(0, 200)}`);
    throw error;
  }
}

// Fetches one job in the background after an order is linked to it, so its
// status shows without waiting for the hourly sync.
export function refreshHcpJobSoon(id, onChanged = () => {}) {
  if (!id || !hcpApiConfigured()) return;
  refreshJobFromApi(createHcpClient(), id, { withInvoices: true })
    .then(saved => (saved ? applyHcpJob(saved) : []))
    .then(orderIds => { if (orderIds.length) onChanged(orderIds); })
    .catch(() => {});
}

// The HCP job an order belongs to: from its link, its approved job, or a
// known job with the same number. `keep` is the current link, kept when the
// order's job number and link did not change.
export async function resolveOrderHcpJobId({ link, number, draftId, keep = '' }) {
  const fromLink = hcpJobIdFromLink(link);
  if (fromLink) return fromLink;
  if (draftId) {
    const draft = await dbGet('SELECT hcp_job_id FROM job_drafts WHERE id = ?', [draftId]);
    const fromDraft = hcpJobIdFrom(draft?.hcp_job_id);
    if (fromDraft) return fromDraft;
  }
  const trimmed = String(number || '').trim();
  if (trimmed) {
    const known = await dbGet('SELECT id FROM hcp_jobs WHERE lower(invoice_number) = lower(?)', [trimmed]);
    if (known) return known.id;
  }
  return keep || '';
}

// What the order screens show about the HCP job.
export function hcpSummary(row) {
  if (!row) return null;
  return {
    job_id: row.id,
    url: hcpJobUrl(row.id),
    status: workStatusOf(row),
    scheduled_date: row.scheduled_local_date || '',
    assigned: row.assigned_names || '',
    invoice_sent: Boolean(row.invoice_sent_at),
    paid: Boolean(row.invoice_paid_at),
    synced_at: row.synced_at
  };
}

export async function hcpStatus() {
  const state = Object.fromEntries((await dbAll('SELECT name, value FROM hcp_state')).map(row => [row.name, row.value]));
  let summary = null;
  try { summary = state.last_sync_summary ? JSON.parse(state.last_sync_summary) : null; } catch {}
  return {
    api: hcpApiConfigured(),
    webhooks: hcpWebhookConfigured(),
    linked_jobs: Number((await dbGet("SELECT COUNT(DISTINCT hcp_job_id) AS count FROM orders WHERE is_archived = 0 AND hcp_job_id IS NOT NULL AND hcp_job_id <> ''"))?.count || 0),
    last_event_at: state.last_event_at || '',
    last_sync_at: state.last_sync_at || '',
    last_sync_summary: summary,
    last_error: state.last_error || '',
    recent_events: (await dbAll('SELECT event, outcome, received_at FROM hcp_events ORDER BY received_at DESC LIMIT 10')).map(row => ({ event: row.event, outcome: row.outcome, received_at: row.received_at }))
  };
}
