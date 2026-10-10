const state = {
  status: 'Outstanding',
  groupView: 'All Orders',
  category: '',
  supplier: [],
  orderedBy: [],
  search: '',
  sort: 'expected_delivery_date',
  orders: [],
  suppliers: [],
  staffNames: [],
  masterSuppliers: [],
  masterStaffNames: [],
  adminLoggedIn: false,
  connectionState: 'live',
  requestCounter: 0,
  orderRequestCounter: 0,
  masterRequestCounter: 0,
  supplierRequestCounter: 0,
  eventSource: null
};

const elements = {
  currentUser: document.getElementById('currentUser'),
  searchInput: document.getElementById('searchInput'),
  groupFilter: document.getElementById('groupFilter'),
  categoryFilter: document.getElementById('categoryFilter'),
  supplierFilter: document.getElementById('supplierFilter'),
  clearSupplierButton: document.getElementById('clearSupplierButton'),
  supplierSelectionSummary: document.getElementById('supplierSelectionSummary'),
  orderedByFilter: document.getElementById('orderedByFilter'),
  clearOrderedByButton: document.getElementById('clearOrderedByButton'),
  orderedBySelectionSummary: document.getElementById('orderedBySelectionSummary'),
  sortSelect: document.getElementById('sortSelect'),
  addOrderButton: document.getElementById('addOrderButton'),
  masterListsButton: document.getElementById('masterListsButton'),
  logoutButton: document.getElementById('logoutButton'),
  tableBody: document.getElementById('ordersTableBody'),
  emptyState: document.getElementById('emptyState'),
  statusMessage: document.getElementById('statusMessage'),
  liveStatus: document.getElementById('liveStatus'),
  saveStatus: document.getElementById('saveStatus'),
  dialog: document.getElementById('orderDialog'),
  form: document.getElementById('orderForm'),
  formError: document.getElementById('formError'),
  closeDialogButton: document.getElementById('closeDialogButton'),
  cancelOrderButton: document.getElementById('cancelOrderButton'),
  dialogTitle: document.getElementById('dialogTitle'),
  orderId: document.getElementById('orderId'),
  orderUpdatedAt: document.getElementById('orderUpdatedAt'),
  categorySelect: document.getElementById('categorySelect'),
  orderedBySelect: document.getElementById('orderedBySelect'),
  masterListsDialog: document.getElementById('masterListsDialog'),
  closeMasterListsButton: document.getElementById('closeMasterListsButton'),
  adminUsernameInput: document.getElementById('adminUsernameInput'),
  adminPasswordInput: document.getElementById('adminPasswordInput'),
  adminLoginButton: document.getElementById('adminLoginButton'),
  adminLoginSection: document.getElementById('adminLoginSection'),
  masterListsSection: document.getElementById('masterListsSection'),
  supplierMasterList: document.getElementById('supplierMasterList'),
  orderedByMasterList: document.getElementById('orderedByMasterList'),
  addSupplierEntry: document.getElementById('addSupplierEntry'),
  addStaffEntry: document.getElementById('addStaffEntry'),
  saveMasterListsButton: document.getElementById('saveMasterListsButton'),
  adminLogoutButton: document.getElementById('adminLogoutButton')
};

document.addEventListener('DOMContentLoaded', async () => {
  bindEvents();
  setupLiveUpdates();

  try {
    await refreshAdminState();
    await Promise.all([loadSuppliers(), loadMasterLists(), loadOrders()]);
  } catch (error) {
    showStatus('Unable to load the tracker. Please refresh the page.', 'error');
  }
});

function setConnectionState(stateName, message = '') {
  state.connectionState = stateName;
  if (!elements.liveStatus) return;

  const map = {
    live: { label: message || 'Live', className: 'live' },
    reconnecting: { label: message || 'Reconnecting…', className: 'reconnecting' },
    offline: { label: message || 'Offline', className: 'offline' }
  };

  const next = map[stateName] || map.live;
  elements.liveStatus.textContent = next.label;
  elements.liveStatus.className = `connection-indicator ${next.className}`;
}

function setSaveState(mode, message = '') {
  const indicator = elements.saveStatus;
  if (!indicator) return;

  const map = {
    saving: { label: message || 'Saving…', className: 'saving' },
    saved: { label: message || 'Saved', className: 'saved' },
    failed: { label: message || 'Save failed', className: 'failed' }
  };

  const next = map[mode] || map.saved;
  indicator.textContent = next.label;
  indicator.className = `save-status ${next.className}`;
}

function setupLiveUpdates() {
  const reestablishConnection = () => {
    if (state.eventSource) {
      state.eventSource.close();
    }

    setConnectionState('reconnecting', 'Reconnecting…');
    state.eventSource = new EventSource('/api/events');

    state.eventSource.addEventListener('connected', () => {
      setConnectionState('live', 'Live');
      refreshAllData('live-sync');
    });

    state.eventSource.addEventListener('heartbeat', () => {
      setConnectionState('live', 'Live');
    });

    state.eventSource.addEventListener('orders', () => {
      refreshAllData('live-update');
    });

    state.eventSource.addEventListener('master-lists', () => {
      refreshAllData('master-lists');
    });

    state.eventSource.onerror = () => {
      setConnectionState('reconnecting', 'Reconnecting…');
    };
  };

  reestablishConnection();

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      refreshAllData('visibility');
    }
  });

  window.addEventListener('online', () => {
    setConnectionState('live', 'Live');
    refreshAllData('online');
  });

  window.addEventListener('offline', () => {
    setConnectionState('offline', 'Offline');
  });
}

function refreshAllData(reason = 'manual') {
  if (reason === 'live-update' || reason === 'master-lists') {
    Promise.all([loadSuppliers(), loadMasterLists(), loadOrders()]);
    return;
  }

  Promise.all([loadSuppliers(), loadMasterLists(), loadOrders()]);
}

function bindEvents() {
  elements.searchInput.addEventListener('input', (event) => {
    state.search = event.target.value.trim();
    loadOrders();
  });

  document.querySelectorAll('.tab-button').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.tab-button').forEach((node) => node.classList.toggle('active', node === button));
      state.status = button.dataset.view;
      loadOrders();
    });
  });

  elements.groupFilter.addEventListener('change', (event) => {
    state.groupView = event.target.value;
    loadOrders();
  });

  elements.categoryFilter.addEventListener('change', (event) => {
    state.category = event.target.value;
    loadOrders();
  });

  elements.supplierFilter.addEventListener('click', (event) => {
    const option = event.target.closest('option');
    if (!option) return;

    const value = option.value;
    const nextValues = new Set(state.supplier);
    if (nextValues.has(value)) {
      nextValues.delete(value);
    } else {
      nextValues.add(value);
    }

    state.supplier = Array.from(nextValues);
    renderSupplierSelection();
    loadOrders();
  });

  elements.clearSupplierButton.addEventListener('click', async () => {
    state.supplier = [];
    renderSupplierSelection();
    await loadOrders();
  });

  elements.orderedByFilter.addEventListener('click', (event) => {
    const option = event.target.closest('option');
    if (!option) return;

    const value = option.value;
    const nextValues = new Set(state.orderedBy);
    if (nextValues.has(value)) {
      nextValues.delete(value);
    } else {
      nextValues.add(value);
    }

    state.orderedBy = Array.from(nextValues);
    renderOrderedBySelection();
    loadOrders();
  });

  elements.clearOrderedByButton.addEventListener('click', async () => {
    state.orderedBy = [];
    renderOrderedBySelection();
    await loadOrders();
  });

  elements.sortSelect.addEventListener('change', (event) => {
    state.sort = event.target.value;
    loadOrders();
  });

  elements.addOrderButton.addEventListener('click', () => openOrderDialog());
  elements.closeDialogButton.addEventListener('click', () => closeDialog());
  elements.cancelOrderButton.addEventListener('click', () => closeDialog());

  elements.masterListsButton.addEventListener('click', async () => {
    elements.masterListsDialog.showModal();
    await loadMasterLists();
  });

  elements.closeMasterListsButton.addEventListener('click', () => {
    elements.masterListsDialog.close();
  });

  elements.adminLoginButton.addEventListener('click', async () => {
    await loginAsAdmin();
  });

  elements.adminLogoutButton.addEventListener('click', async () => {
    await logoutAsAdmin();
  });

  elements.addSupplierEntry.addEventListener('click', () => {
    state.masterSuppliers.push({ id: '', name: '', active: true });
    renderMasterListsEditor();
  });

  elements.addStaffEntry.addEventListener('click', () => {
    state.masterStaffNames.push({ id: '', name: '', active: true });
    renderMasterListsEditor();
  });

  elements.supplierMasterList.addEventListener('input', (event) => {
    const target = event.target;
    if (!target.dataset.kind) return;
    const list = target.dataset.kind === 'supplier' ? state.masterSuppliers : state.masterStaffNames;
    const activeRow = list.find((item) => item.id === target.dataset.id || (!item.id && target.dataset.index === String(list.indexOf(item))));
    if (!activeRow) return;
    if (target.dataset.field === 'name') {
      activeRow.name = target.value;
    }
  });

  elements.supplierMasterList.addEventListener('change', (event) => {
    const target = event.target;
    if (!target.dataset.kind) return;
    const list = target.dataset.kind === 'supplier' ? state.masterSuppliers : state.masterStaffNames;
    const activeRow = list.find((item) => item.id === target.dataset.id || (!item.id && target.dataset.index === String(list.indexOf(item))));
    if (!activeRow) return;
    if (target.dataset.field === 'active') {
      activeRow.active = target.checked;
    }
  });

  elements.orderedByMasterList.addEventListener('input', (event) => {
    const target = event.target;
    if (!target.dataset.kind) return;
    const list = target.dataset.kind === 'staff' ? state.masterStaffNames : state.masterSuppliers;
    const activeRow = list.find((item) => item.id === target.dataset.id || (!item.id && target.dataset.index === String(list.indexOf(item))));
    if (!activeRow) return;
    if (target.dataset.field === 'name') {
      activeRow.name = target.value;
    }
  });

  elements.orderedByMasterList.addEventListener('change', (event) => {
    const target = event.target;
    if (!target.dataset.kind) return;
    const list = target.dataset.kind === 'staff' ? state.masterStaffNames : state.masterSuppliers;
    const activeRow = list.find((item) => item.id === target.dataset.id || (!item.id && target.dataset.index === String(list.indexOf(item))));
    if (!activeRow) return;
    if (target.dataset.field === 'active') {
      activeRow.active = target.checked;
    }
  });

  elements.supplierMasterList.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const kind = button.dataset.kind;
    const list = kind === 'supplier' ? state.masterSuppliers : state.masterStaffNames;
    const index = Number(button.dataset.index ?? -1);
    if (index >= 0) {
      list.splice(index, 1);
      renderMasterListsEditor();
    }
  });

  elements.orderedByMasterList.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;
    const kind = button.dataset.kind;
    const list = kind === 'staff' ? state.masterStaffNames : state.masterSuppliers;
    const index = Number(button.dataset.index ?? -1);
    if (index >= 0) {
      list.splice(index, 1);
      renderMasterListsEditor();
    }
  });

  elements.saveMasterListsButton.addEventListener('click', async () => {
    await saveMasterLists();
  });

  elements.logoutButton.addEventListener('click', async () => {
    await logoutAsAdmin();
  });

  elements.form.addEventListener('submit', async (event) => {
    event.preventDefault();
    await saveOrder();
  });

  elements.tableBody.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    if (!button) return;

    const { action, id } = button.dataset;
    if (action === 'edit') {
      const order = state.orders.find((entry) => entry.id === id);
      if (order) openOrderDialog(order);
      return;
    }

    if (action === 'mark-received') {
      await markReceived(id);
      return;
    }

    if (action === 'reopen') {
      await reopenOrder(id);
      return;
    }
  });
}

async function refreshAdminState() {
  try {
    const response = await fetch('/api/admin/me');
    state.adminLoggedIn = response.ok;
  } catch (error) {
    state.adminLoggedIn = false;
  }

  updateAdminUi();
}

function updateAdminUi() {
  elements.adminLoginSection.classList.toggle('hidden', state.adminLoggedIn);
  elements.masterListsSection.classList.toggle('hidden', !state.adminLoggedIn);
  elements.logoutButton.classList.toggle('hidden', !state.adminLoggedIn);
  elements.currentUser.textContent = state.adminLoggedIn ? 'Administrator' : 'Office staff';
}

async function loginAsAdmin() {
  const username = elements.adminUsernameInput.value.trim();
  const password = elements.adminPasswordInput.value;

  try {
    const response = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Unable to sign in.');
    }

    state.adminLoggedIn = true;
    updateAdminUi();
    await loadMasterLists();
    elements.adminPasswordInput.value = '';
    elements.adminUsernameInput.value = '';
    showStatus('Administrator signed in.', 'success');
  } catch (error) {
    showStatus(error.message, 'error');
  }
}

async function logoutAsAdmin() {
  try {
    await fetch('/api/admin/logout', { method: 'POST' });
  } catch (error) {
    // no-op: keep the UI responsive even if logout fails
  }

  state.adminLoggedIn = false;
  elements.masterListsDialog.close();
  updateAdminUi();
  showStatus('Administrator signed out.', 'success');
}

async function loadSuppliers() {
  const requestId = ++state.supplierRequestCounter;
  const response = await fetch('/api/suppliers');
  if (!response.ok) return;

  const data = await response.json();
  if (requestId !== state.supplierRequestCounter) return;

  state.suppliers = Array.isArray(data.suppliers) ? data.suppliers : [];
  renderSupplierFilterOptions();

  const datalist = document.getElementById('supplierList');
  datalist.innerHTML = state.suppliers
    .map((supplier) => `<option value="${escapeHtml(supplier)}"></option>`)
    .join('');
}

async function loadMasterLists() {
  const requestId = ++state.masterRequestCounter;
  const response = await fetch('/api/master-lists');
  if (!response.ok) return;

  const data = await response.json();
  if (requestId !== state.masterRequestCounter) return;

  state.masterSuppliers = (data.suppliers || []).map((item) => ({
    id: item.id || '',
    name: item.name || '',
    active: item.active !== false
  }));
  state.masterStaffNames = (data.staff_names || []).map((item) => ({
    id: item.id || '',
    name: item.name || '',
    active: item.active !== false
  }));

  const historicalStaff = Array.isArray(data.ordered_by_options) ? data.ordered_by_options : [];
  const uniqueStaff = [...new Set([
    ...state.masterStaffNames.map((item) => item.name),
    ...historicalStaff
  ].filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

  state.staffNames = uniqueStaff;
  state.suppliers = state.masterSuppliers.filter((item) => item.active !== false).map((item) => item.name);
  renderSupplierFilterOptions();
  renderOrderedByOptions();
  renderOrderedByFilterOptions();
  renderMasterListsEditor();
}

function renderSupplierFilterOptions() {
  const selected = new Set(state.supplier);
  const options = state.suppliers.map((supplier) => `<option value="${escapeHtml(supplier)}" ${selected.has(supplier) ? 'selected' : ''}>${escapeHtml(supplier)}</option>`).join('');
  elements.supplierFilter.innerHTML = options;
  renderSupplierSelection();
}

function renderSupplierSelection() {
  const selected = state.supplier.filter(Boolean);
  elements.supplierSelectionSummary.textContent = selected.length ? selected.join(', ') : 'All Suppliers';
  Array.from(elements.supplierFilter.options).forEach((option) => {
    option.selected = selected.includes(option.value);
  });
}

function renderOrderedByOptions() {
  const optionNames = [...new Set([
    ...state.masterStaffNames.filter((item) => item.active !== false && item.name.trim()).map((item) => item.name),
    ...state.staffNames.filter(Boolean)
  ])].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

  elements.orderedBySelect.innerHTML = '<option value="">Select staff name</option>' + optionNames
    .map((person) => `<option value="${escapeHtml(person)}">${escapeHtml(person)}</option>`)
    .join('');

  const selectedValue = elements.orderedBySelect.value;
  if (selectedValue) {
    elements.orderedBySelect.value = selectedValue;
  }
}

function renderOrderedByFilterOptions() {
  const selected = new Set(state.orderedBy);
  const options = state.staffNames.map((person) => `<option value="${escapeHtml(person)}" ${selected.has(person) ? 'selected' : ''}>${escapeHtml(person)}</option>`).join('');
  elements.orderedByFilter.innerHTML = options;
  renderOrderedBySelection();
}

function renderOrderedBySelection() {
  const selected = state.orderedBy.filter(Boolean);
  elements.orderedBySelectionSummary.textContent = selected.length ? selected.join(', ') : 'Everyone';
  Array.from(elements.orderedByFilter.options).forEach((option) => {
    option.selected = selected.includes(option.value);
  });
}

function renderMasterListsEditor() {
  elements.supplierMasterList.innerHTML = (state.masterSuppliers.length ? state.masterSuppliers : [{ id: '', name: '', active: true }])
    .map((item, index) => renderMasterListRow('supplier', item, index))
    .join('');

  elements.orderedByMasterList.innerHTML = (state.masterStaffNames.length ? state.masterStaffNames : [{ id: '', name: '', active: true }])
    .map((item, index) => renderMasterListRow('staff', item, index))
    .join('');
}

function renderMasterListRow(kind, item, index) {
  const active = item.active !== false;
  const kindName = kind === 'supplier' ? 'supplier' : 'staff';
  return `
    <div class="master-list-row ${active ? '' : 'inactive'}" data-kind="${kindName}">
      <input type="text" data-kind="${kindName}" data-field="name" data-index="${index}" data-id="${escapeHtml(item.id || '')}" value="${escapeHtml(item.name || '')}" placeholder="${kind === 'supplier' ? 'Supplier name' : 'Staff name'}" />
      <label class="checkbox-inline">
        <input type="checkbox" data-kind="${kindName}" data-field="active" data-index="${index}" data-id="${escapeHtml(item.id || '')}" ${active ? 'checked' : ''} />
        Active
      </label>
      <button type="button" class="secondary-button small-button" data-kind="${kindName}" data-action="remove" data-index="${index}">Remove</button>
    </div>
  `;
}

async function saveMasterLists() {
  const supplierItems = state.masterSuppliers
    .map((item) => ({ id: item.id || '', name: (item.name || '').trim(), active: item.active !== false }))
    .filter((item) => item.name || item.id);

  const staffItems = state.masterStaffNames
    .map((item) => ({ id: item.id || '', name: (item.name || '').trim(), active: item.active !== false }))
    .filter((item) => item.name || item.id);

  try {
    const [supplierResponse, staffResponse] = await Promise.all([
      fetch('/api/master-lists/suppliers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: supplierItems })
      }),
      fetch('/api/master-lists/ordered-by', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: staffItems })
      })
    ]);

    if (!supplierResponse.ok || !staffResponse.ok) {
      throw new Error('Unable to save one or more lists.');
    }

    await Promise.all([loadSuppliers(), loadMasterLists(), loadOrders()]);
    elements.masterListsDialog.close();
    showStatus('Master lists saved.', 'success');
  } catch (error) {
    showStatus(error.message, 'error');
  }
}

async function loadOrders() {
  const requestId = ++state.orderRequestCounter;
  const params = new URLSearchParams({
    status: state.status,
    view: state.groupView,
    category: state.category,
    sort: state.sort,
    search: state.search
  });

  for (const supplier of state.supplier) {
    params.append('supplier', supplier);
  }

  for (const staff of state.orderedBy) {
    params.append('ordered_by', staff);
  }

  const response = await fetch(`/api/orders?${params.toString()}`);
  if (!response.ok) {
    showStatus('Unable to load orders right now.', 'error');
    return;
  }

  const data = await response.json();
  if (requestId !== state.orderRequestCounter) return;

  state.orders = data.orders || [];
  renderOrders();
}

function renderOrders() {
  if (!state.orders.length) {
    elements.tableBody.innerHTML = '';
    elements.emptyState.classList.remove('hidden');
    return;
  }

  elements.emptyState.classList.add('hidden');
  elements.tableBody.innerHTML = state.orders
    .map((order) => {
      const status = order.status || 'Ordered';
      const eta = order.expected_delivery_date ? formatDate(order.expected_delivery_date) : 'No ETA';
      const received = order.date_received ? formatDate(order.date_received) : '—';
      const rowClass = order.is_overdue ? 'overdue' : '';
      const jobLink = order.housecall_job_link
        ? `<a href="${escapeAttr(order.housecall_job_link)}" target="_blank" rel="noreferrer">Open</a>`
        : '—';
      const notes = escapeHtml(order.notes || '');
      const category = order.category || 'Unassigned';
      const orderedBy = order.ordered_by || '—';
      const actionButtons = status === 'Received'
        ? `<button type="button" class="action-button danger" data-action="reopen" data-id="${order.id}">Reopen</button>`
        : `<button type="button" class="action-button primary" data-action="mark-received" data-id="${order.id}">Mark received</button>`;

      return `
        <tr class="${rowClass}">
          <td>
            <strong>${escapeHtml(order.customer_name)}</strong>
          </td>
          <td>${escapeHtml(category)}</td>
          <td>
            ${order.housecall_job_number ? escapeHtml(order.housecall_job_number) : '—'}<br />
            ${jobLink}
          </td>
          <td>${escapeHtml(order.supplier || '—')}</td>
          <td>${escapeHtml(orderedBy)}</td>
          <td>${escapeHtml(order.po_number || '—')}</td>
          <td>${formatDate(order.date_ordered)}</td>
          <td>${eta}</td>
          <td>${received}</td>
          <td>
            <span class="status-badge ${status === 'Received' ? 'received' : (order.is_overdue ? 'overdue' : 'ordered')}">${order.is_overdue ? 'Overdue' : status}</span>
          </td>
          <td class="notes-cell">${notes || '—'}</td>
          <td>
            <div class="action-stack">
              <button type="button" class="action-button" data-action="edit" data-id="${order.id}">Edit</button>
              ${actionButtons}
            </div>
          </td>
        </tr>
      `;
    })
    .join('');
}

function openOrderDialog(order = null) {
  elements.form.reset();
  elements.formError.textContent = '';
  elements.orderId.value = '';
  elements.orderUpdatedAt.value = '';
  elements.categorySelect.value = '';
  elements.orderedBySelect.value = '';

  const today = new Date().toISOString().slice(0, 10);
  document.getElementById('dateOrdered').value = today;

  if (!order) {
    elements.dialogTitle.textContent = 'Add order';
    elements.dialog.showModal();
    return;
  }

  elements.dialogTitle.textContent = 'Edit order';
  elements.orderId.value = order.id;
  elements.orderUpdatedAt.value = order.updated_at || '';
  document.getElementById('customerName').value = order.customer_name || '';
  elements.categorySelect.value = order.category || '';
  document.getElementById('housecallJobNumber').value = order.housecall_job_number || '';
  document.getElementById('housecallJobLink').value = order.housecall_job_link || '';
  document.getElementById('supplierInput').value = order.supplier || '';
  const orderedByMatch = state.masterStaffNames.find((person) => person.id === order.ordered_by_id || person.name === order.ordered_by);
  const orderedByValue = orderedByMatch ? (orderedByMatch.id || orderedByMatch.name) : (order.ordered_by_id || order.ordered_by || '');
  elements.orderedBySelect.value = orderedByValue;
  document.getElementById('poNumber').value = order.po_number || '';
  document.getElementById('dateOrdered').value = order.date_ordered || today;
  document.getElementById('expectedDeliveryDate').value = order.expected_delivery_date || '';
  document.getElementById('dateReceived').value = order.date_received || '';
  document.getElementById('notes').value = order.notes || '';

  elements.dialog.showModal();
}

function closeDialog() {
  elements.dialog.close();
  elements.formError.textContent = '';
}

function readSelectedOrderedBy() {
  const selectedValue = elements.orderedBySelect.value;
  if (!selectedValue) {
    return { id: '', name: '' };
  }

  const person = state.masterStaffNames.find((entry) => entry.id === selectedValue || entry.name === selectedValue);
  if (person) {
    return {
      id: person.id || '',
      name: person.name || ''
    };
  }

  return {
    id: '',
    name: selectedValue
  };
}

async function saveOrder() {
  const orderedBy = readSelectedOrderedBy();
  const payload = {
    customer_name: document.getElementById('customerName').value,
    category: elements.categorySelect.value,
    housecall_job_number: document.getElementById('housecallJobNumber').value,
    housecall_job_link: document.getElementById('housecallJobLink').value,
    supplier: document.getElementById('supplierInput').value,
    supplier_id: '',
    po_number: document.getElementById('poNumber').value,
    date_ordered: document.getElementById('dateOrdered').value,
    expected_delivery_date: document.getElementById('expectedDeliveryDate').value,
    date_received: document.getElementById('dateReceived').value,
    ordered_by: orderedBy.name,
    ordered_by_id: orderedBy.id,
    notes: document.getElementById('notes').value,
    status: document.getElementById('dateReceived').value ? 'Received' : 'Ordered'
  };

  if (!payload.customer_name.trim()) {
    elements.formError.textContent = 'Customer name is required.';
    return;
  }

  if (!payload.category) {
    elements.formError.textContent = 'Category is required.';
    return;
  }

  if (!payload.ordered_by) {
    elements.formError.textContent = 'Ordered by is required.';
    return;
  }

  if (!payload.supplier.trim()) {
    elements.formError.textContent = 'Supplier is required.';
    return;
  }

  if (!payload.date_ordered) {
    elements.formError.textContent = 'Date ordered is required.';
    return;
  }

  if (payload.supplier) {
    const supplierMatch = state.masterSuppliers.find((supplier) => supplier.name.toLowerCase() === payload.supplier.toLowerCase() && supplier.active !== false);
    payload.supplier_id = supplierMatch ? supplierMatch.id : '';
  }

  const id = elements.orderId.value;
  const requestOptions = {
    method: id ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...payload,
      updated_at: elements.orderUpdatedAt.value
    })
  };

  try {
    const url = id ? `/api/orders/${id}` : '/api/orders';
    const response = await fetch(url, requestOptions);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Unable to save the order.');
    }

    closeDialog();
    showStatus(id ? 'Order updated.' : 'Order created.', 'success');
    await Promise.all([loadSuppliers(), loadMasterLists(), loadOrders()]);
  } catch (error) {
    elements.formError.textContent = error.message;
  }
}

async function markReceived(orderId) {
  try {
    const response = await fetch(`/api/orders/${orderId}/mark-received`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ date_received: new Date().toISOString().slice(0, 10) })
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Unable to mark the order received.');
    }

    showStatus('Order marked as received.', 'success');
    await loadOrders();
  } catch (error) {
    showStatus(error.message, 'error');
  }
}

async function reopenOrder(orderId) {
  try {
    const response = await fetch(`/api/orders/${orderId}/reopen`, { method: 'POST' });
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Unable to reopen this order.');
    }

    showStatus('Order reopened.', 'success');
    await loadOrders();
  } catch (error) {
    showStatus(error.message, 'error');
  }
}

function showStatus(message, type = 'success') {
  elements.statusMessage.textContent = message;
  elements.statusMessage.className = `message-box ${type}`;
}

function formatDate(value) {
  if (!value) return '—';
  const parsed = new Date(`${value}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(parsed);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeAttr(value) {
  return escapeHtml(value);
}
