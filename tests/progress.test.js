import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeProgressInput, orderStage } from '../src/utils.js';

test('stage is the furthest step reached, and complete is the last step', () => {
  assert.equal(orderStage({ date_received: '', expected_delivery_date: '2000-01-01' }), 'overdue');
  assert.equal(orderStage({ date_received: '', expected_delivery_date: '2999-01-01' }), 'ordered');
  assert.equal(orderStage({ date_received: '2026-10-01' }), 'received');
  assert.equal(orderStage({ date_received: '2026-10-01', job_scheduled: 1 }), 'scheduled');
  assert.equal(orderStage({ date_received: '2026-10-01', job_scheduled: 1, job_completed: 1 }), 'complete');
  // Not here yet beats scheduled: the material has to arrive first.
  assert.equal(orderStage({ date_received: '', job_scheduled: 1 }), 'ordered');
  // A finished job is done even if this order's Received box was never ticked.
  assert.equal(orderStage({ date_received: '', job_completed: 1 }), 'complete');
});

test('progress input clears dates that no longer apply and fills a completion date', () => {
  const today = normalizeProgressInput({ job_completed: 1 }).completed_date;
  assert.match(today, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(normalizeProgressInput({ job_scheduled: false, scheduled_date: '2026-11-03', schedule_note: ' IGU ', job_completed: '1' }), {
    job_scheduled: 0, scheduled_date: '', schedule_note: 'IGU', job_completed: 1, completed_date: today
  });
  assert.equal(normalizeProgressInput({ job_completed: 1 }, { fillCompletedDate: false }).completed_date, '');
  assert.equal(normalizeProgressInput({ job_scheduled: 1, scheduled_date: 'not a date' }).scheduled_date, '');
  assert.equal(normalizeProgressInput({ job_scheduled: 1, scheduled_date: '2026-11-03' }).scheduled_date, '2026-11-03');
});
