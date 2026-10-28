import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHcpClient } from '../src/hcp/client.js';
import { startFakeHcp, syntheticHcpJob } from './hcp-fake.js';

// sync.js loads the database module, which opens SQLite on import: point it
// at a throwaway folder so tests never touch data/.
process.env.SQLITE_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'boulevard-hcp-unit-'));
process.env.PREVIEW_MODE = 'false';
// Never reach the real Housecall Pro API, even with a key in the local .env.
process.env.HCP_API_KEY = '';
process.env.HCP_WEBHOOK_SECRET = '';
const { applyHcpJob, guessCategory, handleHcpWebhook, hcpApprovedJobChanged, invoiceSummary, hcpJobIdFrom, hcpJobIdFromLink, hcpJobRow, hcpJobTypes, hcpOrderChanged, hcpPipeline, hcpSummary, lookupHcpJob, phoenixDate, progressFromHcp, saveJobTypeCategories, savePipelineSteps, syncHcp, testPipelineMove, verifyWebhookSignature, webhookEventId, workStatusOf } = await import('../src/hcp/sync.js');
const { dbRun, dbGet } = await import('../src/db.js');
await (await import('../src/db.js')).initializeDatabase();

test('webhook signatures follow the HCP docs: HMAC-SHA256 of "timestamp.body" with the signing secret', () => {
  const secret = 'synthetic-signing-secret';
  const rawBody = Buffer.from('{"event":"job.scheduled"}');
  const now = 1_790_000_000_000;
  const timestamp = String(now / 1000);
  const digest = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
  const check = (overrides) => verifyWebhookSignature({ secret, timestamp, signature: digest.toString('hex'), rawBody, now, ...overrides });
  assert.equal(check({}), true);
  assert.equal(check({ signature: digest.toString('hex').toUpperCase() }), true);
  assert.equal(check({ signature: digest.toString('base64') }), true);
  // Only plain hex or standard base64; other spellings of the same bytes are refused.
  assert.equal(check({ signature: `sha256=${digest.toString('hex')}` }), false);
  assert.equal(check({ signature: digest.toString('base64url') }), false);
  assert.equal(check({ signature: `${digest.toString('base64').slice(0, 10)}!!${digest.toString('base64').slice(10)}` }), false);
  assert.equal(check({ secret: 'wrong' }), false);
  assert.equal(check({ rawBody: Buffer.from('{"event":"job.completed"}') }), false);
  assert.equal(check({ timestamp: String(now / 1000 + 1) }), false);
  assert.equal(check({ now: now + 29 * 60 * 1000 }), true);
  assert.equal(check({ now: now + 31 * 60 * 1000 }), false, 'deliveries more than 30 minutes off are refused');
  assert.equal(check({ timestamp: 'soon' }), false);
  // The event log id comes from the timestamp and body, so a delivery counts once however it is signed.
  assert.equal(webhookEventId(timestamp, rawBody), webhookEventId(timestamp, Buffer.from(rawBody)));
  assert.notEqual(webhookEventId(timestamp, rawBody), webhookEventId(String(Number(timestamp) + 1), rawBody));
  assert.equal(check({ signature: '' }), false);
  assert.equal(check({ signature: 'not-a-signature' }), false);
  assert.equal(check({ secret: '' }), false);
});

test('job ids come from HCP job links; dates are Phoenix calendar days', () => {
  assert.equal(hcpJobIdFromLink('https://pro.housecallpro.com/app/jobs/job_4f2a9c1b8e7d6c5b4a39281706f5e4d3?tab=notes'), 'job_4f2a9c1b8e7d6c5b4a39281706f5e4d3');
  assert.equal(hcpJobIdFromLink('https://example.com/jobs/hc-1'), '');
  assert.equal(hcpJobIdFromLink(''), '');
  // The approved-job form's free-text box: only real HCP ids count.
  assert.equal(hcpJobIdFrom('job_4f2a9c1b8e7d6c5b4a39281706f5e4d3'), 'job_4f2a9c1b8e7d6c5b4a39281706f5e4d3');
  assert.equal(hcpJobIdFrom('10239422'), '');
  assert.equal(hcpJobIdFrom('https://pro.housecallpro.com/app/jobs/job_abc123'), 'job_abc123');
  // 9:30pm Nov 3 in Phoenix is already Nov 4 in UTC.
  assert.equal(phoenixDate('2026-11-04T04:30:00Z'), '2026-11-03');
  assert.equal(phoenixDate('2026-11-04T04:30:00'), '2026-11-03');
  assert.equal(phoenixDate('2026-11-03T08:00:00-07:00'), '2026-11-03');
  assert.equal(phoenixDate('2026-11-03'), '2026-11-03');
  assert.equal(phoenixDate('soon'), '');
  assert.equal(phoenixDate(null), '');
});

test('the different HCP status spellings reduce to five', () => {
  const status = (work_status, extra = {}) => workStatusOf({ work_status, ...extra });
  assert.equal(status('needs scheduling'), 'unscheduled');
  assert.equal(status('unscheduled'), 'unscheduled');
  assert.equal(status('scheduled'), 'scheduled');
  assert.equal(status('in progress'), 'in_progress');
  assert.equal(status('in_progress'), 'in_progress');
  assert.equal(status('complete rated'), 'completed');
  assert.equal(status('complete unrated'), 'completed');
  assert.equal(status('completed'), 'completed');
  assert.equal(status('user canceled'), 'canceled');
  assert.equal(status('pro canceled'), 'canceled');
  assert.equal(status('scheduled', { deleted_at: '2026-10-20T00:00:00Z' }), 'canceled');
  assert.equal(status('', { scheduled_start: '2026-11-03T15:00:00Z' }), 'scheduled');
  assert.equal(status(''), 'unscheduled');
});

test('an HCP job maps onto tracker progress: scheduled and complete mirror HCP', () => {
  const scheduled = hcpJobRow(syntheticHcpJob({
    work_status: 'scheduled',
    schedule: { scheduled_start: '2026-11-04T04:30:00Z', scheduled_end: '2026-11-04T06:00:00Z', scheduled_start_local: null },
    tags: ['VIP']
  }), '2026-10-21T00:00:00.000Z');
  assert.equal(scheduled.scheduled_local_date, '2026-11-03');
  assert.equal(scheduled.tags, '["VIP"]');
  assert.equal(scheduled.assigned_names, undefined, 'tech names are not kept');
  const current = { job_scheduled: 0, scheduled_date: '', schedule_note: 'Two-man job', job_completed: 0, completed_date: '' };
  assert.deepEqual(progressFromHcp(scheduled, current), { job_scheduled: 1, scheduled_date: '2026-11-03', schedule_note: 'Two-man job', job_completed: 0, completed_date: '', invoiced: 0, invoiced_date: '', paid: 0, paid_date: '' });

  const local = hcpJobRow(syntheticHcpJob({ work_status: 'scheduled', schedule: { scheduled_start: '2026-11-05T15:00:00Z', scheduled_start_local: '2026-11-05T08:00:00-07:00' } }), 'now');
  assert.equal(local.scheduled_local_date, '2026-11-05');
  // A job webhook without tags keeps the tags already known.
  assert.equal(hcpJobRow({ ...syntheticHcpJob(), tags: undefined }, 'now', { tags: '["Materials ordered"]' }).tags, '["Materials ordered"]');

  // In progress counts as scheduled; only complete is done.
  assert.equal(progressFromHcp({ ...scheduled, work_status: 'in progress' }, current).job_completed, 0);
  assert.equal(progressFromHcp({ ...scheduled, work_status: 'in progress' }, current).job_scheduled, 1);
  const finished = progressFromHcp({ ...scheduled, work_status: 'complete unrated', completed_at: '2026-11-04T01:00:00Z' }, current);
  assert.equal(finished.job_completed, 1);
  assert.equal(finished.completed_date, '2026-11-03');
  assert.equal(scheduled.outstanding_balance, 125000, "the job's balance is kept");
  assert.equal(finished.paid, 0, 'complete with a balance due is not paid');

  // An unpaid invoice sent: invoiced. Balance paid on a complete job: paid in full.
  const invoiced = progressFromHcp({ ...scheduled, work_status: 'complete unrated', completed_at: '2026-11-04T01:00:00Z', invoice_sent_at: '2026-11-05T17:00:00Z' }, current);
  assert.deepEqual([invoiced.invoiced, invoiced.invoiced_date, invoiced.paid], [1, '2026-11-05', 0]);
  const settled = progressFromHcp({ ...scheduled, work_status: 'complete unrated', completed_at: '2026-11-04T01:00:00Z', outstanding_balance: 0, invoice_sent_at: null, invoice_paid_at: '2026-11-07T17:00:00Z' }, { ...current, invoiced: 1, invoiced_date: '2026-11-05' });
  assert.deepEqual([settled.paid, settled.paid_date, settled.invoiced, settled.invoiced_date], [1, '2026-11-07', 1, '2026-11-05'], 'paid keeps the invoice it settled');
  // Paid up front: not paid in full for the tracker until the job is complete.
  assert.equal(progressFromHcp({ ...scheduled, outstanding_balance: 0, invoice_paid_at: '2026-10-20T17:00:00Z' }, current).paid, 0);
  // A balance not reported yet is not "paid".
  assert.equal(progressFromHcp({ ...scheduled, work_status: 'complete unrated', outstanding_balance: null }, current).paid, 0);
  // Only invoices sent and still open count as "sent"; voided ones don't.
  assert.deepEqual(invoiceSummary([
    { status: 'paid', sent_at: '2026-10-01T00:00:00Z', paid_at: '2026-10-02T00:00:00Z' },
    { status: 'open', sent_at: '2026-11-05T17:00:00Z' },
    { status: 'voided', sent_at: '2026-11-06T17:00:00Z' },
    { status: 'open', sent_at: null }
  ]), { invoice_sent_at: '2026-11-05T17:00:00.000Z', invoice_paid_at: '2026-10-02T00:00:00.000Z' });
  assert.deepEqual(invoiceSummary([]), { invoice_sent_at: null, invoice_paid_at: null });

  // Unscheduled in HCP clears the tracker's scheduled date.
  const back = progressFromHcp({ ...scheduled, work_status: 'needs scheduling', scheduled_start: null, scheduled_local_date: null }, { ...current, job_scheduled: 1, scheduled_date: '2026-11-03' });
  assert.equal(back.job_scheduled, 0);
  assert.equal(back.scheduled_date, '');
  // Canceled: nothing changes and nothing is shown.
  assert.equal(progressFromHcp({ ...scheduled, work_status: 'pro canceled' }, current), null);
  assert.equal(hcpSummary({ ...scheduled, work_status: 'pro canceled' }), null);
  assert.deepEqual({ ...hcpSummary({ ...scheduled, work_status: 'in progress' }), synced_at: undefined }, { job_id: scheduled.id, url: `https://pro.housecallpro.com/app/jobs/${scheduled.id}`, status: 'scheduled', scheduled_date: '2026-11-03', synced_at: undefined });
});

test('the API client sends the company key, waits out rate limits and reports a rejected key', async () => {
  const fake = await startFakeHcp();
  try {
    fake.jobs.set('job_a', syntheticHcpJob({ id: 'job_a' }));
    const waits = [];
    const client = createHcpClient({ apiKey: fake.apiKey, baseUrl: fake.url, sleep: async (ms) => { waits.push(ms); } });
    fake.rateLimitOnce();
    assert.equal((await client.getJob('job_a')).id, 'job_a');
    assert.equal(waits.length, 1);
    assert.ok(waits[0] >= 1000 && waits[0] <= 30000);
    assert.equal(fake.requests.at(-1).auth, `Token ${fake.apiKey}`);
    assert.equal(await client.getJob('job_missing'), null);
    const list = await client.listJobs({ page: 1, pageSize: 100 });
    assert.equal(list.jobs.length, 1);
    assert.deepEqual(fake.requests.at(-1).query, { page: '1', page_size: '100', sort_by: 'created_at', sort_direction: 'desc' });
    const wrongKey = createHcpClient({ apiKey: 'wrong', baseUrl: fake.url });
    await assert.rejects(wrongKey.getJob('job_a'), /rejected the API key/);
    assert.throws(() => createHcpClient({ apiKey: '' }), /HCP_API_KEY/);
  } finally {
    await fake.close();
  }
});

test('rate-limit waits are read as seconds or epoch times, and requests go one at a time', async () => {
  const fake = await startFakeHcp();
  try {
    fake.jobs.set('job_a', syntheticHcpJob({ id: 'job_a' }));
    const waits = [];
    const client = createHcpClient({ apiKey: fake.apiKey, baseUrl: fake.url, sleep: async (ms) => { waits.push(ms); } });
    fake.rateLimitOnce(1, { 'RateLimit-Reset': '12' });
    await client.getJob('job_a');
    assert.equal(waits.at(-1), 12000, 'RateLimit-Reset 12 = twelve seconds');
    fake.rateLimitOnce(1, { 'Retry-After': '3' });
    await client.getJob('job_a');
    assert.equal(waits.at(-1), 3000);
    const before = fake.requests.length;
    const results = await Promise.all([client.getJob('job_a'), client.getJob('job_a'), client.listJobs()]);
    assert.equal(results.length, 3);
    assert.equal(fake.maxConcurrent, 1);
    assert.equal(fake.requests.length - before, 3);
  } finally {
    await fake.close();
  }
});

test('one job HCP cannot read does not stop the sync from finding the others by number', async () => {
  const fake = await startFakeHcp();
  try {
    fake.jobs.set('job_found', syntheticHcpJob({ id: 'job_found', invoice_number: '22222222', work_status: 'scheduled', schedule: { scheduled_start: '2026-11-03T15:00:00Z' } }));
    fake.failJob('job_broken', 500);
    const now = '2026-10-26T00:00:00.000Z';
    const insert = (id, number, link, extra = '') => dbRun(`INSERT INTO orders (id, customer_name, supplier, date_ordered, housecall_job_number, housecall_job_link, created_at, updated_at, status${extra ? ', job_completed, paid' : ''}) VALUES (?, 'Synthetic Sync', 'Synthetic Supplier', '2026-10-01', ?, ?, ?, ?, 'Ordered'${extra})`, [id, number, link, now, now]);
    await insert('o-broken', '', 'https://pro.housecallpro.com/app/jobs/job_broken');
    await insert('o-number', '22222222', '');
    await insert('o-settled', '33333333', '', ', 1, 1');
    const client = createHcpClient({ apiKey: fake.apiKey, baseUrl: fake.url, sleep: async () => {} });
    const result = await syncHcp({ client });
    assert.equal(result.jobs_failed, 1);
    assert.equal(result.jobs_found_by_number, 1);
    assert.equal((await dbGet('SELECT hcp_job_id, job_scheduled FROM orders WHERE id = ?', ['o-number'])).job_scheduled, 1);
    assert.match((await dbGet("SELECT value FROM hcp_state WHERE name = 'last_error'")).value, /1 jobs could not be read/);
    // Finished orders (complete and paid) aren't looked up by number.
    assert.equal(result.numbers_not_found, 0);
  } finally {
    await fake.close();
  }
});

test('orders saved before the connection link by their HCP link or their approved job from HCP', async () => {
  const now = '2026-10-26T00:00:00.000Z';
  await dbRun("INSERT INTO job_drafts (id, customer_name, hcp_job_id, created_at, updated_at) VALUES ('draft-from-hcp', 'Synthetic Draft Job', 'job_11110000000000000000000000000002', ?, ?)", [now, now]);
  await dbRun("INSERT INTO orders (id, customer_name, supplier, date_ordered, housecall_job_link, created_at, updated_at, status) VALUES ('legacy-link', 'Synthetic Legacy', 'Synthetic Supplier', '2026-10-01', 'https://pro.housecallpro.com/app/jobs/job_11110000000000000000000000000001', ?, ?, 'Ordered')", [now, now]);
  await dbRun("INSERT INTO orders (id, customer_name, supplier, date_ordered, job_draft_id, created_at, updated_at, status) VALUES ('legacy-draft', 'Synthetic Draft Job', 'Synthetic Supplier', '2026-10-01', 'draft-from-hcp', ?, ?, 'Ordered')", [now, now]);
  const scheduled = (id, number) => hcpJobRow(syntheticHcpJob({ id, invoice_number: number, work_status: 'scheduled', schedule: { scheduled_start: '2026-11-03T15:00:00Z' } }), now);
  assert.deepEqual(await applyHcpJob(scheduled('job_11110000000000000000000000000001', '44444444')), ['legacy-link']);
  assert.deepEqual(await applyHcpJob(scheduled('job_11110000000000000000000000000002', '55555555')), ['legacy-draft']);
  for (const id of ['legacy-link', 'legacy-draft']) {
    const order = await dbGet('SELECT hcp_job_id, job_scheduled, scheduled_date FROM orders WHERE id = ?', [id]);
    assert.equal(order.job_scheduled, 1);
    assert.equal(order.scheduled_date, '2026-11-03');
    assert.match(order.hcp_job_id, /^job_1111/);
  }
});

test('appointment and invoice events for jobs not in the tracker are ignored and not stored', async () => {
  const appointment = await handleHcpWebhook({ event: 'job.appointment.scheduled', event_occurred_at: '2026-10-26T15:00:00Z', appointment: { id: 'appt_x', job_id: 'job_not_ours', start_time: '2026-11-03T15:00:00Z' } }, { eventId: 'unit-appointment' });
  const invoice = await handleHcpWebhook({ event: 'invoice.sent', event_occurred_at: '2026-10-26T15:01:00Z', invoice: { id: 'invoice_x', job_id: 'job_not_ours', sent_at: '2026-10-26T15:01:00Z' } }, { eventId: 'unit-invoice' });
  assert.equal(appointment.outcome, 'ignored');
  assert.equal(invoice.outcome, 'ignored');
  assert.equal(await dbGet("SELECT id FROM hcp_jobs WHERE id = 'job_not_ours'"), undefined);
  assert.equal((await handleHcpWebhook({ event: 'invoice.sent', invoice: { job_id: 'job_not_ours' } }, { eventId: 'unit-invoice' })).outcome, 'duplicate');
});

test('job types suggest a category until an admin chooses one', async () => {
  assert.equal(guessCategory('Shower Door Install'), 'Showers');
  assert.equal(guessCategory('Bathroom mirror'), 'Showers');
  assert.equal(guessCategory('Storefront repair'), 'Storefront');
  assert.equal(guessCategory('Window Replacement'), 'Windows');
  assert.equal(guessCategory('Patio door'), 'Windows');
  assert.equal(guessCategory('Tabletop glass'), 'Flat Glass');
  assert.equal(guessCategory('Auto windshield'), '', 'auto glass gets no guess');
  assert.equal(guessCategory('Service call'), '');
  const fake = await startFakeHcp();
  try {
    fake.jobTypes.push({ id: 'jt_shower', name: 'Shower Door Install' }, { id: 'jt_auto', name: 'Auto Glass' }, { id: 'jt_service', name: 'Service call' });
    const client = createHcpClient({ apiKey: fake.apiKey, baseUrl: fake.url });
    let types = await hcpJobTypes(client);
    assert.deepEqual(types.map(type => [type.name, type.category, type.chosen]), [['Shower Door Install', 'Showers', false], ['Auto Glass', '', false], ['Service call', '', false]]);
    await saveJobTypeCategories({ jt_auto: '', jt_service: 'Storefront', jt_bad: 'Not a category' });
    types = await hcpJobTypes(client);
    assert.deepEqual(types.map(type => [type.name, type.category, type.chosen]), [['Shower Door Install', 'Showers', false], ['Auto Glass', '', true], ['Service call', 'Storefront', true]]);
  } finally {
    await fake.close();
  }
});

test('an HCP link or job number fills in the customer, job number, category and notes', async () => {
  const fake = await startFakeHcp();
  try {
    fake.jobTypes.push({ id: 'jt_window', name: 'Window Replacement' });
    fake.jobs.set('job_000000000000000000000000000000aa', syntheticHcpJob({
      id: 'job_000000000000000000000000000000aa',
      invoice_number: '10240001',
      customer: { first_name: 'Pat', last_name: 'Sample', company: 'Sample Homes' },
      description: 'Replace 3 windows',
      notes: [{ id: 'n1', content: 'Gate code 1234' }, { id: 'n2', content: 'Replace 3 windows' }],
      job_fields: { job_type: { id: 'jt_window', name: 'Window Replacement' }, business_unit: null },
      attachments: [{ id: 'a1', file_name: 'measure.jpg', url: 'https://example.test/a1', file_type: 'image/jpeg' }]
    }));
    const client = createHcpClient({ apiKey: fake.apiKey, baseUrl: fake.url });
    const expected = {
      job_id: 'job_000000000000000000000000000000aa',
      url: 'https://pro.housecallpro.com/app/jobs/job_000000000000000000000000000000aa',
      invoice_number: '10240001',
      customer_name: 'Pat Sample (Sample Homes)',
      job_type: 'Window Replacement',
      category: 'Windows',
      notes: 'Replace 3 windows\nGate code 1234',
      attachments: 1
    };
    assert.deepEqual(await lookupHcpJob('https://pro.housecallpro.com/app/jobs/job_000000000000000000000000000000aa', { client }), expected);
    assert.equal(fake.requests.at(-1).query['expand[]'], 'attachments');
    assert.deepEqual(await lookupHcpJob(' 10240001 ', { client }), expected, 'found by job number');
    assert.equal(await lookupHcpJob('99999999', { client }), null);
    assert.equal(await lookupHcpJob('TBD', { client }), null);
    assert.equal(await lookupHcpJob('', { client }), null);
  } finally {
    await fake.close();
  }
});

test('ordering and receiving tag the HCP job and add a note, after the Undo window', async () => {
  const fake = await startFakeHcp();
  const saved = { key: process.env.HCP_API_KEY, base: process.env.HCP_API_BASE, delay: process.env.HCP_WRITE_DELAY_MS };
  Object.assign(process.env, { HCP_API_KEY: fake.apiKey, HCP_API_BASE: fake.url, HCP_WRITE_DELAY_MS: '0' });
  const settle = async (count) => {
    for (let i = 0; i < 100 && fake.writes().length < count; i += 1) await new Promise(resolve => setTimeout(resolve, 20));
    await new Promise(resolve => setTimeout(resolve, 60));
  };
  try {
    const jobId = 'job_000000000000000000000000000000bb';
    fake.jobs.set(jobId, syntheticHcpJob({ id: jobId, invoice_number: '10240002', tags: ['VIP'] }));
    const now = '2026-10-26T00:00:00.000Z';
    const insert = (id) => dbRun("INSERT INTO orders (id, customer_name, supplier, po_number, date_ordered, expected_delivery_date, hcp_job_id, created_at, updated_at, status) VALUES (?, 'Synthetic Tagged', 'Jeld-Wen', 'SAMPLE REV2', '2026-10-01', '2026-11-03', ?, ?, ?, 'Ordered')", [id, jobId, now, now]);
    await insert('tag-1');
    await insert('tag-2');

    hcpOrderChanged('tag-1', 'ordered');
    await settle(3);
    const job = fake.jobs.get(jobId);
    assert.deepEqual(job.tags.sort(), ['Materials ordered', 'VIP']);
    assert.deepEqual(job.notes.map(note => note.content), ['Order Tracker: materials ordered from Jeld-Wen, PO SAMPLE REV2, expected Nov 3.']);
    assert.ok(fake.tags.some(tag => tag.name === 'Materials received'), 'both tags are created the first time');

    // One of two orders here: still "ordered". Both here: "received".
    await dbRun("UPDATE orders SET date_received = '2026-10-30', status = 'Received', shop_location = 'H' WHERE id = 'tag-1'");
    hcpOrderChanged('tag-1', 'received');
    await settle(4);
    assert.deepEqual(job.tags.sort(), ['Materials ordered', 'VIP']);
    assert.equal(job.notes.at(-1).content, 'Order Tracker: Jeld-Wen materials received (PO SAMPLE REV2), shelf H.');
    await dbRun("UPDATE orders SET date_received = '2026-10-31', status = 'Received' WHERE id = 'tag-2'");
    const before = fake.writes().length;
    hcpOrderChanged('tag-2', 'received');
    await settle(before + 3);
    assert.deepEqual(job.tags.sort(), ['Materials received', 'VIP']);

    // A receive undone inside the window writes no note; tags follow the orders again.
    await dbRun("UPDATE orders SET date_received = NULL, status = 'Ordered' WHERE id = 'tag-2'");
    const notesBefore = job.notes.length;
    hcpOrderChanged('tag-2', 'received');
    await settle(fake.writes().length + 2);
    assert.equal(job.notes.length, notesBefore);
    assert.deepEqual(job.tags.sort(), ['Materials ordered', 'VIP']);

    // A read-only key can't write: the problem is recorded for the admin panel.
    fake.setReadOnly(true);
    await dbRun("UPDATE orders SET date_received = '2026-11-01', status = 'Received' WHERE id = 'tag-2'");
    hcpOrderChanged('tag-2', 'received');
    for (let i = 0; i < 100 && !(await dbGet("SELECT value FROM hcp_state WHERE name = 'last_write_error'"))?.value; i += 1) await new Promise(resolve => setTimeout(resolve, 20));
    assert.match((await dbGet("SELECT value FROM hcp_state WHERE name = 'last_write_error'")).value, /needs Full access/);
  } finally {
    for (const [name, value] of [['HCP_API_KEY', saved.key], ['HCP_API_BASE', saved.base], ['HCP_WRITE_DELAY_MS', saved.delay]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await fake.close();
  }
});

test('invoice events and the catch-up mark a complete job invoiced, then paid in full', async () => {
  const fake = await startFakeHcp();
  const saved = { key: process.env.HCP_API_KEY, base: process.env.HCP_API_BASE };
  Object.assign(process.env, { HCP_API_KEY: fake.apiKey, HCP_API_BASE: fake.url });
  const order = id => dbGet('SELECT job_completed, completed_date, invoiced, invoiced_date, paid, paid_date FROM orders WHERE id = ?', [id]);
  try {
    const JOB = 'job_00000000000000000000000000000e01';
    const finished = { work_status: 'complete unrated', work_timestamps: { completed_at: '2026-11-04T20:00:00Z' } };
    fake.jobs.set(JOB, { ...syntheticHcpJob({ id: JOB, invoice_number: '10260001', ...finished }), invoices: [{ id: 'invoice_1', status: 'open', sent_at: '2026-11-05T17:00:00Z' }] });
    const now = '2026-11-01T00:00:00.000Z';
    await dbRun("INSERT INTO orders (id, customer_name, supplier, date_ordered, hcp_job_id, created_at, updated_at, status) VALUES ('inv-1', 'Synthetic Invoiced', 'Jeld-Wen', '2026-10-01', ?, ?, ?, 'Received')", [JOB, now, now]);

    // Invoice sent: the event carries one invoice, so the job and all its invoices are read.
    const sent = await handleHcpWebhook({ event: 'invoice.sent', event_occurred_at: '2026-11-05T17:00:01Z', invoice: { id: 'invoice_1', job_id: JOB, status: 'open', sent_at: '2026-11-05T17:00:00Z' } }, { eventId: 'evt-invoice-sent' });
    assert.equal(sent.outcome, 'applied');
    assert.ok(fake.requests.some(request => request.path === `/jobs/${JOB}/invoices`));
    assert.deepEqual({ ...(await order('inv-1')) }, { job_completed: 1, completed_date: '2026-11-04', invoiced: 1, invoiced_date: '2026-11-05', paid: 0, paid_date: '' });

    // Paid in full: the balance is zero and the invoice is paid.
    fake.jobs.set(JOB, { ...fake.jobs.get(JOB), outstanding_balance: 0, invoices: [{ id: 'invoice_1', status: 'paid', sent_at: '2026-11-05T17:00:00Z', paid_at: '2026-11-07T18:00:00Z' }] });
    assert.equal((await handleHcpWebhook({ event: 'invoice.paid', event_occurred_at: '2026-11-07T18:00:01Z', invoice: { id: 'invoice_1', job_id: JOB, status: 'paid' } }, { eventId: 'evt-invoice-paid' })).outcome, 'applied');
    assert.deepEqual({ ...(await order('inv-1')) }, { job_completed: 1, completed_date: '2026-11-04', invoiced: 1, invoiced_date: '2026-11-05', paid: 1, paid_date: '2026-11-07' });

    // Invoices for jobs the tracker doesn't follow are ignored.
    assert.equal((await handleHcpWebhook({ event: 'invoice.sent', invoice: { id: 'invoice_x', job_id: 'job_00000000000000000000000000000e99' } }, { eventId: 'evt-invoice-other' })).outcome, 'ignored');

    // The catch-up keeps reading a complete job until it is paid, invoices included.
    const LATER = 'job_00000000000000000000000000000e02';
    fake.jobs.set(LATER, { ...syntheticHcpJob({ id: LATER, invoice_number: '10260002', ...finished }), invoices: [] });
    await dbRun("INSERT INTO orders (id, customer_name, supplier, date_ordered, hcp_job_id, job_completed, completed_date, created_at, updated_at, status) VALUES ('inv-2', 'Synthetic Later', 'Jeld-Wen', '2026-10-01', ?, 1, '2026-11-04', ?, ?, 'Received')", [LATER, now, now]);
    fake.jobs.get(LATER).invoices = [{ id: 'invoice_2', status: 'open', sent_at: '2026-11-06T17:00:00Z' }];
    await syncHcp();
    assert.equal((await order('inv-2')).invoiced, 1);
    assert.equal((await order('inv-2')).invoiced_date, '2026-11-06');
  } finally {
    for (const [name, value] of [['HCP_API_KEY', saved.key], ['HCP_API_BASE', saved.base]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await fake.close();
  }
});

// Kept last: its hourly catch-up reads every job the earlier tests left behind.
test('the Pipeline jobs board follows approved jobs and orders, forward only, once the columns are saved', async () => {
  const fake = await startFakeHcp();
  const saved = { key: process.env.HCP_API_KEY, base: process.env.HCP_API_BASE, delay: process.env.HCP_WRITE_DELAY_MS };
  Object.assign(process.env, { HCP_API_KEY: fake.apiKey, HCP_API_BASE: fake.url, HCP_WRITE_DELAY_MS: '0' });
  const moves = () => fake.requests.filter(request => request.method === 'PUT' && request.path === '/pipeline/statuses');
  const quiet = () => new Promise(resolve => setTimeout(resolve, 150));
  const until = async (check, what) => {
    for (let i = 0; i < 100; i += 1) {
      if (await check()) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.fail(`timed out waiting for ${what}`);
  };
  const column = jobId => fake.pipeline.find(status => status.id === fake.jobs.get(jobId).pipeline_status_id)?.name;
  const now = '2026-10-28T00:00:00.000Z';
  const approvedJob = (id, jobId, deposit) => dbRun('INSERT INTO job_drafts (id, customer_name, hcp_job_id, deposit_status, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, 'Synthetic Pipeline Job', jobId, deposit, 'Open', now, now]);
  try {
    // Tag ids cached by an earlier test belong to that test's stand-in HCP.
    await dbRun("DELETE FROM hcp_state WHERE name = 'tag_ids'");
    fake.pipeline.push(...['New Job', 'Deposit Needed', 'Need to Order Materials', 'Waiting on Materials', 'Materials Received', 'Unscheduled', 'Scheduled', 'In Progress', 'Completed', 'Invoice Sent', 'On Hold', 'Invoice Paid'].map((name, index) => ({ id: `kcs_${index}`, name, status_type: 'custom' })));
    const columnId = name => fake.pipeline.find(status => status.name === name).id;
    const JOB = 'job_00000000000000000000000000000f01';
    fake.jobs.set(JOB, syntheticHcpJob({ id: JOB, invoice_number: '10250001' }));
    await approvedJob('pipe-job', JOB, 'Awaiting deposit');

    // Nothing moves until an admin saves the columns; until then they are suggested by name.
    hcpApprovedJobChanged('pipe-job');
    await quiet();
    assert.equal(moves().length, 0);
    const board = await hcpPipeline();
    assert.equal(board.saved, false);
    assert.deepEqual(board.steps.map(step => [step.key, board.statuses.find(status => status.id === step.status_id)?.name]), [['deposit_needed', 'Deposit Needed'], ['need_to_order', 'Need to Order Materials'], ['waiting', 'Waiting on Materials'], ['received', 'Materials Received']]);
    const chosen = Object.fromEntries(board.steps.map(step => [step.key, step.status_id]));
    assert.equal((await savePipelineSteps({ ...chosen, waiting: 'kcs_not_a_column' })).waiting, '', 'only real columns are kept');
    assert.deepEqual(await savePipelineSteps(chosen), chosen);
    assert.equal((await hcpPipeline()).saved, true);

    // Approved job waiting on its deposit, then the deposit is in.
    hcpApprovedJobChanged('pipe-job');
    await until(() => column(JOB) === 'Deposit Needed', 'Deposit Needed');
    await dbRun("UPDATE job_drafts SET deposit_status = 'Deposit received' WHERE id = 'pipe-job'");
    hcpApprovedJobChanged('pipe-job');
    await until(() => column(JOB) === 'Need to Order Materials', 'Need to Order Materials');

    // One supplier order, with the approved job kept open for another: it arriving isn't "all here".
    await dbRun("INSERT INTO orders (id, customer_name, supplier, date_ordered, hcp_job_id, job_draft_id, created_at, updated_at, status) VALUES ('pipe-1', 'Synthetic Pipeline Job', 'Jeld-Wen', '2026-10-28', ?, 'pipe-job', ?, ?, 'Ordered')", [JOB, now, now]);
    hcpOrderChanged('pipe-1', 'ordered');
    await until(() => column(JOB) === 'Waiting on Materials', 'Waiting on Materials');
    await dbRun("UPDATE orders SET date_received = '2026-10-30', status = 'Received' WHERE id = 'pipe-1'");
    const beforeReceive = moves().length;
    hcpOrderChanged('pipe-1', 'received');
    await until(() => fake.jobs.get(JOB).notes.length === 2, 'the received note');
    assert.equal(moves().length, beforeReceive, 'the approved job still waits on another supplier');

    // The job is all ordered and everything is here: Materials Received.
    await dbRun("UPDATE job_drafts SET status = 'Completed' WHERE id = 'pipe-job'");
    hcpApprovedJobChanged('pipe-job');
    await until(() => column(JOB) === 'Materials Received', 'Materials Received');

    // Never backward: reopening the order re-matches the tags but leaves the column.
    await dbRun("UPDATE orders SET date_received = NULL, status = 'Ordered' WHERE id = 'pipe-1'");
    const settled = moves().length;
    hcpOrderChanged('pipe-1', 'changed');
    await until(() => (fake.jobs.get(JOB).tags || []).includes('Materials ordered'), 'tags re-matched');
    assert.equal(moves().length, settled);
    assert.equal(column(JOB), 'Materials Received');

    // A job HCP has scheduled is past these columns and left alone.
    const SCHEDULED = 'job_00000000000000000000000000000f02';
    fake.jobs.set(SCHEDULED, syntheticHcpJob({ id: SCHEDULED, invoice_number: '10250002', work_status: 'scheduled', schedule: { scheduled_start: '2026-11-03T15:00:00Z' } }));
    await approvedJob('pipe-scheduled', SCHEDULED, 'Deposit received');
    hcpApprovedJobChanged('pipe-scheduled');
    await until(async () => Boolean(await dbGet('SELECT id FROM hcp_jobs WHERE id = ?', [SCHEDULED])), 'the scheduled job read');
    await quiet();
    assert.equal(fake.jobs.get(SCHEDULED).pipeline_status_id, undefined);

    // A job someone put further along (On Hold): HCP refuses, the tracker notes it once and stops trying.
    const HELD = 'job_00000000000000000000000000000f03';
    fake.jobs.set(HELD, { ...syntheticHcpJob({ id: HELD, invoice_number: '10250003' }), pipeline_status_id: columnId('On Hold') });
    await approvedJob('pipe-held', HELD, 'Deposit waived / not required');
    hcpApprovedJobChanged('pipe-held');
    await until(async () => (await dbGet('SELECT pipeline_step FROM hcp_jobs WHERE id = ?', [HELD]))?.pipeline_step === 'need_to_order', 'the refusal noted');
    assert.match((await dbGet("SELECT value FROM hcp_state WHERE name = 'last_pipeline_refusal'")).value, /job 10250003: Housecall Pro answered 422: Pipeline status can only move forward/);
    assert.equal(column(HELD), 'On Hold');
    const refused = moves().length;
    hcpApprovedJobChanged('pipe-held');
    await quiet();
    assert.equal(moves().length, refused, 'not tried again');

    // The hourly catch-up moves an approved job whose move never happened.
    const MISSED = 'job_00000000000000000000000000000f04';
    fake.jobs.set(MISSED, syntheticHcpJob({ id: MISSED, invoice_number: '10250004' }));
    await approvedJob('pipe-missed', MISSED, 'Deposit received');
    assert.ok((await syncHcp()).pipeline_moves >= 1);
    assert.equal(column(MISSED), 'Need to Order Materials');
    assert.equal(column(JOB), 'Materials Received', 'the catch-up never moves a job back');

    // Try one job: moves right away and says what HCP answered.
    assert.equal((await testPipelineMove({ job: '10250004', statusId: columnId('Materials Received') })).message, 'Moved job 10250004 (Synthetic Customer) to Materials Received. Check the Pipeline board.');
    assert.match((await testPipelineMove({ job: '10250004', statusId: columnId('Deposit Needed') })).message, /422: Pipeline status can only move forward/);
    assert.equal((await testPipelineMove({ job: '10250004', statusId: 'kcs_nope' })).message, 'Choose a Pipeline column.');
    assert.equal((await testPipelineMove({ job: '99999999', statusId: columnId('Scheduled') })).moved, false);
  } finally {
    for (const [name, value] of [['HCP_API_KEY', saved.key], ['HCP_API_BASE', saved.base], ['HCP_WRITE_DELAY_MS', saved.delay]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await fake.close();
  }
});
