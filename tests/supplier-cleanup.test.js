import test from 'node:test';
import assert from 'node:assert/strict';
import { supplierCleanupPlan, requireUnchangedCleanup } from '../src/supplier-cleanup.js';

test('cleanup prioritizes IDs, includes ID-free history and protects active suppliers', () => {
  const suppliers = [{id:'inactive',name:'Fake Supplier',active:0},{id:'active',name:'Real Supplier',active:1}];
  const orders = [
    {id:'linked',supplier_id:'inactive',supplier:'Old Fake Name',job_draft_id:'keep-draft'},
    {id:'legacy',supplier_id:null,supplier:' fake supplier '},
    {id:'keep',supplier_id:'active',supplier:'Fake Supplier'},
    {id:'orphan',supplier_id:'unknown',supplier:'Fake Supplier'}
  ];
  const plan = supplierCleanupPlan(suppliers,orders);
  assert.deepEqual(plan.order_ids,['legacy','linked']);
  assert.equal(plan.order_count,2); assert.equal(plan.supplier_count,1);
  assert.equal(plan.suppliers[0].order_count,2);
  assert.doesNotThrow(() => requireUnchangedCleanup(plan,plan.fingerprint));
  const changed = supplierCleanupPlan(suppliers, orders.map(row => ({ ...row, notes: 'changed' })));
  assert.throws(() => requireUnchangedCleanup(changed, plan.fingerprint), { code: 'CLEANUP_CHANGED' });
});

test('ambiguous historical names cannot delete orders belonging to an active supplier', () => {
  const plan = supplierCleanupPlan([{id:'a',name:'Same',active:0},{id:'b',name:'same',active:1}], [{id:'old',supplier_id:null,supplier:'Same'}]);
  assert.equal(plan.supplier_count,1); assert.equal(plan.order_count,0);
});
