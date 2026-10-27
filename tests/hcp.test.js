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
const { hcpJobIdFromLink, hcpJobRow, phoenixDate, progressFromHcp, verifyWebhookSignature, workStatusOf } = await import('../src/hcp/sync.js');

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
  assert.equal(check({ signature: `sha256=${digest.toString('hex')}` }), true);
  assert.equal(check({ secret: 'wrong' }), false);
  assert.equal(check({ rawBody: Buffer.from('{"event":"job.completed"}') }), false);
  assert.equal(check({ timestamp: String(now / 1000 + 1) }), false);
  assert.equal(check({ now: now + 2 * 86400 * 1000 }), false, 'deliveries older than a day are refused');
  assert.equal(check({ signature: '' }), false);
  assert.equal(check({ signature: 'not-a-signature' }), false);
  assert.equal(check({ secret: '' }), false);
});

test('job ids come from HCP job links; dates are Phoenix calendar days', () => {
  assert.equal(hcpJobIdFromLink('https://pro.housecallpro.com/app/jobs/job_4f2a9c1b8e7d6c5b4a39281706f5e4d3?tab=notes'), 'job_4f2a9c1b8e7d6c5b4a39281706f5e4d3');
  assert.equal(hcpJobIdFromLink('https://example.com/jobs/hc-1'), '');
  assert.equal(hcpJobIdFromLink(''), '');
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

test('an HCP job maps onto tracker progress: scheduled and complete mirror HCP, invoiced only turns on', () => {
  const scheduled = hcpJobRow(syntheticHcpJob({
    work_status: 'scheduled',
    schedule: { scheduled_start: '2026-11-04T04:30:00Z', scheduled_end: '2026-11-04T06:00:00Z', scheduled_start_local: null },
    assigned_employees: [{ first_name: 'Synthetic', last_name: 'Tech' }, { first_name: 'Second', last_name: '' }],
    customer: { first_name: 'Pat', last_name: 'Sample', company: 'Sample Homes' }
  }), '2026-10-21T00:00:00.000Z');
  assert.equal(scheduled.scheduled_local_date, '2026-11-03');
  assert.equal(scheduled.assigned_names, 'Synthetic Tech, Second');
  assert.equal(scheduled.customer_name, 'Pat Sample (Sample Homes)');
  assert.equal(scheduled.outstanding_balance, 125000);
  const current = { job_scheduled: 0, scheduled_date: '', schedule_note: 'Two-man job', job_completed: 0, completed_date: '', invoiced: 0, invoice_reference: '' };
  assert.deepEqual(progressFromHcp(scheduled, current), { job_scheduled: 1, scheduled_date: '2026-11-03', schedule_note: 'Two-man job', job_completed: 0, completed_date: '', invoiced: 0, invoice_reference: '' });

  const local = hcpJobRow(syntheticHcpJob({ work_status: 'scheduled', schedule: { scheduled_start: '2026-11-05T15:00:00Z', scheduled_start_local: '2026-11-05T08:00:00-07:00' } }), 'now');
  assert.equal(local.scheduled_local_date, '2026-11-05');

  const done = { ...scheduled, work_status: 'complete unrated', completed_at: '2026-11-04T01:00:00Z', invoice_sent_at: '2026-11-04T02:00:00Z' };
  const finished = progressFromHcp(done, current);
  assert.equal(finished.job_completed, 1);
  assert.equal(finished.completed_date, '2026-11-03');
  assert.equal(finished.invoiced, 1);
  assert.equal(finished.invoice_reference, '10239422');

  // Unscheduled in HCP clears the tracker's scheduled date, but never un-bills.
  const back = progressFromHcp({ ...scheduled, work_status: 'needs scheduling', scheduled_start: null, scheduled_local_date: null }, { ...current, job_scheduled: 1, scheduled_date: '2026-11-03', invoiced: 1, invoice_reference: 'Paid by check' });
  assert.equal(back.job_scheduled, 0);
  assert.equal(back.scheduled_date, '');
  assert.equal(back.invoiced, 1);
  assert.equal(back.invoice_reference, 'Paid by check');
  assert.equal(progressFromHcp({ ...scheduled, work_status: 'pro canceled' }, current), null);
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
    assert.deepEqual(await client.getJobInvoices('job_a'), []);
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
