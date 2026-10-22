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
        addEventListener(name, callback) { this.listeners[name] = callback; },
        setAttribute(name, value) { this.attributes[name] = value; },
        classList: {
          toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); },
          contains: name => classes.has(name)
        }
      });
    }
    return nodes.get(id);
  };
  const context = vm.createContext({
    document: { getElementById: node, querySelector: node, querySelectorAll: () => [], addEventListener() {} },
    window: { innerWidth: 1200, innerHeight: 800, matchMedia: () => ({ matches: false }), localStorage: { setItem() {} } }, fetch, AbortController, URLSearchParams,
    calls: [], errors: []
  });
  vm.runInContext(readFileSync(new URL('../public/app.js', import.meta.url), 'utf8') + `
    openOrderDialog = (order, draft) => calls.push([draft ? 'create-order' : 'edit', (order || draft).id]);
    openDraftDialog = draft => calls.push(['edit-draft', draft.id]);
    archiveDraft = async id => calls.push(['archive-draft', id]);
    completeDraft = async id => calls.push(['complete-draft', id]);
    reopenDraft = async id => calls.push(['reopen-draft', id]);
    markReceived = async id => calls.push(['mark-received', id]);
    archiveOrder = async id => calls.push(['archive-order', id]);
    restoreOrder = async id => calls.push(['restore-order', id]);
    reopenOrder = async id => calls.push(['reopen', id]);
    const originalQueueVisibility = renderQueueVisibility;
    renderOrders = () => calls.push(['render', state.orders[0]?.id]);
    renderQueueVisibility = () => {};
    showStatus = message => errors.push(message);
    globalThis.tracker = { state, bindEvents, loadOrders, renderJobDrafts, openDraftActionsMenu, renderCondensedOrders, renderOrderNotesPreview, renderDesktopOrderActions, openDesktopOrderMenu, updateLayoutMode, originalQueueVisibility };
  `, context);
  return { context, node, tracker: context.tracker };
}

test('phone cards and desktop table dispatch every order action', async () => {
  const { context, node, tracker } = client();
  tracker.state.orders = [{ id: 'synthetic-order' }];
  tracker.bindEvents();
  for (const container of ['mobileOrderCards', 'ordersTableBody', 'condensedOrdersBody', 'desktopOrderMenu']) {
    for (const action of ['edit', 'mark-received', 'archive-order', 'restore-order', 'reopen']) {
      await node(container).listeners.click({ target: { closest: () => ({ dataset: { action, id: 'synthetic-order' } }) } });
      assert.deepEqual(Array.from(context.calls.at(-1)), [action, 'synthetic-order']);
    }
    await node(container).listeners.click({ target: { closest: () => null } });
  }
  assert.equal(context.calls.length, 20);
});

test('desktop actions keep common buttons inline and move secondary actions into the menu', async () => {
  const { node, tracker, context } = client();
  tracker.bindEvents();
  const order = { id: 'synthetic', customer_name: 'Synthetic job', status: 'Received' };
  tracker.state.orders = [order];
  let html = tracker.renderDesktopOrderActions(order);
  assert.match(html, /data-action="edit"/);
  assert.match(html, /data-order-menu="synthetic"/);
  assert.doesNotMatch(html, /data-action="reopen"|data-action="archive-order"/);
  const trigger = { dataset: { orderMenu: 'synthetic' }, getBoundingClientRect: () => ({ right: 1200, top: 760, bottom: 795 }) };
  await node('ordersTableBody').listeners.click({ preventDefault() {}, target: { closest: () => trigger } });
  const menu = node('desktopOrderMenu');
  assert.equal(menu.open, true);
  assert.match(menu.innerHTML, /data-action="reopen"/);
  assert.match(menu.innerHTML, /data-action="archive-order"/);
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
  order.is_archived = 1;
  html = tracker.renderDesktopOrderActions(order);
  assert.match(html, /data-action="restore-order"/);
  assert.doesNotMatch(html, /data-order-menu|data-action="archive-order"|data-action="mark-received"/);
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
  assert.doesNotMatch(html, /data-action="archive-draft"|data-action="complete-draft"/);
  const trigger = { dataset: { draftMenu: 'ready' }, getBoundingClientRect: () => ({ right: 500, top: 200, bottom: 240 }) };
  await node('jobDraftList').listeners.click({ preventDefault() {}, target: { closest: () => trigger } });
  const menu = node('draftActionsMenu');
  assert.equal(menu.open, true);
  assert.match(menu.innerHTML, /data-action="complete-draft"/);
  assert.match(menu.innerHTML, /data-action="archive-draft"/);
  for (const action of ['edit-draft', 'create-order', 'complete-draft', 'archive-draft']) {
    await (action === 'complete-draft' || action === 'archive-draft' ? menu : node('jobDraftList')).listeners.click({ target: { closest: () => ({ dataset: { action, id: 'ready' } }) } });
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
  for (const mobile of [false, true]) {
    context.window.matchMedia = () => ({ matches: mobile });
    tracker.originalQueueVisibility();
    assert.equal(node('condensedOrders').classList.contains('hidden'), false);
    assert.equal(node('.table-wrap').classList.contains('hidden'), true);
    assert.equal(node('mobileOrderCards').classList.contains('hidden'), true);
    assert.equal(node('condensedViewToggle').attributes['aria-pressed'], 'true');
  }
  node('condensedViewToggle').listeners.click();
  tracker.originalQueueVisibility();
  assert.equal(node('condensedOrders').classList.contains('hidden'), true);
  assert.equal(node('mobileOrderCards').classList.contains('hidden'), false);
  tracker.state.condensedView = true;
  tracker.state.status = 'Approved – Need to Order';
  tracker.originalQueueVisibility();
  assert.equal(node('condensedOrders').classList.contains('hidden'), true);
  assert.equal(node('condensedViewToggle').disabled, true);
  tracker.state.status = 'Archived';
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
  tracker.state.status = 'Archived';
  const second = tracker.loadOrders();
  assert.equal(pending[0].signal.aborted, true);
  assert.match(pending[1].url, /status=Archived/);
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
