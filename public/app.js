const state = {
  status: 'Outstanding',
  groupView: 'All Orders',
  category: '',
  supplier: [],
  orderedBy: [],
  search: '',
  sort: 'customer_name',
  orders: [],
  jobDrafts: [],
  suppliers: [],
  staffNames: [],
  masterSuppliers: [],
  masterStaffNames: [],
  supplierFilterOptions: [],
  masterListsDirty: false,
  supplierCleanupPreview: null,
  condensedView: false,
  adminLoggedIn: false,
  connectionState: 'live',
  requestCounter: 0,
  orderRequestCounter: 0,
  orderRequestController: null,
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
  addDraftButton: document.getElementById('addDraftButton'),
  masterListsButton: document.getElementById('masterListsButton'),
  logoutButton: document.getElementById('logoutButton'),
  tableWrap: document.querySelector('.table-wrap'),
  draftQueueSection: document.getElementById('draftQueueSection'),
  tableBody: document.getElementById('ordersTableBody'),
  desktopOrderMenu: document.getElementById('desktopOrderMenu'),
  mobileOrderCards: document.getElementById('mobileOrderCards'),
  condensedViewToggle: document.getElementById('condensedViewToggle'),
  condensedViewHint: document.getElementById('condensedViewHint'),
  condensedOrders: document.getElementById('condensedOrders'),
  condensedOrdersBody: document.getElementById('condensedOrdersBody'),
  condensedOrderCount: document.getElementById('condensedOrderCount'),
  emptyState: document.getElementById('emptyState'),
  statusMessage: document.getElementById('statusMessage'),
  liveStatus: document.getElementById('liveStatus'),
  saveStatus: document.getElementById('saveStatus'),
  dialog: document.getElementById('orderDialog'),
  draftDialog: document.getElementById('draftDialog'),
  draftForm: document.getElementById('draftForm'),
  draftFormError: document.getElementById('draftFormError'),
  draftDialogTitle: document.getElementById('draftDialogTitle'),
  draftId: document.getElementById('draftId'),
  draftCustomerName: document.getElementById('draftCustomerName'),
  draftHousecallJobNumber: document.getElementById('draftHousecallJobNumber'),
  draftHousecallJobLink: document.getElementById('draftHousecallJobLink'),
  draftHcpJobId: document.getElementById('draftHcpJobId'),
  draftDepositStatus: document.getElementById('draftDepositStatus'),
  draftNotes: document.getElementById('draftNotes'),
  jobDraftList: document.getElementById('jobDraftList'),
  draftQueueSummary: document.getElementById('draftQueueSummary'),
  draftActionsMenu: document.getElementById('draftActionsMenu'),
  closeDraftDialogButton: document.getElementById('closeDraftDialogButton'),
  cancelDraftButton: document.getElementById('cancelDraftButton'),
  form: document.getElementById('orderForm'),
  jobDraftId: document.getElementById('jobDraftId'),
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
  adminLogoutButton: document.getElementById('adminLogoutButton'),
  supplierCleanupDialog: document.getElementById('supplierCleanupDialog'),
  supplierCleanupSummary: document.getElementById('supplierCleanupSummary'),
  supplierCleanupList: document.getElementById('supplierCleanupList'),
  supplierCleanupConfirmation: document.getElementById('supplierCleanupConfirmation'),
  supplierCleanupError: document.getElementById('supplierCleanupError'),
  deleteInactiveSuppliersButton: document.getElementById('deleteInactiveSuppliersButton')
};

document.addEventListener('DOMContentLoaded', async () => {
  try { state.condensedView = window.localStorage.getItem('boulevard-condensed-view') === 'true'; } catch {}
  bindEvents();
  setupLiveUpdates();
  elements.sortSelect.value = state.sort;
  renderQueueVisibility();
  updateLayoutMode();
  window.addEventListener('resize', () => {
    elements.desktopOrderMenu.hidePopover?.();
    elements.draftActionsMenu.hidePopover?.();
    updateLayoutMode();
  });

  try {
    await refreshAdminState();
    await Promise.all([loadSuppliers(), loadMasterLists(), loadJobDrafts(), loadOrders()]);
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

function updateLayoutMode() {
  const mobile = window.matchMedia('(max-width: 820px)').matches;
  const draftView = state.status === 'Approved – Need to Order';

  if (elements.tableWrap) {
    elements.tableWrap.classList.toggle('desktop-table', !mobile);
    elements.tableWrap.classList.toggle('mobile-hidden', mobile || draftView || state.condensedView);
    elements.tableWrap.classList.toggle('hidden', draftView || state.condensedView);
  }
  if (elements.mobileOrderCards) {
    elements.mobileOrderCards.classList.toggle('hidden', !mobile || draftView || state.condensedView);
  }

  elements.condensedOrders.classList.toggle('hidden', draftView || !state.condensedView || !state.orders.length);
  elements.condensedViewToggle.setAttribute('aria-pressed', String(state.condensedView));
  elements.condensedViewToggle.disabled = draftView;
  elements.condensedViewHint.classList.toggle('hidden', draftView || !state.condensedView);

  if (elements.draftQueueSection) {
    elements.draftQueueSection.classList.toggle('hidden', !draftView);
  }
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
  if (reason === 'live-update' || reason === 'master-lists' || reason === 'live-sync') {
    Promise.all([loadSuppliers(), loadMasterLists(), loadJobDrafts(), loadOrders()]);
    return;
  }

  Promise.all([loadSuppliers(), loadMasterLists(), loadJobDrafts(), loadOrders()]);
}

function renderQueueVisibility() {
  const draftView = state.status === 'Approved – Need to Order';
  if (elements.draftQueueSection) {
    elements.draftQueueSection.classList.toggle('hidden', !draftView);
  }
  if (elements.tableWrap) {
    elements.tableWrap.classList.toggle('hidden', draftView || state.condensedView);
  }
  if (elements.mobileOrderCards) {
    elements.mobileOrderCards.classList.toggle('hidden', draftView || state.condensedView || !window.matchMedia('(max-width: 820px)').matches);
  }
  updateLayoutMode();
  if (elements.emptyState) {
    elements.emptyState.classList.toggle('hidden', draftView || !!state.orders.length);
  }
}

function bindEvents() {
  elements.condensedViewToggle.addEventListener('click', () => {
    state.condensedView = !state.condensedView;
    try { window.localStorage.setItem('boulevard-condensed-view', String(state.condensedView)); } catch {}
    renderCondensedOrders();
    renderQueueVisibility();
  });
  elements.masterListsDialog.addEventListener('close', () => {
    state.masterListsDirty = false;
    loadMasterLists().catch(() => {});
  });
  document.getElementById('previewSupplierCleanupButton').addEventListener('click', previewSupplierCleanup);
  for (const id of ['closeSupplierCleanupButton', 'cancelSupplierCleanupButton']) document.getElementById(id).addEventListener('click', () => elements.supplierCleanupDialog.close());
  elements.supplierCleanupDialog.addEventListener('close', () => { state.supplierCleanupPreview = null; });
  elements.supplierCleanupConfirmation.addEventListener('input', () => {
    elements.deleteInactiveSuppliersButton.disabled = !(state.supplierCleanupPreview?.supplier_count || state.supplierCleanupPreview?.order_count) || elements.supplierCleanupConfirmation.value !== 'DELETE';
  });
  elements.deleteInactiveSuppliersButton.addEventListener('click', deleteInactiveSuppliers);
  for (const list of [elements.supplierMasterList, elements.orderedByMasterList]) {
    list.addEventListener('input', () => { state.masterListsDirty = true; });
    list.addEventListener('change', () => { state.masterListsDirty = true; });
  }
  for (const button of [elements.addSupplierEntry, elements.addStaffEntry]) button.addEventListener('click', () => { state.masterListsDirty = true; });
  elements.searchInput.addEventListener('input', (event) => {
    state.search = event.target.value.trim();
    loadOrders();
  });

  document.querySelectorAll('.tab-button').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.tab-button').forEach((node) => node.classList.toggle('active', node === button));
      state.status = button.dataset.view;
      showStatus('');
      elements.draftActionsMenu.hidePopover?.();
      renderQueueVisibility();
      if (state.status === 'Approved – Need to Order') {
        loadJobDrafts();
        return;
      }
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

  elements.supplierFilter.addEventListener('change', () => {
    state.supplier = Array.from(elements.supplierFilter.selectedOptions, option => option.value);
    renderSupplierSelection();
    loadOrders();
  });

  elements.clearSupplierButton.addEventListener('click', async () => {
    state.supplier = [];
    renderSupplierSelection();
    await loadOrders();
  });

  elements.orderedByFilter.addEventListener('change', () => {
    state.orderedBy = Array.from(elements.orderedByFilter.selectedOptions, option => option.value);
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
    if (state.status === 'Approved – Need to Order') {
      loadJobDrafts();
      return;
    }
    loadOrders();
  });

  elements.addOrderButton.addEventListener('click', () => openOrderDialog());
  elements.addDraftButton.addEventListener('click', () => openDraftDialog());
  elements.closeDialogButton.addEventListener('click', () => closeDialog());
  elements.cancelOrderButton.addEventListener('click', () => closeDialog());
  elements.closeDraftDialogButton.addEventListener('click', () => closeDraftDialog());
  elements.cancelDraftButton.addEventListener('click', () => closeDraftDialog());

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
      if (list[index]?.id) list[index].active = false;
      else list.splice(index, 1);
      state.masterListsDirty = true;
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
      if (list[index]?.id) list[index].active = false;
      else list.splice(index, 1);
      state.masterListsDirty = true;
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

  const handleOrderAction = async (event) => {
    const button = event.target.closest('button[data-action], button[data-order-menu]');
    if (!button) return;
    if (button.dataset.orderMenu) {
      event.preventDefault();
      openDesktopOrderMenu(button.dataset.orderMenu, button);
      return;
    }
    elements.desktopOrderMenu.hidePopover?.();

    const { action, id } = button.dataset;
    if (action === 'edit') {
      const order = state.orders.find((entry) => entry.id === id);
      if (order) openOrderDialog(order);
      return;
    }

    if (action === 'archive-order') {
      await archiveOrder(id);
      return;
    }

    if (action === 'restore-order') {
      await restoreOrder(id);
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
  };
  elements.tableBody.addEventListener('click', handleOrderAction);
  elements.mobileOrderCards.addEventListener('click', handleOrderAction);
  elements.condensedOrdersBody.addEventListener('click', handleOrderAction);
  elements.desktopOrderMenu.addEventListener('click', handleOrderAction);
  document.addEventListener('scroll', () => {
    elements.desktopOrderMenu.hidePopover?.();
    elements.draftActionsMenu.hidePopover?.();
  }, true);

  elements.draftForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    await saveDraft();
  });

  const handleDraftAction = async (event) => {
    const button = event.target.closest('button[data-action], button[data-draft-menu]');
    if (!button) return;
    if (button.dataset.draftMenu) {
      event.preventDefault();
      openDraftActionsMenu(button.dataset.draftMenu, button);
      return;
    }
    elements.draftActionsMenu.hidePopover?.();

    const { action, id } = button.dataset;
    const draft = state.jobDrafts.find((entry) => entry.id === id);

    if (action === 'edit-draft' && draft) {
      openDraftDialog(draft);
      return;
    }

    if (action === 'archive-draft' && draft) {
      await archiveDraft(id);
      return;
    }

    if (action === 'create-order' && draft) {
      openOrderDialog(null, draft);
      return;
    }

    if (action === 'complete-draft' && draft) {
      await completeDraft(id);
      return;
    }

    if (action === 'reopen-draft' && draft) {
      await reopenDraft(id);
      return;
    }
  };
  elements.jobDraftList.addEventListener('click', handleDraftAction);
  elements.draftActionsMenu.addEventListener('click', handleDraftAction);
}

async function refreshAdminState() {
  try {
    const response = await fetch('/api/admin/me');
    const data = await response.json();
    state.adminLoggedIn = Boolean(response.ok && data && data.admin && data.admin.username === 'admin');
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

}

async function loadMasterLists() {
  const requestId = ++state.masterRequestCounter;
  const response = await fetch('/api/master-lists');
  if (!response.ok) return;

  const data = await response.json();
  if (requestId !== state.masterRequestCounter) return;
  if (state.masterListsDirty && elements.masterListsDialog.open) return;

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

  state.staffNames = state.masterStaffNames.map(item => item.name);
  state.supplierFilterOptions = data.supplier_filter_options || state.masterSuppliers;
  const supplierSelections = state.supplier.length;
  const staffSelections = state.orderedBy.length;
  state.supplier = state.supplier.filter(value => state.supplierFilterOptions.some(item => (item.id || item.name) === value));
  state.orderedBy = state.orderedBy.filter(value => state.masterStaffNames.some(item => (item.id || item.name) === value));
  state.suppliers = state.masterSuppliers.filter((item) => item.active !== false).map((item) => item.name);
  renderSupplierFilterOptions();
  renderSupplierOptions();
  renderOrderedByOptions();
  renderOrderedByFilterOptions();
  renderMasterListsEditor();
  if (supplierSelections !== state.supplier.length || staffSelections !== state.orderedBy.length) await loadOrders();
  const historical = data.historical_suppliers || [];
  document.getElementById('historicalSupplierSection').hidden = historical.length === 0;
  document.getElementById('historicalSupplierList').innerHTML = historical.map(item => `<li>${escapeHtml(item.name)} — ${item.order_count} orders</li>`).join('');
}

function renderSupplierFilterOptions() {
  const selected = new Set(state.supplier);
  const options = [...state.supplierFilterOptions].sort((a, b) => a.name.localeCompare(b.name)).map((supplier) => `<option value="${escapeHtml(supplier.id || supplier.name)}" ${selected.has(supplier.id || supplier.name) ? 'selected' : ''}>${escapeHtml(supplier.name)}${supplier.historical ? ' (historical)' : supplier.active === false ? ' (inactive)' : ''}</option>`).join('');
  elements.supplierFilter.innerHTML = options;
  renderSupplierSelection();
}

function renderSupplierSelection() {
  const selected = state.supplier.filter(Boolean);
  elements.supplierSelectionSummary.textContent = selected.length ? selected.map(value => state.supplierFilterOptions.find(item => (item.id || item.name) === value)?.name || value).join(', ') : 'All Suppliers';
  Array.from(elements.supplierFilter.options).forEach((option) => {
    option.selected = selected.includes(option.value);
  });
}

function renderSupplierOptions() {
  const select = document.getElementById('supplierInput');
  const value = select.value;
  const name = select.selectedOptions[0]?.textContent;
  const suppliers = state.masterSuppliers.filter(item => item.active !== false);
  select.innerHTML = '<option value="">Select supplier</option>' + suppliers
    .map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join('');
  if (value && elements.orderId.value && !suppliers.some(item => item.id === value)) select.add(new Option(name || value, value));
  select.value = value;
}

function renderOrderedByOptions() {
  const selectedValue = elements.orderedBySelect.value;
  const selectedName = elements.orderedBySelect.selectedOptions[0]?.textContent;
  const people = state.masterStaffNames.filter(item => item.active !== false && item.name.trim());
  elements.orderedBySelect.innerHTML = '<option value="">Select staff name</option>' + people
    .map((person) => `<option value="${escapeHtml(person.id || person.name)}">${escapeHtml(person.name)}</option>`)
    .join('');
  if (selectedValue) {
    if (!people.some(item => (item.id || item.name) === selectedValue)) {
      const option = new Option(selectedName || selectedValue, selectedValue);
      elements.orderedBySelect.add(option);
    }
    elements.orderedBySelect.value = selectedValue;
  }
}

function renderOrderedByFilterOptions() {
  const selected = new Set(state.orderedBy);
  const options = state.masterStaffNames.map((person) => `<option value="${escapeHtml(person.id || person.name)}" ${selected.has(person.id || person.name) ? 'selected' : ''}>${escapeHtml(person.name)}${person.active === false ? ' (inactive)' : ''}</option>`).join('');
  elements.orderedByFilter.innerHTML = options;
  renderOrderedBySelection();
}

function renderOrderedBySelection() {
  const selected = state.orderedBy.filter(Boolean);
  elements.orderedBySelectionSummary.textContent = selected.length ? selected.map(value => state.masterStaffNames.find(item => (item.id || item.name) === value)?.name || value).join(', ') : 'Everyone';
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
      <button type="button" class="secondary-button small-button" data-kind="${kindName}" data-action="remove" data-index="${index}" ${item.id && !active ? 'disabled' : ''}>${item.id ? 'Deactivate' : 'Remove'}</button>
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

    state.masterListsDirty = false;
    await Promise.all([loadSuppliers(), loadMasterLists()]);
    await loadOrders();
    elements.masterListsDialog.close();
    showStatus('Master lists saved.', 'success');
  } catch (error) {
    showStatus(error.message, 'error');
  }
}

async function previewSupplierCleanup() {
  if (state.masterListsDirty) {
    window.alert('Save lists before previewing deletion. Only saved inactive suppliers are included.');
    return;
  }
  try {
    const includeHistorical = document.getElementById('includeHistoricalSupplierCleanup').checked;
    const response = await fetch(`/api/admin/inactive-suppliers/preview?include_historical=${includeHistorical}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to preview cleanup.');
    state.supplierCleanupPreview = data;
    elements.supplierCleanupSummary.textContent = `${data.supplier_count} inactive suppliers, ${data.historical_supplier_count} historical supplier names, and ${data.order_count} orders (including archived orders) will be deleted.`;
    elements.supplierCleanupList.innerHTML = [...data.suppliers, ...data.historical_suppliers.map(item => ({ ...item, historical: true }))].map(item => `<li>${escapeHtml(item.name)} — ${item.order_count} orders${item.historical ? ' (historical)' : ''}</li>`).join('');
    elements.supplierCleanupConfirmation.value = '';
    elements.supplierCleanupError.textContent = '';
    elements.deleteInactiveSuppliersButton.disabled = true;
    elements.supplierCleanupDialog.showModal();
  } catch (error) { window.alert(error.message); }
}

async function deleteInactiveSuppliers() {
  if (!state.supplierCleanupPreview || elements.supplierCleanupConfirmation.value !== 'DELETE') return;
  elements.deleteInactiveSuppliersButton.disabled = true;
  try {
    const response = await fetch('/api/admin/inactive-suppliers/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmation_token: state.supplierCleanupPreview.confirmation_token, confirmation: 'DELETE' })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to delete suppliers.');
    elements.supplierCleanupDialog.close();
    elements.masterListsDialog.close();
    state.masterListsDirty = false;
    await Promise.all([loadSuppliers(), loadMasterLists()]);
    await Promise.all([loadOrders(), loadJobDrafts()]);
    showStatus(`Deleted ${data.deleted_suppliers} inactive suppliers and ${data.deleted_orders} linked orders. All drafts were kept.`, 'success');
  } catch (error) {
    // Require a fresh preview after a failed/stale confirmation.
    state.supplierCleanupPreview = null;
    elements.supplierCleanupError.textContent = error.message;
    elements.supplierCleanupError.className = 'message-box error';
  }
}

function sortCustomerRecords(records) {
  return [...records].sort((a, b) => {
    const leftName = String(a.customer_name || '').trim().toLocaleLowerCase();
    const rightName = String(b.customer_name || '').trim().toLocaleLowerCase();
    const nameCompare = leftName.localeCompare(rightName, undefined, { sensitivity: 'base' });

    if (nameCompare !== 0) {
      return nameCompare;
    }

    const leftOrder = String(a.created_at || a.updated_at || '').localeCompare(String(b.created_at || b.updated_at || ''));
    if (leftOrder !== 0) {
      return leftOrder;
    }

    return String(a.id || '').localeCompare(String(b.id || ''));
  });
}

async function loadJobDrafts() {
  try {
    const response = await fetch('/api/job-drafts');
    if (!response.ok) return;

    const data = await response.json();
    const drafts = Array.isArray(data.drafts) ? data.drafts : [];
    state.jobDrafts = state.sort === 'customer_name' ? sortCustomerRecords(drafts) : [...drafts].sort((a, b) => {
      if (state.sort === 'order_date') {
        const left = String(a.created_at || '9999-12-31');
        const right = String(b.created_at || '9999-12-31');
        return left.localeCompare(right) || String(a.id || '').localeCompare(String(b.id || ''));
      }

      const left = String(a.updated_at || a.created_at || '9999-12-31');
      const right = String(b.updated_at || b.created_at || '9999-12-31');
      return left.localeCompare(right) || String(a.id || '').localeCompare(String(b.id || ''));
    });
    renderJobDrafts();
  } catch (error) {
    // no-op: queue can refresh on the next pass
  }
}

async function loadOrders() {
  elements.desktopOrderMenu.hidePopover?.();
  const requestId = ++state.orderRequestCounter;
  state.orderRequestController?.abort();
  state.orderRequestController = null;
  if (state.status === 'Approved – Need to Order') {
    renderQueueVisibility();
    return;
  }

  const controller = new AbortController();
  state.orderRequestController = controller;
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

  if (state.status === 'Archived') {
    params.set('status', 'Archived');
  }

  try {
    const response = await fetch(`/api/orders?${params.toString()}`, { signal: controller.signal });
    if (requestId !== state.orderRequestCounter) return;
    if (!response.ok) throw new Error('Unable to load orders right now.');
    const data = await response.json();
    if (requestId !== state.orderRequestCounter) return;
    state.orders = data.orders || [];
    renderOrders();
  } catch (error) {
    if (error.name !== 'AbortError' && requestId === state.orderRequestCounter) showStatus('Unable to load orders right now.', 'error');
  } finally {
    if (state.orderRequestController === controller) state.orderRequestController = null;
  }
}

function renderJobDrafts() {
  elements.draftActionsMenu.hidePopover?.();
  const readyCount = state.jobDrafts.filter(draft => draft.deposit_status !== 'Awaiting deposit' && draft.status !== 'Completed').length;
  elements.draftQueueSummary.textContent = `${state.jobDrafts.length} ${state.jobDrafts.length === 1 ? 'job' : 'jobs'} · ${readyCount} ready to order`;
  if (!state.jobDrafts.length) {
    elements.jobDraftList.innerHTML = '<div class="empty-state small-empty-state"><h3>No approved jobs waiting to order</h3><p>When a job is approved, add it here and mark the deposit status as soon as it is confirmed.</p></div>';
    return;
  }

  elements.jobDraftList.innerHTML = state.jobDrafts
    .map((draft) => {
      const readyToOrder = draft.deposit_status !== 'Awaiting deposit' && draft.status !== 'Completed';
      const depositClass = draft.deposit_status === 'Awaiting deposit' ? 'awaiting' : 'ready';
      const statusLabel = draft.status === 'Completed' ? 'Completed' : 'Open';
      const notes = String(draft.notes || '').trim();
      const id = escapeAttr(draft.id);

      return `
        <article class="draft-card ${draft.status === 'Completed' ? 'completed' : ''}">
          <div class="draft-card-header">
            <div>
              <h3>${escapeHtml(draft.customer_name)}</h3>
            </div>
            <span class="deposit-status ${depositClass}">${escapeHtml(draft.deposit_status || 'Awaiting deposit')}</span>
          </div>

          <div class="draft-meta-grid">
            <div><span>HCP #</span><strong>${escapeHtml(draft.housecall_job_number || '—')}</strong></div>
            <div><span>Queue status</span><strong>${statusLabel}</strong></div>
            <div><span>Supplier orders</span><strong>${Number(draft.supplier_order_count || 0)}</strong></div>
          </div>

          ${notes ? `<details class="draft-notes"><summary>Notes <span>${escapeHtml(notes.length > 90 ? `${notes.slice(0, 90)}…` : notes)}</span></summary><p>${escapeHtml(notes)}</p></details>` : ''}

          <div class="draft-actions">
            <button type="button" class="action-button" data-action="edit-draft" data-id="${id}">Edit</button>
            <button type="button" class="action-button ${readyToOrder ? 'primary' : ''}" data-action="create-order" data-id="${id}" ${readyToOrder ? '' : 'disabled'}>Create supplier order</button>
            <button type="button" class="action-button" data-draft-menu="${id}" popovertarget="draftActionsMenu" aria-label="More actions for ${escapeAttr(draft.customer_name)}">⋯</button>
          </div>
          ${draft.deposit_status === 'Awaiting deposit' && draft.status !== 'Completed' ? '<p class="draft-order-hint">Receive or waive the deposit before creating supplier orders.</p>' : ''}
        </article>
      `;
    })
    .join('');
}

function renderOrders() {
  const mobile = window.matchMedia('(max-width: 820px)').matches;
  renderCondensedOrders();

  if (!state.orders.length) {
    elements.tableBody.innerHTML = '';
    elements.mobileOrderCards.innerHTML = '';
    elements.emptyState.classList.remove('hidden');
    updateLayoutMode();
    return;
  }

  elements.emptyState.classList.add('hidden');

  const orders = [...state.orders];
  const renderedRows = orders
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
      const archived = Number(order.is_archived || 0) === 1;
      const actionButtons = archived
        ? `<button type="button" class="action-button primary" data-action="restore-order" data-id="${order.id}">Restore</button>`
        : `${status === 'Received'
          ? `<button type="button" class="action-button danger" data-action="reopen" data-id="${order.id}">Reopen</button>`
          : `<button type="button" class="action-button primary" data-action="mark-received" data-id="${order.id}">Mark received</button>`}
          <button type="button" class="action-button danger" data-action="archive-order" data-id="${order.id}">Archive</button>`;

      return {
        row: `
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
              ${renderDesktopOrderActions(order)}
            </td>
          </tr>
        `,
        card: `
          <article class="order-card ${rowClass}">
            <div class="order-card-header">
              <div>
                <p class="order-card-label">Customer</p>
                <h3>${escapeHtml(order.customer_name)}</h3>
              </div>
              <span class="status-badge ${status === 'Received' ? 'received' : (order.is_overdue ? 'overdue' : 'ordered')}">${order.is_overdue ? 'Overdue' : status}</span>
            </div>

            <div class="order-card-grid">
              <div><span>Category</span><strong>${escapeHtml(category)}</strong></div>
              <div><span>Supplier</span><strong>${escapeHtml(order.supplier || '—')}</strong></div>
              <div><span>Expected delivery</span><strong>${eta}</strong></div>
              <div><span>Ordered by</span><strong>${escapeHtml(orderedBy)}</strong></div>
              <div><span>Job #</span><strong>${escapeHtml(order.housecall_job_number || '—')}</strong></div>
              <div><span>PO #</span><strong>${escapeHtml(order.po_number || '—')}</strong></div>
              <div><span>Ordered</span><strong>${formatDate(order.date_ordered)}</strong></div>
              <div><span>Received</span><strong>${received}</strong></div>
            </div>

            <div class="order-card-meta">
              <div><span>Housecall Pro</span>${jobLink}</div>
              <div><span>Notes</span><p>${notes || '—'}</p></div>
            </div>

            <div class="action-stack mobile-actions">
              <button type="button" class="action-button" data-action="edit" data-id="${order.id}">Edit</button>
              ${actionButtons}
            </div>
          </article>
        `
      };
    })
    .map((entry) => entry.row)
    .join('');

  elements.tableBody.innerHTML = renderedRows;
  elements.mobileOrderCards.innerHTML = orders
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
      const archived = Number(order.is_archived || 0) === 1;
      const actionButtons = archived
        ? `<button type="button" class="action-button primary" data-action="restore-order" data-id="${order.id}">Restore</button>`
        : `${status === 'Received'
          ? `<button type="button" class="action-button danger" data-action="reopen" data-id="${order.id}">Reopen</button>`
          : `<button type="button" class="action-button primary" data-action="mark-received" data-id="${order.id}">Mark received</button>`}
          <button type="button" class="action-button danger" data-action="archive-order" data-id="${order.id}">Archive</button>`;

      return `
        <article class="order-card ${rowClass}">
          <div class="order-card-header">
            <div>
              <p class="order-card-label">Customer</p>
              <h3>${escapeHtml(order.customer_name)}</h3>
            </div>
            <span class="status-badge ${status === 'Received' ? 'received' : (order.is_overdue ? 'overdue' : 'ordered')}">${order.is_overdue ? 'Overdue' : status}</span>
          </div>

          <div class="order-card-grid">
            <div><span>Category</span><strong>${escapeHtml(category)}</strong></div>
            <div><span>Supplier</span><strong>${escapeHtml(order.supplier || '—')}</strong></div>
            <div><span>Expected delivery</span><strong>${eta}</strong></div>
            <div><span>Ordered by</span><strong>${escapeHtml(orderedBy)}</strong></div>
            <div><span>Job #</span><strong>${escapeHtml(order.housecall_job_number || '—')}</strong></div>
            <div><span>PO #</span><strong>${escapeHtml(order.po_number || '—')}</strong></div>
            <div><span>Ordered</span><strong>${formatDate(order.date_ordered)}</strong></div>
            <div><span>Received</span><strong>${received}</strong></div>
          </div>

          <div class="order-card-meta">
            <div><span>Housecall Pro</span>${jobLink}</div>
            <div><span>Notes</span><p>${notes || '—'}</p></div>
          </div>

          <div class="action-stack mobile-actions">
            <button type="button" class="action-button" data-action="edit" data-id="${order.id}">Edit</button>
            ${actionButtons}
          </div>
        </article>
      `;
    })
    .join('');

  renderQueueVisibility();
  updateLayoutMode();
  if (mobile && !state.condensedView && state.status !== 'Approved – Need to Order') {
    elements.mobileOrderCards.classList.remove('hidden');
  }
}

function renderCondensedOrders() {
  elements.condensedOrderCount.textContent = `${state.orders.length} matching supplier ${state.orders.length === 1 ? 'order' : 'orders'}`;
  elements.condensedOrdersBody.innerHTML = state.orders.map(order => {
    const status = order.is_overdue ? 'Overdue' : order.status || 'Ordered';
    const notes = order.notes || '—';
    return `<tr class="${order.is_overdue ? 'overdue' : ''}">
      <td class="condensed-customer" title="${escapeAttr(order.customer_name)}"><strong>${escapeHtml(order.customer_name)}</strong></td>
      <td>${escapeHtml(order.housecall_job_number || '—')}</td>
      <td>${escapeHtml(order.category || 'Unassigned')}</td>
      <td class="condensed-supplier" title="${escapeAttr(order.supplier || '')}">${escapeHtml(order.supplier || '—')}</td>
      <td>${order.expected_delivery_date ? formatDate(order.expected_delivery_date) : 'No ETA'}</td>
      <td>${order.date_received ? formatDate(order.date_received) : '—'}</td>
      <td><span class="status-badge ${order.is_overdue ? 'overdue' : status === 'Received' ? 'received' : 'ordered'}">${escapeHtml(status)}</span></td>
      <td class="condensed-notes" title="${escapeAttr(notes)}">${escapeHtml(notes)}</td>
      <td><button type="button" class="action-button" data-action="edit" data-id="${escapeAttr(order.id)}" aria-label="Edit order for ${escapeAttr(order.customer_name)}">Edit</button></td>
    </tr>`;
  }).join('');
}

function renderDesktopOrderActions(order) {
  const id = escapeAttr(order.id);
  const archived = Number(order.is_archived || 0) === 1;
  const primary = archived
    ? `<button type="button" class="action-button primary" data-action="restore-order" data-id="${id}">Restore</button>`
    : (order.status || 'Ordered') === 'Received' ? ''
    : `<button type="button" class="action-button primary" data-action="mark-received" data-id="${id}">Mark received</button>`;
  return `<div class="desktop-order-actions">
    <button type="button" class="action-button" data-action="edit" data-id="${id}">Edit</button>
    ${primary}
    ${archived ? '' : `<button type="button" class="action-button" data-order-menu="${id}" popovertarget="desktopOrderMenu" aria-label="More actions for ${escapeAttr(order.customer_name)}">⋯</button>`}
  </div>`;
}

function openDesktopOrderMenu(orderId, trigger) {
  const order = state.orders.find(item => item.id === orderId);
  if (!order || Number(order.is_archived || 0) === 1) return;
  if (elements.desktopOrderMenu.matches(':popover-open') && elements.desktopOrderMenu.dataset.orderId === orderId) {
    elements.desktopOrderMenu.hidePopover();
    return;
  }
  elements.desktopOrderMenu.dataset.orderId = orderId;
  const id = escapeAttr(order.id);
  elements.desktopOrderMenu.innerHTML = `${(order.status || 'Ordered') === 'Received'
    ? `<button type="button" class="action-button danger" data-action="reopen" data-id="${id}" autofocus>Reopen</button>` : ''}
    <button type="button" class="action-button danger" data-action="archive-order" data-id="${id}" ${(order.status || 'Ordered') === 'Received' ? '' : 'autofocus'}>Archive</button>`;
  elements.desktopOrderMenu.setAttribute('aria-label', `More actions for ${order.customer_name}`);
  elements.desktopOrderMenu.showPopover();
  positionActionMenu(elements.desktopOrderMenu, trigger);
}

function openDraftActionsMenu(draftId, trigger) {
  const draft = state.jobDrafts.find(item => item.id === draftId);
  if (!draft) return;
  const menu = elements.draftActionsMenu;
  if (menu.matches(':popover-open') && menu.dataset.draftId === draftId) {
    menu.hidePopover();
    return;
  }
  menu.dataset.draftId = draftId;
  const id = escapeAttr(draftId);
  menu.innerHTML = `<button type="button" class="action-button" data-action="${draft.status === 'Completed' ? 'reopen-draft' : 'complete-draft'}" data-id="${id}" autofocus>${draft.status === 'Completed' ? 'Reopen job' : 'All materials ordered'}</button>
    <button type="button" class="action-button danger" data-action="archive-draft" data-id="${id}">Archive job</button>`;
  menu.setAttribute('aria-label', `More actions for ${draft.customer_name}`);
  menu.showPopover();
  positionActionMenu(menu, trigger);
}

function positionActionMenu(menu, trigger) {
  const rect = trigger.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(rect.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8))}px`;
  const top = rect.bottom + 6;
  menu.style.top = `${Math.max(8, top + menu.offsetHeight > window.innerHeight - 8 ? rect.top - menu.offsetHeight - 6 : top)}px`;
}

async function archiveDraft(draftId) {
  const draft = state.jobDrafts.find((entry) => entry.id === draftId);
  if (!draft) return;

  const linkedOrders = state.orders.filter((order) => order.job_draft_id === draftId);
  const hasOutstanding = linkedOrders.some((order) => (order.status || 'Ordered') !== 'Received');
  if (hasOutstanding) {
    showStatus('This job can only be archived after all linked supplier orders have been received.', 'error');
    return;
  }

  const summary = linkedOrders.length
    ? linkedOrders.map((order) => `${order.supplier || 'Supplier'}${order.po_number ? ` (${order.po_number})` : ''}`).join(', ')
    : 'No linked supplier orders have been created yet.';

  if (!window.confirm(`Archive this job and the linked supplier orders below?\n\n${summary}`)) {
    return;
  }

  try {
    const response = await fetch(`/api/job-drafts/${draftId}/archive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true, source: 'manual', reason: 'Manual archive from tracker' })
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.warning || data.error || 'Unable to archive the job.');
    }
    showStatus('Job archived.', 'success');
    await loadJobDrafts();
    await loadOrders();
  } catch (error) {
    showStatus(error.message, 'error');
  }
}

async function archiveOrder(orderId) {
  const order = state.orders.find((entry) => entry.id === orderId);
  if (!order) return;

  if ((order.status || 'Ordered') !== 'Received') {
    showStatus('Only received orders can be archived.', 'error');
    return;
  }

  const confirmText = `Archive this order for ${order.customer_name} from ${order.supplier || 'supplier'}?`;
  if (!window.confirm(confirmText)) {
    return;
  }

  try {
    const response = await fetch('/api/orders/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        order_ids: [orderId],
        source: 'manual',
        reason: 'Manual archive from tracker'
      })
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Unable to archive the order.');
    }
    showStatus('Order archived.', 'success');
    await loadOrders();
  } catch (error) {
    showStatus(error.message, 'error');
  }
}

async function restoreOrder(orderId) {
  try {
    const response = await fetch(`/api/orders/${orderId}/restore`, { method: 'POST' });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Unable to restore the order.');
    }
    showStatus('Order restored.', 'success');
    await loadOrders();
  } catch (error) {
    showStatus(error.message, 'error');
  }
}

function openOrderDialog(order = null, draft = null) {
  elements.form.reset();
  elements.formError.textContent = '';
  elements.orderId.value = '';
  elements.orderUpdatedAt.value = '';
  elements.jobDraftId.value = '';
  elements.categorySelect.value = '';
  elements.orderedBySelect.value = '';
  document.getElementById('supplierInput').value = '';
  renderSupplierOptions();

  const today = new Date().toISOString().slice(0, 10);
  document.getElementById('dateOrdered').value = today;

  if (draft) {
    elements.jobDraftId.value = draft.id || '';
    document.getElementById('customerName').value = draft.customer_name || '';
    document.getElementById('housecallJobNumber').value = draft.housecall_job_number || '';
    document.getElementById('housecallJobLink').value = draft.housecall_job_link || '';
    elements.dialogTitle.textContent = 'Create supplier order from draft';
    elements.dialog.showModal();
    return;
  }

  if (!order) {
    elements.dialogTitle.textContent = 'Add order';
    elements.dialog.showModal();
    return;
  }

  elements.dialogTitle.textContent = 'Edit order';
  elements.orderId.value = order.id;
  elements.orderUpdatedAt.value = order.updated_at || '';
  elements.jobDraftId.value = order.job_draft_id || '';
  document.getElementById('customerName').value = order.customer_name || '';
  elements.categorySelect.value = order.category || '';
  document.getElementById('housecallJobNumber').value = order.housecall_job_number || '';
  document.getElementById('housecallJobLink').value = order.housecall_job_link || '';
  const supplierSelect = document.getElementById('supplierInput');
  const supplierValue = order.supplier_id || order.supplier || '';
  if (supplierValue && !Array.from(supplierSelect.options).some(option => option.value === supplierValue)) supplierSelect.add(new Option(order.supplier, supplierValue));
  supplierSelect.value = supplierValue;
  const orderedByMatch = state.masterStaffNames.find((person) => person.id === order.ordered_by_id || person.name === order.ordered_by);
  const orderedByValue = orderedByMatch ? (orderedByMatch.id || orderedByMatch.name) : (order.ordered_by_id || order.ordered_by || '');
  if (orderedByValue && !Array.from(elements.orderedBySelect.options).some(option => option.value === orderedByValue)) elements.orderedBySelect.add(new Option(order.ordered_by, orderedByValue));
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

function openDraftDialog(draft = null) {
  elements.draftForm.reset();
  elements.draftFormError.textContent = '';
  elements.draftId.value = '';
  elements.draftDepositStatus.value = 'Awaiting deposit';

  if (!draft) {
    elements.draftDialogTitle.textContent = 'Add draft';
    elements.draftDialog.showModal();
    return;
  }

  elements.draftDialogTitle.textContent = 'Edit draft';
  elements.draftId.value = draft.id || '';
  elements.draftCustomerName.value = draft.customer_name || '';
  elements.draftHousecallJobNumber.value = draft.housecall_job_number || '';
  elements.draftHousecallJobLink.value = draft.housecall_job_link || '';
  elements.draftHcpJobId.value = draft.hcp_job_id || '';
  elements.draftDepositStatus.value = draft.deposit_status || 'Awaiting deposit';
  elements.draftNotes.value = draft.notes || '';
  elements.draftDialog.showModal();
}

function closeDraftDialog() {
  elements.draftDialog.close();
  elements.draftFormError.textContent = '';
}

async function saveDraft() {
  const payload = {
    customer_name: elements.draftCustomerName.value,
    housecall_job_number: elements.draftHousecallJobNumber.value,
    housecall_job_link: elements.draftHousecallJobLink.value,
    hcp_job_id: elements.draftHcpJobId.value,
    deposit_status: elements.draftDepositStatus.value,
    notes: elements.draftNotes.value
  };

  if (!payload.customer_name.trim()) {
    elements.draftFormError.textContent = 'Customer name is required.';
    return;
  }

  const id = elements.draftId.value;
  const response = await fetch(id ? `/api/job-drafts/${id}` : '/api/job-drafts', {
    method: id ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const data = await response.json();
  if (!response.ok) {
    elements.draftFormError.textContent = data.error || 'Unable to save the draft.';
    return;
  }

  closeDraftDialog();
  showStatus(id ? 'Draft updated.' : 'Draft saved.', 'success');
  await loadJobDrafts();
}

async function completeDraft(draftId) {
  try {
    const response = await fetch(`/api/job-drafts/${draftId}/complete`, { method: 'POST' });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Unable to complete the draft.');
    }
    showStatus('Draft marked as complete.', 'success');
    await loadJobDrafts();
  } catch (error) {
    showStatus(error.message, 'error');
  }
}

async function reopenDraft(draftId) {
  try {
    const response = await fetch(`/api/job-drafts/${draftId}/reopen`, { method: 'POST' });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Unable to reopen the draft.');
    }
    showStatus('Draft reopened.', 'success');
    await loadJobDrafts();
  } catch (error) {
    showStatus(error.message, 'error');
  }
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
  const supplierSelect = document.getElementById('supplierInput');
  const supplier = state.masterSuppliers.find(item => item.id === supplierSelect.value);
  const payload = {
    customer_name: document.getElementById('customerName').value,
    category: elements.categorySelect.value,
    housecall_job_number: document.getElementById('housecallJobNumber').value,
    housecall_job_link: document.getElementById('housecallJobLink').value,
    supplier: supplierSelect.value ? (supplier?.name || supplierSelect.selectedOptions[0]?.textContent || '') : '',
    supplier_id: supplier?.id || '',
    po_number: document.getElementById('poNumber').value,
    date_ordered: document.getElementById('dateOrdered').value,
    expected_delivery_date: document.getElementById('expectedDeliveryDate').value,
    date_received: document.getElementById('dateReceived').value,
    ordered_by: orderedBy.name,
    ordered_by_id: orderedBy.id,
    notes: document.getElementById('notes').value,
    job_draft_id: elements.jobDraftId.value || '',
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
