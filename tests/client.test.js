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
        listeners: {}, attributes: {}, dataset: {}, style: {}, offsetWidth: 150, offsetHeight: 90,
        showPopover() { this.open = true; },
        hidePopover() { this.open = false; },
        showModal() { this.open = true; },
        close() { this.open = false; },
        matches() { return Boolean(this.open); },
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
    markReceived = async id => calls.push(['mark-received', id]);
    deleteOrder = async id => calls.push(['delete-order', id]);
    reopenOrder = async id => calls.push(['reopen', id]);
    const originalQueueVisibility = renderQueueVisibility;
    const originalRenderOrders = renderOrders;
    renderOrders = () => calls.push(['render', state.orders[0]?.id]);
    renderQueueVisibility = () => {};
    showStatus = message => errors.push(message);
    globalThis.tracker = { state, bindEvents, loadOrders, renderJobDrafts, openDraftActionsMenu, renderCondensedOrders, renderOrderNotesPreview, renderDesktopOrderActions, openDesktopOrderMenu, updateLayoutMode, originalQueueVisibility, originalRenderOrders, offerUndo, runUndo, renderSupplierFilterOptions, formatDate };
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
  const html = node('jobDraftList').innerHTML;
  assert.equal((html.match(/<article /g) || []).length, 3);
  assert.equal(node('draftQueueSummary').textContent, '3 jobs · 1 ready to order');
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

test('phone cards show three short lines, link only real job URLs and offer edit, receive and delete', () => {
  const { node, tracker } = client();
  tracker.state.orders = [
    { id: 'phone-order', customer_name: 'Synthetic <Phone>', supplier: 'Synthetic Supplier', category: 'Showers', ordered_by: 'Synthetic Staff', status: 'Ordered', expected_delivery_date: '2026-11-03', housecall_job_number: 'HC-7', housecall_job_link: 'https://example.com/job/7', po_number: 'PO-9', notes: 'Bring <ladder>' },
    { id: 'received-order', customer_name: 'Received Job', supplier: 'Other', status: 'Received', date_received: '2026-10-20', housecall_job_number: 'HC-8', housecall_job_link: 'javascript:alert(1)' }
  ];
  tracker.originalRenderOrders();
  const cards = node('mobileOrderCards').innerHTML;
  assert.match(cards, /Synthetic &lt;Phone&gt;/);
  assert.match(cards, /Synthetic Supplier · Showers · Synthetic Staff/);
  assert.match(cards, /ETA Nov 3 · Job <a href="https:\/\/example.com\/job\/7"[^>]*>HC-7<\/a> · PO PO-9/);
  assert.match(cards, /Bring &lt;ladder&gt;/);
  assert.match(cards, /data-action="mark-received" data-id="phone-order"/);
  assert.match(cards, /data-action="delete-order" data-id="phone-order"/);
  assert.match(cards, /Received Oct 20 · Job HC-8/);
  assert.match(cards, /data-action="reopen" data-id="received-order"/);
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
