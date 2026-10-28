import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function client(fetch) {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) {
      const classes = new Set();
      nodes.set(id, {
        listeners: {}, attributes: {}, dataset: {}, style: {}, offsetWidth: 150, offsetHeight: 90, options: [], selectedOptions: [],
        add() {},
        showPopover() { this.open = true; },
        hidePopover() { this.open = false; },
        showModal() { this.open = true; },
        close() { this.open = false; },
        matches() { return Boolean(this.open); },
        querySelector() { return this.checkedRadio || null; },
        focus() { this.focused = true; },
        querySelectorAll(selector) { const inputs = this.inputs || []; return selector.includes(':checked') ? inputs.filter(input => input.checked) : inputs; },
        addEventListener(name, callback) { this.listeners[name] = callback; },
        setAttribute(name, value) { this.attributes[name] = value; },
        classList: {
          toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
          add: name => classes.add(name),
          remove: name => classes.delete(name),
          contains: name => classes.has(name)
        }
      });
    }
    return nodes.get(id);
  };
  const context = vm.createContext({
    document: { getElementById: node, querySelector: node, querySelectorAll: () => [], addEventListener() {} },
    window: { innerWidth: 1200, innerHeight: 800, matchMedia: () => ({ matches: false }), localStorage: { setItem() {} } }, fetch, AbortController, URLSearchParams,
    setTimeout, clearTimeout, Intl,
    calls: [], errors: []
  });
  vm.runInContext(readFileSync(new URL('../public/app.js', import.meta.url), 'utf8') + `
    openOrderDialog = (order, draft) => calls.push([draft ? 'create-order' : 'edit', (order || draft).id]);
    openDraftDialog = draft => calls.push(['edit-draft', draft.id]);
    deleteDraft = async id => calls.push(['delete-draft', id]);
    completeDraft = async id => calls.push(['complete-draft', id]);
    reopenDraft = async id => calls.push(['reopen-draft', id]);
    const originalMarkReceived = markReceived;
    markReceived = async id => calls.push(['mark-received', id]);
    deleteOrder = async id => calls.push(['delete-order', id]);
    reopenOrder = async id => calls.push(['reopen', id]);
    const originalQueueVisibility = renderQueueVisibility;
    const originalRenderOrders = renderOrders;
    renderOrders = () => calls.push(['render', state.orders[0]?.id]);
    renderQueueVisibility = () => {};
    showStatus = message => errors.push(message);
    globalThis.tracker = { state, bindEvents, loadOrders, renderJobDrafts, openDraftActionsMenu, renderCondensedOrders, renderOrderNotesPreview, renderDesktopOrderActions, openDesktopOrderMenu, updateLayoutMode, originalQueueVisibility, originalRenderOrders, offerUndo, runUndo, renderSupplierFilterOptions, formatDate, orderStatusBadge, nextStep, openProgressDialog, saveProgressDialog, markJobComplete, renderHcpStatus, renderHcpJobTypes, fillFromHousecallPro, originalMarkReceived, saveReceive, syncStartFresh, applyStartFresh, saveOrder, renderHcpPipeline, saveHcpPipeline, testHcpPipeline };
  `, context);
  return { context, node, tracker: context.tracker };
}

test('phone cards and desktop table dispatch every order action', async () => {
  const { context, node, tracker } = client();
  tracker.state.orders = [{ id: 'synthetic-order' }];
  tracker.bindEvents();
  for (const container of ['mobileOrderCards', 'ordersTableBody', 'condensedOrdersBody', 'desktopOrderMenu']) {
    for (const action of ['edit', 'mark-received', 'delete-order', 'reopen']) {
      await node(container).listeners.click({ target: { closest: () => ({ dataset: { action, id: 'synthetic-order' } }) } });
      assert.deepEqual(Array.from(context.calls.at(-1)), [action, 'synthetic-order']);
    }
    await node(container).listeners.click({ target: { closest: () => null } });
  }
  assert.equal(context.calls.length, 16);
});

test('desktop actions keep common buttons inline and move secondary actions into the menu', async () => {
  const { node, tracker, context } = client();
  tracker.bindEvents();
  const order = { id: 'synthetic', customer_name: 'Synthetic job', status: 'Received' };
  tracker.state.orders = [order];
  let html = tracker.renderDesktopOrderActions(order);
  assert.match(html, /data-action="edit"/);
  assert.match(html, /data-order-menu="synthetic"/);
  assert.doesNotMatch(html, /data-action="reopen"|data-action="delete-order"/);
  const trigger = { dataset: { orderMenu: 'synthetic' }, getBoundingClientRect: () => ({ right: 1200, top: 760, bottom: 795 }) };
  await node('ordersTableBody').listeners.click({ preventDefault() {}, target: { closest: () => trigger } });
  const menu = node('desktopOrderMenu');
  assert.equal(menu.open, true);
  assert.match(menu.innerHTML, /data-action="reopen"/);
  assert.match(menu.innerHTML, /data-action="delete-order"/);
  assert.equal(menu.style.left, '1042px');
  assert.equal(menu.style.top, '664px');
  await menu.listeners.click({ target: { closest: () => ({ dataset: { action: 'reopen', id: 'synthetic' } }) } });
  assert.deepEqual(Array.from(context.calls.at(-1)), ['reopen', 'synthetic']);
  assert.equal(menu.open, false);
  order.status = 'Ordered';
  html = tracker.renderDesktopOrderActions(order);
  assert.match(html, /data-action="mark-received"/);
  tracker.openDesktopOrderMenu(order.id, trigger);
  assert.doesNotMatch(menu.innerHTML, /data-action="reopen"/);
  tracker.openDesktopOrderMenu(order.id, trigger);
  assert.equal(menu.open, false);
});

test('approved queue separates jobs, shows deposit readiness and preserves full notes and draft actions', async () => {
  const { context, node, tracker } = client();
  const notes = 'Synthetic <notes> '.repeat(12);
  tracker.state.jobDrafts = [
    { id: 'ready', customer_name: 'Ready <Job>', deposit_status: 'Deposit received', status: 'Open', housecall_job_number: 'HC-42', hcp_job_id: 'internal-synthetic-id', supplier_order_count: 2, notes },
    { id: 'waiting', customer_name: 'Awaiting job', deposit_status: 'Awaiting deposit', status: 'Open' },
    { id: 'completed', customer_name: 'Completed job', deposit_status: 'Deposit waived / not required', status: 'Completed' }
  ];
  tracker.bindEvents();
  tracker.renderJobDrafts();
  let html = node('jobDraftList').innerHTML;
  // Jobs with all materials ordered are hidden until asked for.
  assert.equal((html.match(/<article /g) || []).length, 2);
  assert.equal(node('draftQueueSummary').textContent, '2 jobs · 1 ready to order');
  assert.equal(node('showFinishedJobsButton').textContent, 'Show 1 with all materials ordered');
  assert.equal(node('showFinishedJobsButton').classList.contains('hidden'), false);
  node('showFinishedJobsButton').listeners.click();
  html = node('jobDraftList').innerHTML;
  assert.equal((html.match(/<article /g) || []).length, 3);
  assert.equal(node('showFinishedJobsButton').textContent, 'Hide jobs with all materials ordered');
  assert.match(html, /Ready &lt;Job&gt;/);
  assert.match(html, /HC-42/);
  assert.doesNotMatch(html, /internal-synthetic-id|Stable HCP ID/);
  assert.ok(html.includes(notes.trim().replaceAll('<', '&lt;').replaceAll('>', '&gt;')));
  assert.match(html, /data-action="create-order" data-id="waiting" disabled/);
  assert.match(html, /data-action="create-order" data-id="completed" disabled/);
  assert.doesNotMatch(html, /data-action="delete-draft"|data-action="complete-draft"/);
  const trigger = { dataset: { draftMenu: 'ready' }, getBoundingClientRect: () => ({ right: 500, top: 200, bottom: 240 }) };
  await node('jobDraftList').listeners.click({ preventDefault() {}, target: { closest: () => trigger } });
  const menu = node('draftActionsMenu');
  assert.equal(menu.open, true);
  assert.match(menu.innerHTML, /data-action="complete-draft"/);
  assert.match(menu.innerHTML, /data-action="delete-draft"/);
  for (const action of ['edit-draft', 'create-order', 'complete-draft', 'delete-draft']) {
    await (action === 'complete-draft' || action === 'delete-draft' ? menu : node('jobDraftList')).listeners.click({ target: { closest: () => ({ dataset: { action, id: 'ready' } }) } });
    assert.deepEqual(Array.from(context.calls.at(-1)), [action, 'ready']);
    assert.equal(menu.open, false);
  }
  tracker.openDraftActionsMenu('completed', trigger);
  assert.match(menu.innerHTML, /data-action="reopen-draft"/);
  assert.doesNotMatch(menu.innerHTML, /data-action="complete-draft"/);
  await menu.listeners.click({ target: { closest: () => ({ dataset: { action: 'reopen-draft', id: 'completed' } }) } });
  assert.deepEqual(Array.from(context.calls.at(-1)), ['reopen-draft', 'completed']);
  tracker.state.jobDrafts = [];
  tracker.renderJobDrafts();
  assert.match(node('jobDraftList').innerHTML, /No approved jobs waiting to order/);
  assert.equal(node('showFinishedJobsButton').classList.contains('hidden'), true);
  assert.equal(menu.open, false);
});

test('desktop notes preview stays short and clicking opens the complete original text', async () => {
  const { node, tracker } = client();
  const notes = 'Synthetic <notes>\n'.repeat(12) + 'Final instruction.';
  const order = { id: 'notes-order', customer_name: 'Synthetic Customer', supplier: 'Synthetic Supplier', notes };
  tracker.state.orders = [order];
  tracker.bindEvents();
  const html = tracker.renderOrderNotesPreview(order);
  assert.match(html, /Synthetic &lt;notes&gt;/);
  assert.match(html, /…/);
  assert.match(html, /View notes/);
  assert.doesNotMatch(html, /Final instruction/);
  await node('ordersTableBody').listeners.click({ target: { closest: () => ({ dataset: { action: 'view-notes', id: order.id } }) } });
  assert.equal(node('orderNotesDialog').open, true);
  assert.equal(node('orderNotesText').textContent, notes);
  assert.equal(node('orderNotesCustomer').textContent, 'Synthetic Customer · Synthetic Supplier');
  node('dismissOrderNotesButton').listeners.click();
  assert.equal(node('orderNotesDialog').open, false);
  assert.equal(tracker.renderOrderNotesPreview({ notes: '  ' }), '—');
  assert.equal(order.notes, notes);
});

test('clicking a row opens its details with every action; buttons, links and copying text do not', async () => {
  const { node, tracker, context } = client();
  const order = { id: 'row-order', customer_name: 'Synthetic <Customer>', po_number: 'SYN PO', category: 'Windows', supplier: 'Synthetic Supplier', ordered_by: 'AD', date_ordered: '2026-10-20', expected_delivery_date: '2026-10-30', status: 'Received', date_received: '2026-10-25', shop_location: 'H', notes: 'Line one\nLine <two>', created_by: 'office@example.com', created_at: '2026-10-20T16:00:00Z' };
  tracker.state.orders = [order];
  tracker.bindEvents();
  const dialog = node('orderDetailsDialog');
  const row = { dataset: { orderRow: 'row-order' } };
  const clickRow = (inside = null) => node('ordersTableBody').listeners.click({ target: { closest: selector => (selector.includes('data-order-row') ? row : selector.startsWith('a,') ? inside : null) } });

  await clickRow({});
  assert.equal(dialog.open, undefined, 'a link or button inside the row keeps its own job');
  context.window.getSelection = () => 'SYN PO';
  await clickRow();
  assert.equal(dialog.open, undefined, 'selecting text to copy does not open the details');
  context.window.getSelection = () => '';
  await clickRow();
  assert.equal(dialog.open, true);
  assert.equal(node('orderDetailsTitle').textContent, 'Synthetic <Customer>');
  const body = node('orderDetailsBody').innerHTML;
  for (const text of ['SYN PO', 'Synthetic Supplier', 'Oct 25', 'Line one\nLine &lt;two&gt;', 'office@example.com']) assert.ok(body.includes(text), text);
  for (const action of ['edit', 'progress', 'reopen', 'delete-order', 'schedule']) assert.match(body, new RegExp(`data-action="${action}" data-id="row-order"`));

  await dialog.listeners.click({ target: { closest: () => ({ dataset: { action: 'edit', id: 'row-order' } }) } });
  assert.equal(dialog.open, false, 'choosing an action closes the details');
  assert.deepEqual(Array.from(context.calls.at(-1)), ['edit', 'row-order']);

  await node('ordersTableBody').listeners.keydown({ key: 'Enter', preventDefault() {}, target: { matches: () => true, dataset: { orderRow: 'row-order' } } });
  assert.equal(dialog.open, true, 'Enter on a focused row opens it too');
  order.notes = 'Changed by someone else';
  tracker.originalRenderOrders();
  assert.match(node('orderDetailsBody').innerHTML, /Changed by someone else/);
  assert.match(node('ordersTableBody').innerHTML, /data-order-row="row-order" tabindex="0"/);
  assert.match(node('ordersTableBody').innerHTML, /class="actions-col"/);
  assert.match(node('condensedOrdersBody').innerHTML, /data-order-row="row-order"/);
  assert.match(node('mobileOrderCards').innerHTML, /data-order-row="row-order"/);
  tracker.state.orders = [];
  tracker.originalRenderOrders();
  assert.equal(dialog.open, false, 'an order that leaves the list closes its details');
});

test('Master Lists: several new names before saving each stay, even starting from an empty list', () => {
  const { node, tracker } = client();
  tracker.bindEvents();
  tracker.state.masterSuppliers = [{ id: 's1', name: 'Existing Supplier', active: true }];
  tracker.state.masterStaffNames = [];
  const type = (editor, kind, index, value) => node(editor).listeners.input({ target: { dataset: { kind, field: 'name', index: String(index), id: '' }, value } });

  node('addSupplierEntry').listeners.click();
  type('supplierMasterList', 'supplier', 1, 'New Supplier One');
  node('addSupplierEntry').listeners.click();
  type('supplierMasterList', 'supplier', 2, 'New Supplier Two');
  assert.deepEqual(tracker.state.masterSuppliers.map(item => item.name), ['Existing Supplier', 'New Supplier One', 'New Supplier Two']);

  // An empty list (after Start fresh) shows one blank row; what's typed there is kept.
  type('orderedByMasterList', 'staff', 0, 'AB');
  node('addStaffEntry').listeners.click();
  type('orderedByMasterList', 'staff', 1, 'CD');
  node('orderedByMasterList').listeners.change({ target: { dataset: { kind: 'staff', field: 'active', index: '1', id: '' }, checked: false } });
  assert.deepEqual(tracker.state.masterStaffNames.map(item => [item.name, item.active]), [['AB', true], ['CD', false]]);
});

test('an order from an approved job finishes the job; "Save + another supplier" keeps it open for the next order', async () => {
  const requests = [];
  const { context, node, tracker } = client(async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url, method: options.method || 'GET', body });
    if (url === '/api/orders' && options.method === 'POST') return { ok: true, json: async () => ({ order: { id: 'new-order' }, job_completed: !body.keep_job_open }) };
    if (url === '/api/job-drafts') return { ok: true, json: async () => ({ drafts: [{ id: 'job-1', customer_name: 'Synthetic Job', status: 'Open', deposit_status: 'Deposit received', supplier_order_count: 1 }] }) };
    // The supplier and staff lists aren't what this test is about.
    if (url === '/api/suppliers' || url === '/api/master-lists') return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => ({ orders: [] }) };
  });
  tracker.bindEvents();
  const fillForm = (category) => {
    tracker.state.masterSuppliers = [{ id: 'sup-1', name: 'Synthetic Supplier', active: true }];
    tracker.state.masterStaffNames = [{ id: 'staff-1', name: 'AD', active: true }];
    for (const [id, value] of Object.entries({ orderId: '', jobDraftId: 'job-1', customerName: 'Synthetic Job', housecallJobNumber: '21', housecallJobLink: '', supplierInput: 'sup-1', poNumber: 'SYN PO', dateOrdered: '2026-10-28', expectedDeliveryDate: '', dateReceived: '', shopLocation: '', notes: '', categorySelect: category, orderedBySelect: 'staff-1' })) node(id).value = value;
  };
  const posts = () => requests.filter(request => request.method === 'POST');

  fillForm('Windows');
  await tracker.saveOrder();
  assert.equal(posts().at(-1).body.job_draft_id, 'job-1');
  assert.equal(posts().at(-1).body.keep_job_open, false);
  assert.equal(node('undoMessage').textContent, 'Order added. Synthetic Job moved to Outstanding.');
  assert.equal(context.calls.some(call => call[0] === 'create-order'), false, 'the usual save does not open another order');
  await tracker.runUndo();
  assert.deepEqual(posts().slice(-2).map(request => request.url), ['/api/orders/new-order/delete', '/api/job-drafts/job-1/reopen'], 'undo takes the order back and returns the job to Approved');

  fillForm('Showers');
  await node('saveOrderAnotherButton').listeners.click();
  assert.equal(posts().at(-1).body.keep_job_open, true);
  assert.match(node('undoMessage').textContent, /stays in Approved – Need to Order/);
  assert.deepEqual(Array.from(context.calls.at(-1)), ['create-order', 'job-1'], 'the form opens again for the same job');
  assert.equal(node('categorySelect').value, 'Showers');
  assert.equal(node('orderedBySelect').value, 'staff-1');
});

test('condensed toggle preserves filters, uses the loaded orders and switches layout on desktop and phone', () => {
  const { context, node, tracker } = client(() => { throw new Error('Toggling layout must not request new data'); });
  tracker.state.orders = [{ id: 'filtered-order', customer_name: 'Synthetic <Customer>', supplier: 'Keep Supplier', status: 'Received', notes: 'Check clearance', date_received: '2026-10-12' }];
  tracker.state.supplier = ['keep-id'];
  tracker.state.orderedBy = ['staff-id'];
  tracker.state.status = 'Received';
  tracker.bindEvents();
  node('condensedViewToggle').listeners.click();
  assert.equal(tracker.state.condensedView, true);
  assert.deepEqual(Array.from(tracker.state.supplier), ['keep-id']);
  assert.deepEqual(Array.from(tracker.state.orderedBy), ['staff-id']);
  assert.equal(tracker.state.status, 'Received');
  assert.match(node('condensedOrderCount').textContent, /1 matching supplier order$/);
  assert.match(node('condensedOrdersBody').innerHTML, /Synthetic &lt;Customer&gt;/);
  assert.match(node('condensedOrdersBody').innerHTML, /Check clearance/);
  assert.match(node('condensedOrdersBody').innerHTML, /data-id="filtered-order"/);
  tracker.originalQueueVisibility();
  assert.equal(node('condensedOrders').classList.contains('hidden'), false);
  assert.equal(node('.table-wrap').classList.contains('hidden'), true);
  assert.equal(node('mobileOrderCards').classList.contains('hidden'), true);
  assert.equal(node('condensedViewToggle').attributes['aria-pressed'], 'true');
  // Phones always get the cards, even when Condensed lines was left on.
  context.window.matchMedia = () => ({ matches: true });
  tracker.originalQueueVisibility();
  assert.equal(node('condensedOrders').classList.contains('hidden'), true);
  assert.equal(node('mobileOrderCards').classList.contains('hidden'), false);
  node('condensedViewToggle').listeners.click();
  tracker.originalQueueVisibility();
  assert.equal(node('condensedOrders').classList.contains('hidden'), true);
  assert.equal(node('mobileOrderCards').classList.contains('hidden'), false);
  tracker.state.condensedView = true;
  tracker.state.status = 'Approved – Need to Order';
  tracker.originalQueueVisibility();
  assert.equal(node('condensedOrders').classList.contains('hidden'), true);
  assert.equal(node('condensedViewToggle').disabled, true);
  tracker.state.status = 'Received';
  tracker.state.orders = [];
  tracker.renderCondensedOrders();
  tracker.originalQueueVisibility();
  assert.equal(node('condensedOrders').classList.contains('hidden'), true);
  assert.equal(node('emptyState').classList.contains('hidden'), false);
  assert.equal(node('condensedOrdersBody').innerHTML, '');
});

test('new filters cancel old requests and stale responses cannot replace current orders', async () => {
  const pending = [];
  const { context, tracker } = client((url, options) => new Promise(resolve => pending.push({ url, signal: options.signal, resolve })));
  const first = tracker.loadOrders();
  tracker.state.status = 'Received';
  const second = tracker.loadOrders();
  assert.equal(pending[0].signal.aborted, true);
  assert.match(pending[1].url, /status=Received/);
  pending[1].resolve({ ok: true, json: async () => ({ orders: [{ id: 'latest' }] }) });
  await second;
  pending[0].resolve({ ok: true, json: async () => ({ orders: [{ id: 'stale' }] }) });
  await first;
  assert.equal(tracker.state.orders[0].id, 'latest');
  assert.equal(context.calls.length, 1);
  const third = tracker.loadOrders();
  tracker.state.status = 'Approved – Need to Order';
  await tracker.loadOrders();
  assert.equal(pending[2].signal.aborted, true);
  pending[2].resolve({ ok: false });
  await third;
  assert.equal(context.errors.length, 0);
});

test('phone cards show three short lines, link only real job URLs and offer edit, the next step and more', () => {
  const { node, tracker } = client();
  tracker.state.orders = [
    { id: 'phone-order', customer_name: 'Synthetic <Phone>', supplier: 'Synthetic Supplier', category: 'Showers', ordered_by: 'Synthetic Staff', status: 'Ordered', expected_delivery_date: '2026-11-03', housecall_job_number: 'HC-7', housecall_job_link: 'https://example.com/job/7', po_number: 'PO-9', notes: 'Bring <ladder>' },
    { id: 'received-order', customer_name: 'Received Job', supplier: 'Other', status: 'Received', date_received: '2026-10-20', housecall_job_number: 'HC-8', housecall_job_link: 'javascript:alert(1)' }
  ];
  tracker.originalRenderOrders();
  const cards = node('mobileOrderCards').innerHTML;
  assert.match(cards, /Synthetic &lt;Phone&gt;/);
  assert.match(cards, /Synthetic Supplier · PO PO-9 · Showers · Synthetic Staff/);
  assert.match(cards, /ETA Nov 3 · Job <a href="https:\/\/example.com\/job\/7"[^>]*>HC-7<\/a><\/p>/);
  assert.match(cards, /Bring &lt;ladder&gt;/);
  assert.match(cards, /data-action="mark-received" data-id="phone-order"/);
  assert.match(cards, /data-order-menu="phone-order"/);
  assert.match(cards, /Received Oct 20 · Job HC-8/);
  assert.match(cards, /data-action="schedule" data-id="received-order">Mark scheduled/);
  assert.doesNotMatch(cards + node('ordersTableBody').innerHTML, /javascript:/);
  assert.equal(tracker.formatDate('2025-03-04'), 'Mar 4, 2025');
});

test('undo puts a change back once, then the bar goes away', async () => {
  const fetched = [];
  const { context, node, tracker } = client(async url => { fetched.push(url); return { ok: true, json: async () => ({ drafts: [], orders: [] }) }; });
  let undone = 0;
  tracker.offerUndo('Order added.', async () => { undone += 1; });
  assert.equal(node('undoToast').classList.contains('hidden'), false);
  assert.equal(node('undoMessage').textContent, 'Order added.');
  await tracker.runUndo();
  await tracker.runUndo();
  assert.equal(undone, 1);
  assert.equal(node('undoToast').classList.contains('hidden'), true);
  assert.ok(fetched.some(url => url.startsWith('/api/job-drafts')));
  tracker.offerUndo('Order deleted.', async () => { throw new Error('Someone else changed this order.'); });
  await tracker.runUndo();
  assert.match(context.errors.at(-1), /Couldn't undo: Someone else changed this order/);
});

test('supplier filter is a checkbox list: ticking boxes filters, the summary and count follow', async () => {
  const { node, tracker } = client(() => new Promise(() => {}));
  tracker.state.supplierFilterOptions = [{ id: 's-b', name: 'Bayside' }, { id: 's-a', name: 'Arrow', active: false }, { id: '', name: 'Old Name', historical: true }];
  tracker.bindEvents();
  tracker.renderSupplierFilterOptions();
  const html = node('supplierFilter').innerHTML;
  assert.ok(html.indexOf('Arrow') < html.indexOf('Bayside'));
  assert.match(html, /\(inactive\)/);
  assert.match(html, /\(historical\)/);
  assert.equal(node('supplierSelectionSummary').textContent, 'All');
  node('supplierFilter').inputs = [{ value: 's-a', checked: true }, { value: 's-b', checked: true }, { value: 'Old Name', checked: false }];
  node('supplierFilter').listeners.change();
  assert.deepEqual(Array.from(tracker.state.supplier), ['s-a', 's-b']);
  assert.equal(node('supplierSelectionSummary').textContent, 'Arrow, Bayside');
  assert.equal(node('filtersToggle').textContent, 'Filters (1)');
  assert.equal(node('clearFiltersButton').classList.contains('hidden'), false);
  node('clearFiltersButton').listeners.click();
  assert.deepEqual(Array.from(tracker.state.supplier), []);
  assert.equal(node('filtersToggle').textContent, 'Filters');
});

test('each order shows its furthest step and offers the next one; paid is the last step', () => {
  const { tracker } = client();
  const base = { id: 'step', customer_name: 'Synthetic Step', status: 'Received', date_received: '2026-10-20' };
  const cases = [
    [{ ...base, status: 'Ordered', date_received: '', stage: 'ordered' }, /Ordered/, 'mark-received'],
    [{ ...base, stage: 'received' }, /Ready to schedule/, 'schedule'],
    [{ ...base, stage: 'scheduled', job_scheduled: 1, scheduled_date: '2026-11-03' }, /Scheduled Nov 3/, 'mark-complete'],
    [{ ...base, stage: 'complete', job_scheduled: 1, job_completed: 1 }, /Complete/, 'mark-invoiced'],
    // A finished job is done even if this order was never ticked received.
    [{ ...base, status: 'Ordered', date_received: '', stage: 'complete', job_completed: 1 }, /Complete/, 'mark-invoiced'],
    [{ ...base, stage: 'invoiced', job_completed: 1, invoiced: 1, invoiced_date: '2026-11-05' }, /Invoiced Nov 5/, 'mark-paid'],
    [{ ...base, stage: 'archived', job_completed: 1, invoiced: 1, paid: 1, archive_delete_date: '2026-11-13' }, /Archived · deletes Nov 13/, null]
  ];
  for (const [order, label, action] of cases) {
    assert.match(tracker.orderStatusBadge(order), label);
    assert.equal(tracker.nextStep(order)?.action ?? null, action);
  }
  assert.equal(tracker.nextStep(cases[3][0]).label, 'Mark invoiced');
  assert.equal(tracker.nextStep(cases[5][0]).label, 'Mark paid');
  const early = { ...base, status: 'Ordered', date_received: '', stage: 'overdue', job_scheduled: 1, scheduled_date: '2026-10-28' };
  assert.match(tracker.orderStatusBadge(early), /Scheduled Oct 28, not here yet/);
});

test('job progress window saves the order and undo restores it exactly', async () => {
  const requests = [];
  const { context, node, tracker } = client(async (url, options = {}) => {
    requests.push({ url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    if (url.includes('/progress')) return { ok: true, json: async () => ({ order_ids: ['p1'], updated_at: 'v2', previous: [{ id: 'p1', shop_location: '', job_scheduled: 0 }] }) };
    return { ok: true, json: async () => ({ orders: [], drafts: [] }) };
  });
  const order = { id: 'p1', customer_name: 'Synthetic Progress', supplier: 'Synthetic Supplier', updated_at: 'v1', status: 'Received', date_received: '2026-10-20' };
  tracker.state.orders = [order];
  tracker.bindEvents();
  await node('ordersTableBody').listeners.click({ target: { closest: () => ({ dataset: { action: 'schedule', id: 'p1' } }) } });
  assert.equal(node('progressDialog').open, true);
  assert.equal(node('progressScheduled').checked, true);
  assert.equal(node('progressScheduledDate').disabled, false);
  assert.equal(node('progressScheduledDate').focused, true);
  assert.match(node('progressJobHint').textContent, /archived for 7 days, then deleted/);
  node('progressScheduledDate').value = '2026-11-03';
  node('progressShopLocation').value = 'H';
  await tracker.saveProgressDialog();
  const save = requests.find(request => request.method === 'PUT');
  assert.equal(save.url, '/api/orders/p1/progress');
  assert.equal(save.body.job_scheduled, 1);
  assert.equal(save.body.scheduled_date, '2026-11-03');
  assert.equal(save.body.shop_location, 'H');
  assert.equal(save.body.updated_at, 'v1');
  assert.equal(node('progressDialog').open, false);
  assert.equal(node('undoMessage').textContent, 'Job progress saved.');
  await tracker.runUndo();
  const undo = requests.find(request => request.url === '/api/order-progress/restore');
  assert.equal(undo.body.updated_at, 'v2');
  assert.deepEqual(undo.body.items.map(item => item.id), ['p1']);

  await tracker.markJobComplete({ ...order, job_scheduled: 1 });
  const complete = requests.filter(request => request.method === 'PUT').at(-1);
  assert.equal(complete.body.job_completed, 1);
  assert.equal(complete.body.job_scheduled, 1);
  assert.match(node('undoMessage').textContent, /Synthetic Progress marked complete/);
  assert.deepEqual(Array.from(context.errors.filter(Boolean)), ['Undone.']);
});

test('linked orders show what Housecall Pro says and send scheduling to HCP', async () => {
  const { node, tracker } = client(async () => ({ ok: true, json: async () => ({ orders: [] }) }));
  const url = 'https://pro.housecallpro.com/app/jobs/job_0000000000000000000000000000000a';
  const base = { id: 'linked', customer_name: 'Synthetic Linked', status: 'Received', date_received: '2026-10-20', stage: 'received', updated_at: 'v1', housecall_job_number: '10239422', hcp: { job_id: 'job_a', url, status: 'unscheduled', scheduled_date: '' } };
  assert.match(tracker.orderStatusBadge(base), /HCP: Needs scheduling/);
  assert.deepEqual({ ...tracker.nextStep(base) }, { link: url, label: 'Schedule in HCP', primary: true });
  const scheduled = { ...base, stage: 'scheduled', job_scheduled: 1, scheduled_date: '2026-11-03', hcp: { ...base.hcp, status: 'scheduled', scheduled_date: '2026-11-03' } };
  assert.match(tracker.orderStatusBadge(scheduled), /<span class="hcp-status">HCP: Scheduled Nov 3<\/span>/);
  assert.equal(tracker.nextStep(scheduled).label, 'Open in HCP');
  const done = { ...scheduled, stage: 'complete', job_completed: 1, hcp: { ...scheduled.hcp, status: 'completed' } };
  assert.match(tracker.orderStatusBadge(done), /HCP: Complete/);
  assert.deepEqual({ ...tracker.nextStep(done) }, { link: url, label: 'Invoice in HCP', primary: true }, 'complete in HCP: the invoice is next, sent from HCP');
  assert.equal(tracker.nextStep({ ...done, invoiced: 1 }).label, 'Open in HCP');
  assert.equal(tracker.nextStep({ ...done, invoiced: 1, paid: 1 }), null, 'paid in full is the last step');
  // Canceled jobs aren't shown and fall back to the tracker's own steps.
  const canceled = { ...base, hcp: { ...base.hcp, status: 'canceled' } };
  assert.doesNotMatch(tracker.orderStatusBadge(canceled), /HCP:/);
  assert.equal(tracker.nextStep(canceled).action, 'schedule');
  assert.equal(tracker.nextStep({ ...base, date_received: '', status: 'Ordered' }).action, 'mark-received');

  // In the progress window, HCP owns scheduled and complete.
  tracker.state.orders = [scheduled];
  tracker.openProgressDialog(scheduled);
  assert.equal(node('progressScheduled').disabled, true);
  assert.equal(node('progressCompleted').disabled, true);
  assert.equal(node('progressInvoiced').disabled, true);
  assert.equal(node('progressPaid').disabled, true);
  assert.equal(node('progressScheduledDate').disabled, true);
  assert.match(node('progressJobHint').textContent, /come from Housecall Pro/);
  tracker.openProgressDialog({ ...base, hcp: null });
  assert.equal(node('progressScheduled').disabled, false);
});

test('the Housecall Pro panel says what is set up and what is missing', () => {
  const { node, tracker } = client();
  tracker.renderHcpStatus({ api: false, webhooks: false, writes: false, linked_jobs: 0, recent_events: [] });
  assert.match(node('hcpStatusText').textContent, /Not connected yet/);
  assert.equal(node('hcpSyncButton').disabled, true);
  assert.equal(node('hcpJobTypesSection').classList.contains('hidden'), true);
  tracker.renderHcpStatus({ api: true, webhooks: false, writes: true, linked_jobs: 3, last_event_at: '', last_sync_at: '2026-10-26T15:00:00Z', last_sync_summary: { jobs_refreshed: 2, jobs_found_by_number: 1, numbers_not_found: 4 }, last_error: '', last_write_error: '2026-10-26 The API key needs Full access to add tags and notes.', recent_events: [{ event: 'job.<scheduled>', outcome: 'applied', received_at: '2026-10-26T15:00:00Z' }] });
  const text = node('hcpStatusText').textContent;
  assert.match(text, /API connected/);
  assert.match(text, /webhooks not set up \(HCP_WEBHOOK_SECRET\)/);
  assert.match(text, /3 linked jobs/);
  assert.match(text, /last webhook never/);
  assert.match(text, /2 refreshed, 1 found by job number, 4 job numbers not found/);
  assert.match(text, /tags and notes in HCP not working: .*Full access/);
  assert.match(text, /Pipeline moves off until the columns are saved/);
  assert.equal(node('hcpSyncButton').disabled, false);
  assert.match(node('hcpRecentEvents').innerHTML, /job\.&lt;scheduled&gt; · applied/);

  tracker.renderHcpJobTypes([{ id: 'jt_1', name: 'Shower <Door>', category: 'Showers', chosen: false }, { id: 'jt_2', name: 'Auto Glass', category: '', chosen: true }]);
  const list = node('hcpJobTypesList').innerHTML;
  assert.equal(node('hcpJobTypesSection').classList.contains('hidden'), false);
  assert.match(list, /Shower &lt;Door&gt;/);
  assert.match(list, /<option value="Showers" selected>Showers \(suggested\)<\/option>/);
  assert.match(list, /data-job-type="jt_2"><option value="">No category<\/option>/);
});

test('Master Lists: a Pipeline column for each step, saved on request, and a one-job try', async () => {
  const requests = [];
  const { node, tracker } = client(async (url, options = {}) => {
    requests.push({ url, method: options.method || 'GET', body: options.body ? JSON.parse(options.body) : null });
    if (url === '/api/hcp/pipeline/test') return { ok: true, json: async () => ({ moved: true, message: 'Moved job 21 (Sample Customer) to On Hold. Check the Pipeline board.' }) };
    return { ok: true, json: async () => ({ statuses: [], steps: [], saved: true }) };
  });
  tracker.bindEvents();
  const statuses = [{ id: 'kcs_1', name: 'Deposit <Needed>' }, { id: 'kcs_2', name: 'Need to Order Materials' }];
  tracker.renderHcpPipeline({ statuses, saved: false, steps: [{ key: 'deposit_needed', label: 'Approved job waiting on its deposit', status_id: 'kcs_1' }, { key: 'received', label: 'All materials here', status_id: '' }] });
  assert.equal(node('hcpPipelineSection').classList.contains('hidden'), false);
  const list = node('hcpPipelineList').innerHTML;
  assert.match(list, /<option value="kcs_1" selected>Deposit &lt;Needed&gt; \(suggested\)<\/option>/);
  assert.match(list, /data-pipeline-step="received"><option value="">Don't move<\/option>/);
  assert.match(node('hcpPipelineTestColumn').innerHTML, /<option value="kcs_2" >Need to Order Materials<\/option>/);

  node('hcpPipelineList').inputs = [{ dataset: { pipelineStep: 'deposit_needed' }, value: 'kcs_1' }, { dataset: { pipelineStep: 'received' }, value: '' }];
  await tracker.saveHcpPipeline();
  assert.deepEqual(requests.find(request => request.method === 'PUT').body, { steps: { deposit_needed: 'kcs_1', received: '' } });

  node('hcpPipelineTestJob').value = '';
  node('hcpPipelineTestColumn').value = '';
  await tracker.testHcpPipeline();
  assert.equal(node('hcpPipelineTestResult').textContent, 'Paste a test job and choose a column.');
  node('hcpPipelineTestJob').value = ' https://pro.housecallpro.com/app/jobs/job_1 ';
  node('hcpPipelineTestColumn').value = 'kcs_2';
  await tracker.testHcpPipeline();
  assert.deepEqual(requests.at(-1).body, { job: 'https://pro.housecallpro.com/app/jobs/job_1', status_id: 'kcs_2' });
  assert.match(node('hcpPipelineTestResult').textContent, /Moved job 21/);
  assert.equal(node('hcpPipelineTestButton').disabled, false);

  tracker.renderHcpPipeline({ statuses: [], steps: [], saved: false });
  assert.equal(node('hcpPipelineSection').classList.contains('hidden'), true, 'without Pipeline the section stays hidden');
});

test('paid jobs have no next step, and an already-complete job keeps its blank completion date', async () => {
  const { node, tracker } = client();
  tracker.bindEvents();
  assert.equal(tracker.nextStep({ id: 'x', date_received: '', job_completed: 1, paid: 1 }), null);
  const done = { id: 'done', customer_name: 'Synthetic Done', status: 'Received', date_received: '2026-10-20', job_completed: 1, completed_date: '', updated_at: 'v1' };
  tracker.openProgressDialog(done);
  assert.equal(node('progressCompleted').checked, true);
  assert.equal(node('progressCompletedDate').value, '', 'opening the window does not invent a date');
  // Ticking Invoice sent suggests today; Paid stays as it was.
  node('progressInvoiced').checked = true;
  node('progressInvoiced').listeners.change({ target: node('progressInvoiced') });
  assert.match(node('progressInvoicedDate').value, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(node('progressInvoicedDate').disabled, false);
  assert.equal(node('progressPaidDate').disabled, true);
  // Mark paid opens the window with Paid in full ticked and dated today.
  tracker.state.orders = [{ ...done, invoiced: 1 }];
  await node('ordersTableBody').listeners.click({ target: { closest: () => ({ dataset: { action: 'mark-paid', id: 'done' } }) } });
  assert.equal(node('progressPaid').checked, true);
  assert.match(node('progressPaidDate').value, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(node('progressInvoiced').checked, true);
});


test('pasting an HCP link fills in only the empty boxes; a job number becomes the link', async () => {
  const requests = [];
  const job = { job_id: 'job_a', url: 'https://pro.housecallpro.com/app/jobs/job_a', invoice_number: '10240001', customer_name: 'Pat Sample (Sample <Homes>)', job_type: 'Window Replacement', category: 'Windows', notes: 'Replace 3 windows', attachments: 2 };
  let answer = { ok: true, status: 200, json: async () => ({ job }) };
  const { node, tracker } = client(async (url) => { requests.push(url); return answer; });
  node('housecallJobLink').value = '10240001';
  node('customerName').value = 'Typed by staff';
  await tracker.fillFromHousecallPro('order', '10240001');
  assert.equal(requests[0], '/api/hcp/lookup?q=10240001');
  assert.equal(node('housecallJobLink').value, job.url);
  assert.equal(node('customerName').value, 'Typed by staff', 'typed boxes are kept');
  assert.equal(node('housecallJobNumber').value, '10240001');
  assert.equal(node('categorySelect').value, 'Windows');
  assert.equal(node('notes').value, 'Replace 3 windows');
  assert.equal(node('hcpFillStatus').textContent, 'Filled in from Housecall Pro: job #, category, notes. It has 2 photos or files in HCP.');
  // The same link isn't looked up twice (paste and then leaving the box).
  await tracker.fillFromHousecallPro('order', job.url);
  assert.equal(requests.length, 1);

  answer = { ok: false, status: 503, json: async () => ({ error: "Housecall Pro isn't connected yet." }) };
  await tracker.fillFromHousecallPro('draft', 'https://pro.housecallpro.com/app/jobs/job_b');
  assert.equal(node('draftHcpFillStatus').textContent, "Housecall Pro isn't connected yet, so nothing was filled in.");
  answer = { ok: false, status: 404, json: async () => ({ error: "Couldn't find that job in Housecall Pro." }) };
  await tracker.fillFromHousecallPro('draft', '99999999');
  assert.equal(node('draftHcpFillStatus').textContent, "Couldn't find that job in Housecall Pro.");
  await tracker.fillFromHousecallPro('draft', '');
  assert.equal(node('draftHcpFillStatus').textContent, '');
});

test('Mark received asks for the shelf, and Undo puts the old shelf back', async () => {
  const requests = [];
  const { node, tracker } = client(async (url, options = {}) => {
    requests.push({ url, body: options.body ? JSON.parse(options.body) : null });
    if (url.includes('/mark-received')) return { ok: true, json: async () => ({ order: { id: 'r1', updated_at: 'v2' } }) };
    return { ok: true, json: async () => ({ orders: [], drafts: [] }) };
  });
  const order = { id: 'r1', customer_name: 'Synthetic Receive', po_number: 'SAMPLE REV2', supplier: 'Jeld-Wen', shop_location: 'G', updated_at: 'v1', status: 'Ordered' };
  tracker.state.orders = [order];
  tracker.originalMarkReceived('r1');
  assert.equal(node('receiveDialog').open, true);
  assert.equal(node('receiveCustomer').textContent, 'Synthetic Receive · PO SAMPLE REV2 · Jeld-Wen');
  assert.equal(node('receiveShopLocation').value, 'G');
  assert.match(node('receiveDate').value, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(node('receiveShopLocation').focused, true);
  node('receiveShopLocation').value = 'H';
  await tracker.saveReceive();
  const save = requests.find(request => request.url === '/api/orders/r1/mark-received');
  assert.deepEqual(save.body, { date_received: node('receiveDate').value, shop_location: 'H', updated_at: 'v1' });
  assert.equal(node('receiveDialog').open, false);
  assert.equal(node('undoMessage').textContent, 'Synthetic Receive marked received.');
  await tracker.runUndo();
  assert.deepEqual(requests.find(request => request.url === '/api/orders/r1/reopen').body, { updated_at: 'v2', shop_location: 'G' });
});

test('Start fresh needs DELETE ALL typed and says what it removed', async () => {
  const requests = [];
  const { context, node, tracker } = client(async (url, options = {}) => {
    requests.push({ url, body: options.body ? JSON.parse(options.body) : null });
    if (url === '/api/admin/start-fresh' && options.method === 'POST') return { ok: true, json: async () => ({ deleted: { orders: 322, jobs: 80, suppliers: 104, staff: 3 } }) };
    return { ok: true, json: async () => ({ orders: [], drafts: [], suppliers: [], staff_names: [] }) };
  });
  node('startFreshConfirmation').value = 'delete all';
  tracker.syncStartFresh();
  assert.equal(node('applyStartFreshButton').disabled, true);
  node('startFreshConfirmation').value = 'DELETE ALL';
  tracker.syncStartFresh();
  assert.equal(node('applyStartFreshButton').disabled, false);
  node('startFreshLists').checked = true;
  await tracker.applyStartFresh();
  assert.deepEqual(requests.find(request => request.url === '/api/admin/start-fresh').body, { confirmation: 'DELETE ALL', include_lists: true });
  assert.match(context.errors.at(-1), /Started fresh: deleted 322 orders and 80 approved jobs, 104 suppliers and 3 staff/);
});
