import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { dbAll, dbGet, dbRun, runInTransaction } from '../db.js';
import { isoNow, ORDER_CATEGORIES, PROGRESS_FIELDS } from '../utils.js';
import { HcpError, createHcpClient, hcpApiConfigured } from './client.js';

// Keeps tracker orders in step with their Housecall Pro jobs. Staff paste an
// HCP job link (or job number) on an order and the tracker fills in what HCP
// knows. HCP is then the source of truth for whether the job is scheduled and
// complete; the tracker keeps what HCP doesn't know (supplier, PO, ETA,
// received, shelf). Webhooks give changes as they happen; the hourly sync
// catches anything missed, since HCP documents no retries. The tracker writes
// back only job tags ("Materials ordered" / "Materials received"), notes, and
// the job's column on the Pipeline jobs board (forward only).

export const HCP_ACTOR = 'Housecall Pro';
const PHOENIX = 'America/Phoenix';

export const hcpWebhookConfigured = () => Boolean(process.env.HCP_WEBHOOK_SECRET);
export const hcpConfigured = () => hcpApiConfigured() || hcpWebhookConfigured();
export const hcpWritesEnabled = () => hcpApiConfigured() && String(process.env.HCP_WRITE_BACK || 'on').toLowerCase() !== 'off';
export const hcpJobUrl = id => `https://pro.housecallpro.com/app/jobs/${encodeURIComponent(id)}`;

// The API id inside an HCP job link (https://pro.housecallpro.com/app/jobs/job_...).
export function hcpJobIdFromLink(link) {
  return /\/jobs\/(job_[A-Za-z0-9]+)/.exec(String(link || ''))?.[1] || '';
}

// An HCP job id given directly (job_...) or inside a pasted link.
export function hcpJobIdFrom(value) {
  const text = String(value || '').trim();
  return /^job_[A-Za-z0-9]+$/.test(text) ? text : hcpJobIdFromLink(text);
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

function customerName(customer = {}) {
  const person = [customer.first_name, customer.last_name].filter(Boolean).join(' ').trim();
  const company = String(customer.company || '').trim();
  return person && company ? `${person} (${company})` : person || company;
}

const parseTags = text => {
  try {
    const tags = JSON.parse(text || '[]');
    return Array.isArray(tags) ? tags.map(String) : [];
  } catch {
    return [];
  }
};

// The hcp_jobs row for a job object from the API or a job webhook.
export function hcpJobRow(job, sourceTime, previous = null) {
  const schedule = job.schedule || {};
  const local = String(schedule.scheduled_start_local || '');
  return {
    id: String(job.id),
    invoice_number: String(job.invoice_number ?? previous?.invoice_number ?? '').trim(),
    work_status: String(job.work_status ?? previous?.work_status ?? ''),
    scheduled_start: schedule.scheduled_start || null,
    scheduled_local_date: (/^\d{4}-\d{2}-\d{2}/.test(local) ? local.slice(0, 10) : phoenixDate(schedule.scheduled_start)) || null,
    completed_at: job.work_timestamps?.completed_at || null,
    canceled_at: job.canceled_at || null,
    deleted_at: job.deleted_at || null,
    tags: Array.isArray(job.tags) ? JSON.stringify(job.tags.map(String)) : (previous?.tags ?? null),
    outstanding_balance: Number.isFinite(Number(job.outstanding_balance)) && job.outstanding_balance !== null ? Number(job.outstanding_balance) : (previous?.outstanding_balance ?? null),
    source_time: sourceTime,
    synced_at: isoNow()
  };
}

const HCP_JOB_COLUMNS = ['id', 'invoice_number', 'work_status', 'scheduled_start', 'scheduled_local_date', 'completed_at', 'canceled_at', 'deleted_at', 'tags', 'outstanding_balance', 'source_time', 'synced_at'];

const getHcpJob = id => dbGet('SELECT * FROM hcp_jobs WHERE id = ?', [id]);

// Saves the row in one statement, unless a newer version is already stored
// (webhooks can arrive out of order or at the same moment). Known tags are
// kept when an event leaves them out. Returns the row now stored.
async function saveHcpJob(row) {
  await dbRun(
    `INSERT INTO hcp_jobs (${HCP_JOB_COLUMNS.join(', ')}) VALUES (${HCP_JOB_COLUMNS.map(() => '?').join(', ')})
     ON CONFLICT (id) DO UPDATE SET ${HCP_JOB_COLUMNS.filter(column => column !== 'id').map(column => (column === 'tags' ? 'tags = COALESCE(excluded.tags, hcp_jobs.tags)' : `${column} = excluded.${column}`)).join(', ')}
     WHERE hcp_jobs.source_time <= excluded.source_time`,
    HCP_JOB_COLUMNS.map(column => row[column] ?? null)
  );
  return getHcpJob(row.id);
}

// Tracker progress implied by the HCP job: scheduled (with its date) and
// complete mirror HCP; "in progress" counts as scheduled. Canceled jobs leave
// orders alone.
export function progressFromHcp(row, current) {
  const status = workStatusOf(row);
  if (status === 'canceled') return null;
  const completed = status === 'completed';
  const scheduled = completed || status === 'scheduled' || status === 'in_progress';
  // Paid in full counts once the job is complete, so a customer who paid up
  // front keeps the order until the work is done. Invoiced: an invoice was
  // sent and is still unpaid (kept once paid, for the record).
  const balance = row.outstanding_balance;
  const paid = completed && balance !== null && balance !== undefined && Number(balance) <= 0;
  const invoiced = Boolean(row.invoice_sent_at) || (paid && Boolean(Number(current.invoiced)));
  return {
    job_scheduled: scheduled ? 1 : 0,
    scheduled_date: scheduled ? (row.scheduled_local_date || current.scheduled_date || '') : '',
    schedule_note: current.schedule_note || '',
    job_completed: completed ? 1 : 0,
    completed_date: completed ? (phoenixDate(row.completed_at) || current.completed_date || phoenixDate(row.source_time)) : '',
    invoiced: invoiced ? 1 : 0,
    invoiced_date: invoiced ? (phoenixDate(row.invoice_sent_at) || current.invoiced_date || phoenixDate(row.source_time)) : '',
    paid: paid ? 1 : 0,
    paid_date: paid ? (phoenixDate(row.invoice_paid_at) || current.paid_date || phoenixDate(row.source_time)) : ''
  };
}

// Applies an HCP job to its orders: those linked by id, by a pasted HCP link
// or by an approved job with that HCP link, and those with the same job
// number. Links them too.
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

async function getState(name) {
  return (await dbGet('SELECT value FROM hcp_state WHERE name = ?', [name]))?.value ?? null;
}

async function setState(name, value) {
  await dbRun('INSERT INTO hcp_state (name, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', [name, value, isoNow()]);
}

// What a job's invoices say: the latest one sent and still unpaid, and the
// latest one paid.
export function invoiceSummary(invoices = []) {
  const state = invoice => String(invoice?.status || '').toLowerCase();
  const latest = (list, key) => list.map(invoice => isoTime(invoice[key])).filter(Boolean).sort().at(-1) || null;
  return {
    invoice_sent_at: latest(invoices.filter(invoice => invoice?.sent_at && !['paid', 'voided', 'canceled', 'uncollectible'].includes(state(invoice))), 'sent_at'),
    invoice_paid_at: latest(invoices.filter(invoice => state(invoice) === 'paid'), 'paid_at')
  };
}

// Reads the job, and its invoices once it is complete (or when asked, for an
// invoice event). Returns the stored row.
async function refreshJobFromApi(client, id, { invoices = false } = {}) {
  const job = await client.getJob(id);
  const previous = await getHcpJob(id);
  if (!job) {
    // Gone from HCP: keep what we knew and mark it deleted.
    if (previous && !previous.deleted_at) await dbRun('UPDATE hcp_jobs SET deleted_at = ?, synced_at = ? WHERE id = ?', [isoNow(), isoNow(), id]);
    return previous ? { ...previous, deleted_at: previous.deleted_at || isoNow() } : null;
  }
  const saved = await saveHcpJob(hcpJobRow(job, isoNow(), previous));
  if (!invoices && workStatusOf(saved) !== 'completed') return saved;
  const list = await client.listJobInvoices(id);
  if (!list) return saved;
  const summary = invoiceSummary(list.invoices || []);
  await dbRun('UPDATE hcp_jobs SET invoice_sent_at = ?, invoice_paid_at = ? WHERE id = ?', [summary.invoice_sent_at, summary.invoice_paid_at, id]);
  return getHcpJob(id);
}

const JOB_EVENTS = new Set(['job.created', 'job.updated', 'job.scheduled', 'job.on_my_way', 'job.started', 'job.completed', 'job.paid', 'job.canceled', 'job.deleted']);

async function processEvent(event, payload, occurredAt) {
  if (JOB_EVENTS.has(event)) {
    const job = payload.job;
    if (!job?.id) return { outcome: 'ignored', detail: 'No job in the event.' };
    // HCP sends events for every job in the company; keep only the ones the
    // tracker has orders or an approved job for.
    if (!(await jobIsTracked(job))) return { outcome: 'ignored', jobId: job.id, detail: 'Job is not in the tracker.' };
    const row = hcpJobRow(job, occurredAt, await getHcpJob(job.id));
    if (event === 'job.deleted' && !row.deleted_at) row.deleted_at = occurredAt;
    const saved = await saveHcpJob(row);
    // The event looked older than what is stored (an earlier read from the API,
    // or HCP's clock a little behind ours): read the job itself so no change
    // is missed.
    const current = saved.source_time !== row.source_time && hcpApiConfigured()
      ? (await refreshJobFromApi(createHcpClient(), job.id)) || saved
      : saved;
    return { outcome: 'applied', jobId: job.id, orderIds: await applyHcpJob(current) };
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
    const jobId = payload.invoice?.job_id;
    if (!jobId) return { outcome: 'ignored', detail: 'No job in the event.' };
    if (!(await jobIsTracked({ id: jobId }))) return { outcome: 'ignored', jobId, detail: 'Job is not in the tracker.' };
    if (!hcpApiConfigured()) return { outcome: 'ignored', jobId, detail: 'Needs HCP_API_KEY to read the job.' };
    // An invoice event carries one invoice: read the job and all of its invoices.
    const saved = await refreshJobFromApi(createHcpClient(), jobId, { invoices: true });
    return saved ? { outcome: 'applied', jobId, orderIds: await applyHcpJob(saved) } : { outcome: 'ignored', jobId, detail: 'Job not found in HCP.' };
  }

  return { outcome: 'ignored', detail: 'Event not used by the tracker.' };
}

// Records and applies one verified webhook delivery. A delivery already seen
// (same timestamp and body) is skipped.
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

// --- Filling an order from an HCP link or job number ---

// First guess at the tracker category from an HCP job type name, used until
// an admin picks one in Master Lists › Housecall Pro. Auto glass gets no guess.
const CATEGORY_WORDS = [
  [/auto|windshield|vehicle/i, ''],
  [/shower|bath|tub|mirror|enclosure/i, 'Showers'],
  [/store ?front|commercial|entrance|curtain wall/i, 'Storefront'],
  [/window|patio door|slider|sliding door|french door|igu|dual pane|retrofit/i, 'Windows'],
  [/glass|table ?top|tempered|cut/i, 'Flat Glass']
];
export function guessCategory(name) {
  return CATEGORY_WORDS.find(([pattern]) => pattern.test(String(name || '')))?.[1] || '';
}

async function chosenCategories() {
  try {
    return JSON.parse((await getState('job_type_categories')) || '{}');
  } catch {
    return {};
  }
}

export async function categoryForJobType(jobType) {
  if (!jobType?.id && !jobType?.name) return '';
  const chosen = (await chosenCategories())[jobType.id];
  if (chosen !== undefined) return ORDER_CATEGORIES.includes(chosen) ? chosen : '';
  return guessCategory(jobType.name);
}

// HCP job types with the category each one fills in.
export async function hcpJobTypes(client = createHcpClient()) {
  const chosen = await chosenCategories();
  return (await client.listJobTypes()).map(type => ({
    id: type.id,
    name: type.name,
    category: Object.hasOwn(chosen, type.id) ? chosen[type.id] : guessCategory(type.name),
    chosen: Object.hasOwn(chosen, type.id)
  }));
}

export async function saveJobTypeCategories(categories) {
  const clean = Object.fromEntries(Object.entries(categories || {}).filter(([id, category]) => id && (category === '' || ORDER_CATEGORIES.includes(category))));
  await setState('job_type_categories', JSON.stringify(clean));
  return clean;
}

// What the tracker can fill in from an HCP job, found by its link (or id)
// or its job number. HCP can't search by number, so recent jobs are read,
// newest first. Returns null when the job isn't found.
export async function lookupHcpJob(query, { client = createHcpClient(), maxPages = 10 } = {}) {
  const text = String(query || '').trim();
  let id = hcpJobIdFrom(text);
  if (!id && /[1-9]/.test(text) && text.length <= 40) {
    id = (await dbGet('SELECT id FROM hcp_jobs WHERE lower(invoice_number) = lower(?)', [text]))?.id || '';
    for (let page = 1; !id && page <= maxPages; page += 1) {
      const result = await client.listJobs({ page, pageSize: 100, sortBy: 'created_at', sortDirection: 'desc' });
      const jobs = result?.jobs || [];
      id = jobs.find(job => String(job.invoice_number ?? '').trim().toLowerCase() === text.toLowerCase())?.id || '';
      if (!jobs.length || page >= Number(result?.total_pages || page)) break;
    }
  }
  if (!id) return null;
  const job = await client.getJob(id, { expand: ['attachments'] });
  if (!job) return null;
  const notes = [String(job.description || '').trim(), ...(job.notes || []).map(note => String(note?.content || '').trim())].filter(Boolean);
  return {
    job_id: job.id,
    url: hcpJobUrl(job.id),
    invoice_number: String(job.invoice_number ?? '').trim(),
    customer_name: customerName(job.customer),
    job_type: job.job_fields?.job_type?.name || '',
    category: await categoryForJobType(job.job_fields?.job_type),
    notes: [...new Set(notes)].join('\n'),
    attachments: (job.attachments || []).length
  };
}

// --- Writing back to HCP: tags and notes ---

export const HCP_TAGS = { ordered: 'Materials ordered', received: 'Materials received' };

// Tag ids by name, created in HCP the first time they are needed.
async function tagIds(client) {
  let ids = {};
  try { ids = JSON.parse((await getState('tag_ids')) || '{}'); } catch {}
  const missing = Object.values(HCP_TAGS).filter(name => !ids[name]);
  if (missing.length) {
    const existing = await client.listTags();
    for (const name of missing) {
      const found = existing.find(tag => String(tag.name).trim().toLowerCase() === name.toLowerCase());
      ids[name] = found?.id || (await client.createTag(name))?.id;
    }
    await setState('tag_ids', JSON.stringify(ids));
  }
  return ids;
}

// Puts "Materials ordered" (something still coming) or "Materials received"
// (everything here) on the HCP job, to match the tracker's orders for it.
// Jobs already complete or canceled in HCP are left as they are.
async function updateJobTags(client, row) {
  if (['completed', 'canceled'].includes(workStatusOf(row))) return false;
  const orders = await dbAll('SELECT date_received FROM orders WHERE is_archived = 0 AND hcp_job_id = ?', [row.id]);
  const wanted = !orders.length ? [] : orders.every(order => order.date_received) ? [HCP_TAGS.received] : [HCP_TAGS.ordered];
  const current = parseTags(row.tags);
  const has = name => current.some(tag => tag.trim().toLowerCase() === name.toLowerCase());
  const changes = Object.values(HCP_TAGS).filter(name => wanted.includes(name) !== has(name));
  if (!changes.length) return false;
  const ids = await tagIds(client);
  for (const name of changes) {
    if (!ids[name]) throw new Error(`Could not find or create the "${name}" tag in HCP.`);
    if (wanted.includes(name)) await client.addJobTag(row.id, ids[name]);
    else await client.removeJobTag(row.id, ids[name]);
  }
  const next = [...current.filter(tag => !changes.some(name => !wanted.includes(name) && name.toLowerCase() === tag.trim().toLowerCase())), ...changes.filter(name => wanted.includes(name))];
  await dbRun('UPDATE hcp_jobs SET tags = ? WHERE id = ?', [JSON.stringify(next), row.id]);
  return true;
}

const shortDate = value => (value ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${value}T00:00:00Z`)) : '');

async function writeForOrder(orderId, event) {
  const order = await dbGet('SELECT * FROM orders WHERE id = ?', [orderId]);
  const jobId = order?.hcp_job_id;
  if (!jobId) return;
  const client = createHcpClient();
  const job = await client.getJob(jobId);
  if (!job) return;
  const row = await saveHcpJob(hcpJobRow(job, isoNow(), await getHcpJob(jobId)));
  const active = Number(order.is_archived || 0) === 0;
  const po = order.po_number ? `PO ${order.po_number}` : '';
  if (event === 'ordered' && active) {
    await client.addJobNote(jobId, `Order Tracker: materials ordered from ${order.supplier}${po ? `, ${po}` : ''}${order.expected_delivery_date ? `, expected ${shortDate(order.expected_delivery_date)}` : ''}.`);
  }
  // Only if it is still received now (an Undo inside the delay cancels it).
  if (event === 'received' && active && order.date_received) {
    await client.addJobNote(jobId, `Order Tracker: ${order.supplier} materials received${po ? ` (${po})` : ''}${order.shop_location ? `, shelf ${order.shop_location}` : ''}.`);
  }
  await updateJobTags(client, row);
  await movePipeline(client, row);
  await setState('last_write_at', isoNow());
  await setState('last_write_error', '');
}

// Writes wait until the Undo window has passed, then look at the records as
// they are by then, so an undone change writes nothing. The same change made
// twice inside the delay (received, undone, received) writes once.
const pendingWrites = new Map();
function afterUndoWindow(key, write) {
  clearTimeout(pendingWrites.get(key));
  const delay = Number(process.env.HCP_WRITE_DELAY_MS ?? 20000);
  const timer = setTimeout(() => {
    pendingWrites.delete(key);
    write().catch(async (error) => {
      await setState('last_write_error', `${isoNow()} ${String(error.message || 'Failed').slice(0, 200)}`).catch(() => {});
    });
  }, delay);
  timer.unref?.();
  pendingWrites.set(key, timer);
}

// Called after an order is created, received, reopened, deleted or relinked
// (tags are re-matched and the job moves on the Pipeline board).
export function hcpOrderChanged(orderId, event = 'changed') {
  if (!hcpWritesEnabled() || !orderId) return;
  afterUndoWindow(`${orderId}:${event}`, () => writeForOrder(orderId, event));
}

// Called after an approved job is added, edited (its deposit or HCP link),
// marked all ordered, reopened, deleted or restored: its HCP job moves on the
// Pipeline board.
export function hcpApprovedJobChanged(draftId) {
  if (!hcpWritesEnabled() || !draftId) return;
  afterUndoWindow(`draft:${draftId}`, async () => {
    const draft = await dbGet('SELECT hcp_job_id FROM job_drafts WHERE id = ?', [draftId]);
    const jobId = hcpJobIdFrom(draft?.hcp_job_id);
    if (!jobId) return;
    const client = createHcpClient();
    const job = await client.getJob(jobId);
    if (!job) return;
    if (await movePipeline(client, await saveHcpJob(hcpJobRow(job, isoNow(), await getHcpJob(jobId))))) await setState('last_write_at', isoNow());
    await setState('last_write_error', '');
  });
}

// --- Moving jobs across the Pipeline jobs board ---

// The tracker's steps, in board order. An admin picks the Pipeline column for
// each in Master Lists; nothing moves until that choice is saved.
export const PIPELINE_STEPS = [
  { key: 'deposit_needed', label: 'Approved job waiting on its deposit', guess: /deposit/i },
  { key: 'need_to_order', label: 'Deposit received or waived, materials not ordered', guess: /need.*order/i },
  { key: 'waiting', label: 'Materials ordered, not all here', guess: /waiting/i },
  { key: 'received', label: 'All materials here', guess: /received/i }
];
const stepIndex = key => PIPELINE_STEPS.findIndex(step => step.key === key);

async function savedPipelineSteps() {
  try {
    const steps = JSON.parse((await getState('pipeline_steps')) || 'null');
    return steps && typeof steps === 'object' ? steps : null;
  } catch {
    return null;
  }
}

// The jobs board's columns from HCP, and the column chosen (or, until saved,
// suggested by name) for each tracker step.
export async function hcpPipeline(client = createHcpClient()) {
  const statuses = (await client.listPipelineStatuses('job')).map(status => ({ id: status.id, name: status.name }));
  const saved = await savedPipelineSteps();
  return {
    statuses,
    saved: Boolean(saved),
    steps: PIPELINE_STEPS.map(step => ({
      key: step.key,
      label: step.label,
      status_id: saved ? saved[step.key] || '' : statuses.find(status => step.guess.test(status.name))?.id || ''
    }))
  };
}

// Keeps only columns that exist on the board; '' means "don't move".
export async function savePipelineSteps(steps, client = createHcpClient()) {
  const known = new Set((await client.listPipelineStatuses('job')).map(status => status.id));
  const clean = Object.fromEntries(PIPELINE_STEPS.map(step => [step.key, known.has(steps?.[step.key]) ? steps[step.key] : '']));
  await setState('pipeline_steps', JSON.stringify(clean));
  return clean;
}

// Where the tracker's records put an HCP job on the board. Orders decide once
// there are any: all here (with no approved job still waiting on another
// supplier) is "received". Before that, the open approved job's deposit.
export async function pipelineStepFor(jobId) {
  const orders = await dbAll('SELECT date_received FROM orders WHERE is_archived = 0 AND hcp_job_id = ?', [jobId]);
  const openJobs = await dbAll("SELECT deposit_status FROM job_drafts WHERE is_archived = 0 AND status <> 'Completed' AND hcp_job_id = ?", [jobId]);
  if (orders.length) return orders.every(order => order.date_received) && !openJobs.length ? 'received' : 'waiting';
  if (!openJobs.length) return '';
  return openJobs.some(job => job.deposit_status === 'Awaiting deposit') ? 'deposit_needed' : 'need_to_order';
}

// Moves the job forward to its step's column, once per step. Left alone: jobs
// HCP has scheduled or finished (they are past these columns), and jobs the
// tracker already moved to this step or a later one. A move HCP refuses (the
// job is further along, for example On Hold) is noted and not tried again.
async function movePipeline(client, row) {
  const steps = await savedPipelineSteps();
  if (!steps || !row || ['scheduled', 'in_progress', 'completed', 'canceled'].includes(workStatusOf(row))) return false;
  const step = await pipelineStepFor(row.id);
  if (!step || !steps[step] || stepIndex(step) <= stepIndex(row.pipeline_step)) return false;
  try {
    const moved = await client.updatePipelineStatus({ resourceType: 'job', resourceId: row.id, statusId: steps[step] });
    if (!moved) throw new Error("Housecall Pro couldn't find the job or the Pipeline column. Check the columns in Master Lists.");
  } catch (error) {
    if (!(error instanceof HcpError) || [401, 403, 429].includes(error.status) || error.status >= 500) throw error;
    await setState('last_pipeline_refusal', `${isoNow()} job ${row.invoice_number || row.id}: ${error.message}`);
  }
  await dbRun('UPDATE hcp_jobs SET pipeline_step = ? WHERE id = ?', [step, row.id]);
  return true;
}

// Master Lists › Housecall Pro › Try one job: moves a job to a column right
// away and says what HCP answered.
export async function testPipelineMove({ job, statusId }, client = createHcpClient()) {
  const status = (await client.listPipelineStatuses('job')).find(entry => entry.id === statusId);
  if (!status) return { moved: false, message: 'Choose a Pipeline column.' };
  const found = await lookupHcpJob(job, { client });
  if (!found) return { moved: false, message: "Couldn't find that job in Housecall Pro." };
  const label = `job ${found.invoice_number || found.job_id}${found.customer_name ? ` (${found.customer_name})` : ''}`;
  try {
    const moved = await client.updatePipelineStatus({ resourceType: 'job', resourceId: found.job_id, statusId });
    return moved
      ? { moved: true, message: `Moved ${label} to ${moved.name || status.name}. Check the Pipeline board.` }
      : { moved: false, message: `Housecall Pro couldn't find ${label} or that column.` };
  } catch (error) {
    if (error instanceof HcpError) return { moved: false, message: `${label}: ${error.message}` };
    throw error;
  }
}

let runningSync = null;

// Catch-up with HCP: refreshes every unfinished job the tracker's orders
// point at (and re-matches its tags), and finds the HCP job for orders that
// only have a job number.
export function syncHcp(options = {}) {
  runningSync ||= runSync(options).finally(() => { runningSync = null; });
  return runningSync;
}

async function runSync({ client = createHcpClient(), maxPages = 30 } = {}) {
  const summary = { jobs_refreshed: 0, jobs_found_by_number: 0, numbers_not_found: 0, orders_updated: 0, tags_updated: 0, pipeline_moves: 0 };
  const changed = new Set();
  // Tags and the Pipeline column follow the tracker; one that can't be
  // written doesn't stop the sync.
  const writeBack = async (row) => {
    if (!hcpWritesEnabled()) return;
    for (const [count, write] of [['tags_updated', () => updateJobTags(client, row)], ['pipeline_moves', () => movePipeline(client, row)]]) {
      try {
        if (await write()) summary[count] += 1;
      } catch (error) {
        await setState('last_write_error', `${isoNow()} ${String(error.message || 'Failed').slice(0, 200)}`);
      }
    }
  };
  try {
    const orders = await dbAll('SELECT id, hcp_job_id, housecall_job_number, housecall_job_link, job_draft_id, job_completed, paid FROM orders WHERE is_archived = 0');
    const drafts = new Map((await dbAll("SELECT id, hcp_job_id FROM job_drafts WHERE hcp_job_id IS NOT NULL AND hcp_job_id <> ''")).map(row => [row.id, hcpJobIdFrom(row.hcp_job_id)]).filter(([, id]) => id));
    const cached = await dbAll('SELECT id, invoice_number FROM hcp_jobs');
    const cachedByNumber = new Map(cached.filter(row => row.invoice_number).map(row => [row.invoice_number.toLowerCase(), row.id]));

    // Which HCP job each order points at, as far as the tracker can tell.
    const jobIds = new Map();
    const wantedNumbers = new Set();
    for (const order of orders) {
      const number = String(order.housecall_job_number ?? '').trim().toLowerCase();
      const id = order.hcp_job_id || hcpJobIdFromLink(order.housecall_job_link) || drafts.get(order.job_draft_id) || cachedByNumber.get(number) || '';
      // Finished means complete and paid; until then invoices still matter.
      const done = Boolean(Number(order.job_completed) && Number(order.paid));
      if (id) {
        jobIds.set(id, (jobIds.get(id) ?? true) && done);
      } else if (/[1-9]/.test(number) && !done) {
        wantedNumbers.add(number);
      }
    }
    // Open approved jobs with no orders yet still need their Pipeline column.
    for (const draft of await dbAll("SELECT hcp_job_id FROM job_drafts WHERE is_archived = 0 AND status <> 'Completed' AND hcp_job_id IS NOT NULL AND hcp_job_id <> ''")) {
      const id = hcpJobIdFrom(draft.hcp_job_id);
      if (id && !jobIds.has(id)) jobIds.set(id, false);
    }

    // Finished jobs need no more checking. One job failing (for example a
    // mistyped link) doesn't stop the rest; a rejected key does.
    for (const [id, done] of jobIds) {
      if (done) continue;
      try {
        const saved = await refreshJobFromApi(client, id);
        summary.jobs_refreshed += 1;
        if (!saved) continue;
        (await applyHcpJob(saved)).forEach(orderId => changed.add(orderId));
        await writeBack(saved);
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
        await writeBack(saved);
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
  refreshJobFromApi(createHcpClient(), id)
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

// What the order screens show about the HCP job. Canceled jobs show nothing
// and the order carries on with the tracker's own steps.
export function hcpSummary(row) {
  if (!row) return null;
  const status = workStatusOf(row);
  if (status === 'canceled') return null;
  return {
    job_id: row.id,
    url: hcpJobUrl(row.id),
    status: status === 'in_progress' ? 'scheduled' : status,
    scheduled_date: row.scheduled_local_date || '',
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
    writes: hcpWritesEnabled(),
    linked_jobs: Number((await dbGet("SELECT COUNT(DISTINCT hcp_job_id) AS count FROM orders WHERE is_archived = 0 AND hcp_job_id IS NOT NULL AND hcp_job_id <> ''"))?.count || 0),
    last_event_at: state.last_event_at || '',
    last_sync_at: state.last_sync_at || '',
    last_sync_summary: summary,
    last_error: state.last_error || '',
    last_write_at: state.last_write_at || '',
    last_write_error: state.last_write_error || '',
    pipeline: Boolean(await savedPipelineSteps()),
    last_pipeline_refusal: state.last_pipeline_refusal || '',
    recent_events: (await dbAll('SELECT event, outcome, received_at FROM hcp_events ORDER BY received_at DESC LIMIT 10')).map(row => ({ event: row.event, outcome: row.outcome, received_at: row.received_at }))
  };
}
