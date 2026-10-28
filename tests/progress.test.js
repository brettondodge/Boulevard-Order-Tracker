import test from 'node:test';
import assert from 'node:assert/strict';
import { archiveDeleteDate, normalizeProgressInput, orderStage } from '../src/utils.js';

test('stage is the furthest step reached: complete, then invoiced, then archived once paid', () => {
  assert.equal(orderStage({ date_received: '', expected_delivery_date: '2000-01-01' }), 'overdue');
  assert.equal(orderStage({ date_received: '', expected_delivery_date: '2999-01-01' }), 'ordered');
  assert.equal(orderStage({ date_received: '2026-10-01' }), 'received');
  assert.equal(orderStage({ date_received: '2026-10-01', job_scheduled: 1 }), 'scheduled');
  assert.equal(orderStage({ date_received: '2026-10-01', job_scheduled: 1, job_completed: 1 }), 'complete');
  assert.equal(orderStage({ date_received: '2026-10-01', job_completed: 1, invoiced: 1 }), 'invoiced');
  assert.equal(orderStage({ date_received: '2026-10-01', job_completed: 1, invoiced: 1, paid: 1 }), 'archived');
  // Paid up front isn't archived: the job has to be finished first.
  assert.equal(orderStage({ date_received: '2026-10-01', job_scheduled: 1, paid: 1 }), 'scheduled');
  // Not here yet beats scheduled: the material has to arrive first.
  assert.equal(orderStage({ date_received: '', job_scheduled: 1 }), 'ordered');
  // A finished job is done even if this order's Received box was never ticked.
  assert.equal(orderStage({ date_received: '', job_completed: 1 }), 'complete');
});

test('an archived order is deleted 7 days after it was both complete and paid', () => {
  assert.equal(archiveDeleteDate({ completed_date: '2026-10-28', paid_date: '2026-10-30' }), '2026-11-06');
  // Paid up front: the 7 days start when the job is finished.
  assert.equal(archiveDeleteDate({ completed_date: '2026-11-10', paid_date: '2026-10-01' }), '2026-11-17');
  assert.equal(archiveDeleteDate({ completed_date: '2026-12-28', paid_date: '' }), '2027-01-04');
  assert.equal(archiveDeleteDate({}), '');
});

test('progress input clears dates that no longer apply and fills today for newly ticked boxes', () => {
  const today = normalizeProgressInput({ job_completed: 1 }).completed_date;
  assert.match(today, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(normalizeProgressInput({ job_scheduled: false, scheduled_date: '2026-11-03', schedule_note: ' IGU ', job_completed: '1', invoiced: 1, paid: 0, paid_date: '2026-11-04' }), {
    job_scheduled: 0, scheduled_date: '', schedule_note: 'IGU', job_completed: 1, completed_date: today, invoiced: 1, invoiced_date: today, paid: 0, paid_date: ''
  });
  // Restoring saved values exactly: no date is made up.
  assert.equal(normalizeProgressInput({ job_completed: 1, paid: 1 }, { fill: [] }).completed_date, '');
  assert.equal(normalizeProgressInput({ job_completed: 1, paid: 1 }, { fill: ['paid'] }).paid_date, today);
  assert.equal(normalizeProgressInput({ invoiced: 1, invoiced_date: '2026-11-05' }).invoiced_date, '2026-11-05');
  assert.equal(normalizeProgressInput({ job_scheduled: 1, scheduled_date: 'not a date' }).scheduled_date, '');
  assert.equal(normalizeProgressInput({ job_scheduled: 1, scheduled_date: '2026-11-03' }).scheduled_date, '2026-11-03');
});
