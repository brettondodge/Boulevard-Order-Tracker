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
  editingOrder: null,
  editingDraft: null,
  editingProgress: null,
  progressFromHcp: false,
  showFinishedJobs: false,
  sheetImport: null,
  undo: null,
  undoTimer: null,
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
  toolbar: document.getElementById('toolbar'),
  filtersToggle: document.getElementById('filtersToggle'),
  clearFiltersButton: document.getElementById('clearFiltersButton'),
  undoToast: document.getElementById('undoToast'),
  undoMessage: document.getElementById('undoMessage'),
  undoButton: document.getElementById('undoButton'),
  dismissUndoButton: document.getElementById('dismissUndoButton'),
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
  orderNotesDialog: document.getElementById('orderNotesDialog'),
  orderNotesCustomer: document.getElementById('orderNotesCustomer'),
  orderNotesText: document.getElementById('orderNotesText'),
  mobileOrderCards: document.getElementById('mobileOrderCards'),
  condensedViewToggle: document.getElementById('condensedViewToggle'),
  condensedViewHint: document.getElementById('condensedViewHint'),
  condensedOrders: document.getElementById('condensedOrders'),
  condensedOrdersBody: document.getElementById('condensedOrdersBody'),
  condensedOrderCount: document.getElementById('condensedOrderCount'),
  emptyState: document.getElementById('emptyState'),
  statusMessage: document.getElementById('statusMessage'),
  liveStatus: document.getElementById('liveStatus'),
  dialog: document.getElementById('orderDialog'),
  draftDialog: document.getElementById('draftDialog'),
  draftForm: document.getElementById('draftForm'),
  draftFormError: document.getElementById('draftFormError'),
  draftDialogTitle: document.getElementById('draftDialogTitle'),
  draftId: document.getElementById('draftId'),
  draftUpdatedAt: document.getElementById('draftUpdatedAt'),
  showFinishedJobsButton: document.getElementById('showFinishedJobsButton'),
  shopLocations: document.getElementById('shopLocations'),
  progressDialog: document.getElementById('progressDialog'),
  progressForm: document.getElementById('progressForm'),
  progressCustomer: document.getElementById('progressCustomer'),
  progressShopLocation: document.getElementById('progressShopLocation'),
  progressScheduled: document.getElementById('progressScheduled'),
  progressScheduledDate: document.getElementById('progressScheduledDate'),
  progressScheduleNote: document.getElementById('progressScheduleNote'),
  progressCompleted: document.getElementById('progressCompleted'),
  progressCompletedDate: document.getElementById('progressCompletedDate'),
  progressInvoiced: document.getElementById('progressInvoiced'),
  progressInvoiceReference: document.getElementById('progressInvoiceReference'),
  progressJobHint: document.getElementById('progressJobHint'),
  progressError: document.getElementById('progressError'),
  sheetImportDialog: document.getElementById('sheetImportDialog'),
  sheetImportFile: document.getElementById('sheetImportFile'),
  sheetImportError: document.getElementById('sheetImportError'),
  sheetImportPreview: document.getElementById('sheetImportPreview'),
  sheetImportSummary: document.getElementById('sheetImportSummary'),
  sheetImportWord: document.getElementById('sheetImportWord'),
  sheetImportConfirmation: document.getElementById('sheetImportConfirmation'),
  previewSheetImportButton: document.getElementById('previewSheetImportButton'),
  hcpStatusText: document.getElementById('hcpStatusText'),
  hcpWebhookUrl: document.getElementById('hcpWebhookUrl'),
  hcpRecentEvents: document.getElementById('hcpRecentEvents'),
  hcpSyncButton: document.getElementById('hcpSyncButton'),
  applySheetImportButton: document.getElementById('applySheetImportButton'),
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

  loadCurrentUser();
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

function isPhoneLayout() {
  return window.matchMedia('(max-width: 820px)').matches;
}

// Phones always use the cards; Condensed lines is a computer option.
function condensedActive() {
  return state.condensedView && !isPhoneLayout();
}

function updateLayoutMode() {
  const mobile = isPhoneLayout();
  const draftView = state.status === 'Approved – Need to Order';
  const condensed = condensedActive();

  if (elements.tableWrap) {
    elements.tableWrap.classList.toggle('desktop-table', !mobile);
    elements.tableWrap.classList.toggle('mobile-hidden', mobile || draftView || condensed);
    elements.tableWrap.classList.toggle('hidden', draftView || condensed);
  }
  if (elements.mobileOrderCards) {
    elements.mobileOrderCards.classList.toggle('hidden', !mobile || draftView);
  }

  elements.condensedOrders.classList.toggle('hidden', draftView || !condensed || !state.orders.length);
  elements.condensedViewToggle.setAttribute('aria-pressed', String(state.condensedView));
  elements.condensedViewToggle.disabled = draftView;
  elements.condensedViewHint.classList.toggle('hidden', draftView || !condensed);

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

    state.eventSource.addEventListener('job-drafts', () => {
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

function refreshAllData() {
  Promise.all([loadSuppliers(), loadMasterLists(), loadJobDrafts(), loadOrders()]);
}

function renderQueueVisibility() {
  updateLayoutMode();
  if (elements.emptyState) {
    elements.emptyState.classList.toggle('hidden', state.status === 'Approved – Need to Order' || !!state.orders.length);
  }
}

function bindEvents() {
  for (const id of ['closeOrderNotesButton', 'dismissOrderNotesButton']) document.getElementById(id).addEventListener('click', () => elements.orderNotesDialog.close());
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

  elements.filtersToggle.addEventListener('click', () => {
    const open = !elements.toolbar.classList.contains('filters-open');
    elements.toolbar.classList.toggle('filters-open', open);
    elements.filtersToggle.setAttribute('aria-expanded', String(open));
  });

  // Supplier and Ordered by are checkbox lists inside <details>; close them when clicking elsewhere.
  document.addEventListener('click', (event) => {
    document.querySelectorAll('details.multi-filter[open]').forEach((menu) => {
      if (!menu.contains(event.target)) menu.removeAttribute('open');
    });
  });

  elements.clearFiltersButton.addEventListener('click', () => {
    state.groupView = 'All Orders';
    state.category = '';
    state.supplier = [];
    state.orderedBy = [];
    elements.groupFilter.value = state.groupView;
    elements.categoryFilter.value = state.category;
    renderSupplierSelection();
    renderOrderedBySelection();
    loadOrders();
  });

  elements.undoButton.addEventListener('click', runUndo);

  elements.progressForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    await saveProgressDialog();
  });
  for (const id of ['closeProgressButton', 'cancelProgressButton']) document.getElementById(id).addEventListener('click', () => elements.progressDialog.close());
  for (const box of [elements.progressScheduled, elements.progressCompleted]) box.addEventListener('change', syncProgressInputs);

  elements.showFinishedJobsButton.addEventListener('click', () => {
    state.showFinishedJobs = !state.showFinishedJobs;
    renderJobDrafts();
  });

  document.getElementById('openSheetImportButton').addEventListener('click', openSheetImport);
  for (const id of ['closeSheetImportButton', 'cancelSheetImportButton']) document.getElementById(id).addEventListener('click', () => elements.sheetImportDialog.close());
  elements.previewSheetImportButton.addEventListener('click', previewSheetImport);
  elements.sheetImportFile.addEventListener('change', resetSheetImportPreview);
  elements.sheetImportDialog.addEventListener('change', (event) => {
    if (event.target.name === 'sheetImportMode') syncSheetImportConfirmation();
  });
  elements.sheetImportConfirmation.addEventListener('input', syncSheetImportConfirmation);
  elements.applySheetImportButton.addEventListener('click', applySheetImport);
  elements.dismissUndoButton.addEventListener('click', hideUndo);

  elements.groupFilter.addEventListener('change', (event) => {
    state.groupView = event.target.value;
    renderFilterCount();
    loadOrders();
  });

  elements.categoryFilter.addEventListener('change', (event) => {
    state.category = event.target.value;
    renderFilterCount();
    loadOrders();
  });

  elements.supplierFilter.addEventListener('change', () => {
    state.supplier = checkedValues(elements.supplierFilter);
    renderSupplierSelection();
    loadOrders();
  });

  elements.clearSupplierButton.addEventListener('click', async () => {
    state.supplier = [];
    renderSupplierSelection();
    await loadOrders();
  });

  elements.orderedByFilter.addEventListener('change', () => {
    state.orderedBy = checkedValues(elements.orderedByFilter);
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
    if (state.adminLoggedIn) await loadHcpStatus();
  });
  elements.hcpSyncButton.addEventListener('click', syncHousecallPro);

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
    if (action === 'view-notes') {
      const order = state.orders.find(entry => entry.id === id);
      if (order) openOrderNotes(order);
      return;
    }
    if (action === 'edit') {
      const order = state.orders.find((entry) => entry.id === id);
      if (order) openOrderDialog(order);
      return;
    }

    if (action === 'delete-order') {
      await deleteOrder(id);
      return;
    }

    const order = state.orders.find((entry) => entry.id === id);
    if (!order) return;
    if (action === 'schedule' || action === 'progress') {
      openProgressDialog(order, action === 'schedule' ? 'schedule' : '');
      return;
    }

    if (action === 'mark-complete') {
      await markJobComplete(order);
      return;
    }

    if (action === 'mark-invoiced') {
      await markJobInvoiced(order);
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

    if (action === 'delete-draft' && draft) {
      await deleteDraft(id);
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
}

// The signed-in staff email, shown in the top-right corner like Freeport Billing.
async function loadCurrentUser() {
  try {
    const response = await fetch('/api/me');
    if (!response.ok) return;
    const data = await response.json();
    elements.currentUser.textContent = data.user?.username || '';
  } catch {
    // The tracker still works without the name.
  }
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
    await loadHcpStatus();
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

function supplierFilterChoices() {
  return [...state.supplierFilterOptions]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(supplier => ({ value: supplier.id || supplier.name, label: supplier.name, note: supplier.historical ? 'historical' : supplier.active === false ? 'inactive' : '' }));
}

function staffFilterChoices() {
  return state.masterStaffNames.map(person => ({ value: person.id || person.name, label: person.name, note: person.active === false ? 'inactive' : '' }));
}

function renderCheckboxOptions(container, choices, selected) {
  container.innerHTML = choices.map(choice => `<label class="checkbox-option"><input type="checkbox" value="${escapeAttr(choice.value)}" ${selected.includes(choice.value) ? 'checked' : ''} /><span>${escapeHtml(choice.label)}${choice.note ? ` <small>(${choice.note})</small>` : ''}</span></label>`).join('')
    || '<p class="multi-filter-empty">None yet</p>';
}

function checkedValues(container) {
  return Array.from(container.querySelectorAll('input:checked'), input => input.value);
}

function selectionSummary(selected, choices, allLabel) {
  if (!selected.length) return allLabel;
  if (selected.length > 2) return `${selected.length} selected`;
  return selected.map(value => choices.find(choice => choice.value === value)?.label || value).join(', ');
}

function renderFilterCount() {
  const count = [state.groupView !== 'All Orders', Boolean(state.category), state.supplier.length > 0, state.orderedBy.length > 0].filter(Boolean).length;
  elements.filtersToggle.textContent = count ? `Filters (${count})` : 'Filters';
  elements.clearFiltersButton.classList.toggle('hidden', !count);
}

function renderSupplierFilterOptions() {
  renderCheckboxOptions(elements.supplierFilter, supplierFilterChoices(), state.supplier);
  renderSupplierSelection();
}

function renderSupplierSelection() {
  elements.supplierSelectionSummary.textContent = selectionSummary(state.supplier, supplierFilterChoices(), 'All');
  elements.supplierFilter.querySelectorAll('input').forEach((input) => {
    input.checked = state.supplier.includes(input.value);
  });
  renderFilterCount();
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
  renderCheckboxOptions(elements.orderedByFilter, staffFilterChoices(), state.orderedBy);
  renderOrderedBySelection();
}

function renderOrderedBySelection() {
  elements.orderedBySelectionSummary.textContent = selectionSummary(state.orderedBy, staffFilterChoices(), 'Everyone');
  elements.orderedByFilter.querySelectorAll('input').forEach((input) => {
    input.checked = state.orderedBy.includes(input.value);
  });
  renderFilterCount();
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
  // Jobs with all materials ordered move on to the order views; they stay
  // reachable behind the "Show" button.
  const openJobs = state.jobDrafts.filter(draft => draft.status !== 'Completed');
  const finishedCount = state.jobDrafts.length - openJobs.length;
  const visible = state.showFinishedJobs ? state.jobDrafts : openJobs;
  const readyCount = openJobs.filter(draft => draft.deposit_status !== 'Awaiting deposit').length;
  elements.draftQueueSummary.textContent = `${openJobs.length} ${openJobs.length === 1 ? 'job' : 'jobs'} · ${readyCount} ready to order`;
  elements.showFinishedJobsButton.classList.toggle('hidden', !finishedCount);
  elements.showFinishedJobsButton.setAttribute('aria-pressed', String(state.showFinishedJobs));
  elements.showFinishedJobsButton.textContent = state.showFinishedJobs ? 'Hide jobs with all materials ordered' : `Show ${finishedCount} with all materials ordered`;
  if (!visible.length) {
    elements.jobDraftList.innerHTML = '<div class="empty-state small-empty-state"><h3>No approved jobs waiting to order</h3><p>When a job is approved, add it here and mark the deposit status as soon as it is confirmed.</p></div>';
    return;
  }

  elements.jobDraftList.innerHTML = visible
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
            <button type="button" class="action-button ${readyToOrder ? 'primary' : ''}" data-action="create-order" data-id="${id}" ${readyToOrder ? '' : 'disabled'}>Order materials</button>
            <button type="button" class="action-button" data-draft-menu="${id}" popovertarget="draftActionsMenu" aria-label="More actions for ${escapeAttr(draft.customer_name)}">⋯</button>
          </div>
          ${draft.deposit_status === 'Awaiting deposit' && draft.status !== 'Completed' ? '<p class="draft-order-hint">Receive or waive the deposit before ordering materials.</p>' : ''}
        </article>
      `;
    })
    .join('');
}

function renderOrders() {
  renderCondensedOrders();
  elements.tableBody.innerHTML = state.orders.map(renderOrderRow).join('');
  elements.mobileOrderCards.innerHTML = state.orders.map(renderOrderCard).join('');
  const locations = [...new Set(state.orders.map(order => String(order.shop_location || '').trim()).filter(Boolean))].sort();
  elements.shopLocations.innerHTML = locations.map(location => `<option value="${escapeAttr(location)}"></option>`).join('');
  renderQueueVisibility();
}

const STAGE_LABELS = { ordered: 'Ordered', overdue: 'Overdue', received: 'Received', scheduled: 'Scheduled', complete: 'Complete', invoiced: 'Invoiced' };

function stageOf(order) {
  if (STAGE_LABELS[order.stage]) return order.stage;
  if (order.is_overdue) return 'overdue';
  return (order.status || 'Ordered') === 'Received' ? 'received' : 'ordered';
}

// Badge for the furthest step reached, plus a warning when a job is on the
// schedule before this order's material has arrived.
function orderStatusBadge(order) {
  const stage = stageOf(order);
  let label = STAGE_LABELS[stage];
  if (stage === 'received') label = 'Ready to schedule';
  if (stage === 'scheduled' && order.scheduled_date) label = `Scheduled ${formatDate(order.scheduled_date)}`;
  const warning = Number(order.job_scheduled) && !Number(order.job_completed) && !order.date_received
    ? `<span class="stage-warning">Scheduled${order.scheduled_date ? ` ${formatDate(order.scheduled_date)}` : ''}, not here yet</span>`
    : '';
  return `<span class="status-badge ${stage}">${escapeHtml(label)}</span>${warning}${hcpStatusLine(order)}`;
}

const HCP_LABELS = { unscheduled: 'Needs scheduling', scheduled: 'Scheduled', in_progress: 'In progress', completed: 'Complete', canceled: 'Canceled' };

// What Housecall Pro says about the job, under the tracker's own step.
function hcpStatusLine(order) {
  const hcp = order.hcp;
  if (!hcp) return '';
  const parts = [HCP_LABELS[hcp.status] || 'Linked'];
  if (hcp.status === 'scheduled' && hcp.scheduled_date) parts[0] = `Scheduled ${formatDate(hcp.scheduled_date)}`;
  if (hcp.assigned && ['scheduled', 'in_progress'].includes(hcp.status)) parts.push(hcp.assigned);
  if (hcp.paid) parts.push('Paid');
  else if (hcp.invoice_sent) parts.push('Invoice sent');
  return `<span class="hcp-status ${hcp.status === 'canceled' ? 'canceled' : ''}">HCP: ${escapeHtml(parts.join(' · '))}</span>`;
}

function nextStep(order) {
  if (Number(order.job_completed)) return Number(order.invoiced) ? null : { action: 'mark-invoiced', label: 'Mark invoiced' };
  if (!order.date_received) return { action: 'mark-received', label: 'Mark received' };
  // Linked jobs are scheduled and finished in Housecall Pro, which updates the tracker.
  if (order.hcp && order.hcp.status !== 'canceled') {
    return Number(order.job_scheduled)
      ? { link: order.hcp.url, label: 'Open in HCP' }
      : { link: order.hcp.url, label: 'Schedule in HCP', primary: true };
  }
  if (Number(order.job_scheduled)) return { action: 'mark-complete', label: 'Mark complete' };
  return { action: 'schedule', label: 'Mark scheduled' };
}

function nextStepButton(order) {
  const step = nextStep(order);
  if (!step) return '';
  if (step.link) return `<a class="action-button ${step.primary ? 'primary' : ''}" href="${escapeAttr(step.link)}" target="_blank" rel="noreferrer">${step.label}</a>`;
  return `<button type="button" class="action-button primary" data-action="${step.action}" data-id="${escapeAttr(order.id)}">${step.label}</button>`;
}

// The job number links to Housecall Pro when the order has a job link.
function jobNumberHtml(order) {
  const number = escapeHtml(order.housecall_job_number || '');
  const link = String(order.housecall_job_link || order.hcp?.url || '');
  if (!/^https?:\/\//i.test(link)) return number || '—';
  return `<a href="${escapeAttr(link)}" target="_blank" rel="noreferrer" title="Open in Housecall Pro">${number || 'Open'}</a>`;
}

function renderOrderRow(order) {
  return `
    <tr class="${order.is_overdue ? 'overdue' : ''}">
      <td><strong>${escapeHtml(order.customer_name)}</strong></td>
      <td>${escapeHtml(order.category || 'Unassigned')}</td>
      <td class="nowrap">${jobNumberHtml(order)}</td>
      <td>${escapeHtml(order.supplier || '—')}</td>
      <td>${escapeHtml(order.ordered_by || '—')}</td>
      <td class="nowrap">${escapeHtml(order.po_number || '—')}</td>
      <td class="nowrap">${formatDate(order.date_ordered)}</td>
      <td class="nowrap">${order.expected_delivery_date ? formatDate(order.expected_delivery_date) : 'No ETA'}</td>
      <td class="nowrap">${order.date_received ? formatDate(order.date_received) : '—'}</td>
      <td>${escapeHtml(order.shop_location || '—')}</td>
      <td class="status-cell">${orderStatusBadge(order)}</td>
      <td class="notes-cell">${renderOrderNotesPreview(order)}</td>
      <td>${renderDesktopOrderActions(order)}</td>
    </tr>
  `;
}

// Phone card: who, what, when on three short lines, with the next step underneath.
function renderOrderCard(order) {
  const id = escapeAttr(order.id);
  const received = (order.status || 'Ordered') === 'Received';
  const when = [
    received ? `Received ${formatDate(order.date_received)}` : order.expected_delivery_date ? `ETA ${formatDate(order.expected_delivery_date)}` : 'No ETA',
    order.shop_location ? `Shop ${escapeHtml(order.shop_location)}` : '',
    order.housecall_job_number || order.housecall_job_link ? `Job ${jobNumberHtml(order)}` : '',
    order.po_number ? `PO ${escapeHtml(order.po_number)}` : ''
  ].filter(Boolean).join(' · ');
  const notes = String(order.notes || '').trim();
  return `
    <article class="order-card ${order.is_overdue ? 'overdue' : ''}">
      <div class="order-card-header">
        <h3>${escapeHtml(order.customer_name)}</h3>
        <div class="order-card-status">${orderStatusBadge(order)}</div>
      </div>
      <p class="order-card-line">${escapeHtml(order.supplier || '—')} · ${escapeHtml(order.category || 'Unassigned')}${order.ordered_by ? ` · ${escapeHtml(order.ordered_by)}` : ''}</p>
      <p class="order-card-line muted">${when}</p>
      ${order.schedule_note ? `<p class="order-card-line schedule-note">${escapeHtml(order.schedule_note)}</p>` : ''}
      ${notes ? `<button type="button" class="order-card-notes" data-action="view-notes" data-id="${id}">${escapeHtml(notes)}</button>` : ''}
      <div class="order-card-actions">
        <button type="button" class="action-button" data-action="edit" data-id="${id}">Edit</button>
        ${nextStepButton(order) || `<button type="button" class="action-button" data-action="progress" data-id="${id}">Progress</button>`}
        <button type="button" class="action-button" data-order-menu="${id}" popovertarget="desktopOrderMenu" aria-label="More actions for ${escapeAttr(order.customer_name)}">More</button>
      </div>
    </article>
  `;
}

function renderCondensedOrders() {
  elements.condensedOrderCount.textContent = `${state.orders.length} matching supplier ${state.orders.length === 1 ? 'order' : 'orders'}`;
  elements.condensedOrdersBody.innerHTML = state.orders.map(order => {
    const notes = order.notes || '—';
    return `<tr class="${order.is_overdue ? 'overdue' : ''}">
      <td class="condensed-customer" title="${escapeAttr(order.customer_name)}"><strong>${escapeHtml(order.customer_name)}</strong></td>
      <td>${jobNumberHtml(order)}</td>
      <td>${escapeHtml(order.category || 'Unassigned')}</td>
      <td class="condensed-supplier" title="${escapeAttr(order.supplier || '')}">${escapeHtml(order.supplier || '—')}</td>
      <td>${order.expected_delivery_date ? formatDate(order.expected_delivery_date) : 'No ETA'}</td>
      <td>${order.date_received ? formatDate(order.date_received) : '—'}</td>
      <td>${escapeHtml(order.shop_location || '—')}</td>
      <td class="status-cell">${orderStatusBadge(order)}</td>
      <td class="condensed-notes" title="${escapeAttr(order.schedule_note || '')}">${escapeHtml(order.schedule_note || '—')}</td>
      <td class="condensed-notes" title="${escapeAttr(notes)}">${escapeHtml(notes)}</td>
      <td class="condensed-actions"><button type="button" class="action-button" data-action="edit" data-id="${escapeAttr(order.id)}" aria-label="Edit order for ${escapeAttr(order.customer_name)}">Edit</button>${nextStepButton(order)}</td>
    </tr>`;
  }).join('');
}

function renderDesktopOrderActions(order) {
  const id = escapeAttr(order.id);
  return `<div class="desktop-order-actions">
    <button type="button" class="action-button" data-action="edit" data-id="${id}">Edit</button>
    ${nextStepButton(order)}
    <button type="button" class="action-button" data-order-menu="${id}" popovertarget="desktopOrderMenu" aria-label="More actions for ${escapeAttr(order.customer_name)}">⋯</button>
  </div>`;
}

function renderOrderNotesPreview(order) {
  const notes = String(order.notes || '').trim().replace(/\s+/g, ' ');
  if (!notes) return '—';
  const preview = notes.length > 80 ? `${notes.slice(0, 80)}…` : notes;
  return `<button type="button" class="order-notes-preview" data-action="view-notes" data-id="${escapeAttr(order.id)}" aria-label="View full notes for ${escapeAttr(order.customer_name)}"><span>${escapeHtml(preview)}</span><small>View notes</small></button>`;
}

function openOrderNotes(order) {
  elements.orderNotesCustomer.textContent = `${order.customer_name}${order.supplier ? ` · ${order.supplier}` : ''}`;
  elements.orderNotesText.textContent = order.notes || 'No notes.';
  elements.orderNotesDialog.showModal();
}

function openDesktopOrderMenu(orderId, trigger) {
  const order = state.orders.find(item => item.id === orderId);
  if (!order) return;
  if (elements.desktopOrderMenu.matches(':popover-open') && elements.desktopOrderMenu.dataset.orderId === orderId) {
    elements.desktopOrderMenu.hidePopover();
    return;
  }
  elements.desktopOrderMenu.dataset.orderId = orderId;
  const id = escapeAttr(order.id);
  elements.desktopOrderMenu.innerHTML = `<button type="button" class="action-button" data-action="progress" data-id="${id}" autofocus>Job progress…</button>
    ${(order.status || 'Ordered') === 'Received' ? `<button type="button" class="action-button danger" data-action="reopen" data-id="${id}">Reopen</button>` : ''}
    <button type="button" class="action-button danger" data-action="delete-order" data-id="${id}">Delete</button>`;
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
    <button type="button" class="action-button danger" data-action="delete-draft" data-id="${id}">Delete job</button>`;
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

async function deleteDraft(draftId) {
  const draft = state.jobDrafts.find((entry) => entry.id === draftId);
  if (!draft) return;

  const orderCount = Number(draft.supplier_order_count || 0);
  if (orderCount && !window.confirm(`Delete ${draft.customer_name}? Its ${orderCount} supplier ${orderCount === 1 ? 'order' : 'orders'} will be deleted too.`)) {
    return;
  }

  try {
    await sendJson(`/api/job-drafts/${draftId}/delete`);
    offerUndo(`Deleted ${draft.customer_name}.`, () => sendJson(`/api/job-drafts/${draftId}/restore`));
    await Promise.all([loadJobDrafts(), loadOrders()]);
  } catch (error) {
    showStatus(error.message, 'error');
  }
}

async function deleteOrder(orderId) {
  const order = state.orders.find((entry) => entry.id === orderId);
  if (!order) return;

  try {
    await sendJson(`/api/orders/${orderId}/delete`);
    offerUndo(`Deleted the ${order.supplier || 'supplier'} order for ${order.customer_name}.`, () => sendJson(`/api/orders/${orderId}/restore`));
    await Promise.all([loadJobDrafts(), loadOrders()]);
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
  state.editingOrder = order;
  elements.categorySelect.value = '';
  elements.orderedBySelect.value = '';
  document.getElementById('supplierInput').value = '';
  renderSupplierOptions();

  const today = localToday();
  document.getElementById('dateOrdered').value = today;

  if (draft) {
    elements.jobDraftId.value = draft.id || '';
    document.getElementById('customerName').value = draft.customer_name || '';
    document.getElementById('housecallJobNumber').value = draft.housecall_job_number || '';
    document.getElementById('housecallJobLink').value = draft.housecall_job_link || '';
    elements.dialogTitle.textContent = `Order materials for ${draft.customer_name}`;
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
  document.getElementById('shopLocation').value = order.shop_location || '';
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
  elements.draftUpdatedAt.value = '';
  elements.draftDepositStatus.value = 'Awaiting deposit';
  state.editingDraft = draft;

  if (!draft) {
    elements.draftDialogTitle.textContent = 'Add approved job';
    elements.draftDialog.showModal();
    return;
  }

  elements.draftDialogTitle.textContent = 'Edit approved job';
  elements.draftId.value = draft.id || '';
  elements.draftUpdatedAt.value = draft.updated_at || '';
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

function draftPayload(draft) {
  return {
    customer_name: draft.customer_name || '',
    housecall_job_number: draft.housecall_job_number || '',
    housecall_job_link: draft.housecall_job_link || '',
    hcp_job_id: draft.hcp_job_id || '',
    deposit_status: draft.deposit_status || 'Awaiting deposit',
    notes: draft.notes || '',
    status: draft.status || 'Open'
  };
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
  const previous = state.editingDraft;
  let data;
  try {
    data = id
      ? await sendJson(`/api/job-drafts/${id}`, { ...payload, updated_at: elements.draftUpdatedAt.value }, 'PUT')
      : await sendJson('/api/job-drafts', payload);
  } catch (error) {
    elements.draftFormError.textContent = error.message;
    return;
  }

  closeDraftDialog();
  if (id && previous) {
    offerUndo('Job updated.', () => sendJson(`/api/job-drafts/${id}`, { ...draftPayload(previous), updated_at: data.draft.updated_at }, 'PUT'));
  } else {
    offerUndo('Approved job added.', () => sendJson(`/api/job-drafts/${data.draft.id}/delete`));
  }
  await loadJobDrafts();
}

async function completeDraft(draftId) {
  try {
    await sendJson(`/api/job-drafts/${draftId}/complete`);
    offerUndo('Job marked as all materials ordered.', () => sendJson(`/api/job-drafts/${draftId}/reopen`));
    await loadJobDrafts();
  } catch (error) {
    showStatus(error.message, 'error');
  }
}

async function reopenDraft(draftId) {
  try {
    await sendJson(`/api/job-drafts/${draftId}/reopen`);
    offerUndo('Job reopened.', () => sendJson(`/api/job-drafts/${draftId}/complete`));
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
    shop_location: document.getElementById('shopLocation').value,
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
  const previous = state.editingOrder;
  let data;
  try {
    data = id
      ? await sendJson(`/api/orders/${id}`, { ...payload, updated_at: elements.orderUpdatedAt.value }, 'PUT')
      : await sendJson('/api/orders', payload);
  } catch (error) {
    elements.formError.textContent = error.message;
    return;
  }

  closeDialog();
  if (id && previous) {
    offerUndo('Order updated.', () => sendJson(`/api/orders/${id}`, { ...orderPayload(previous), updated_at: data.order.updated_at }, 'PUT'));
  } else {
    offerUndo('Order added.', () => sendJson(`/api/orders/${data.order.id}/delete`));
  }
  await Promise.all([loadSuppliers(), loadMasterLists(), loadJobDrafts(), loadOrders()]);
}

function orderPayload(order) {
  return {
    customer_name: order.customer_name || '',
    category: order.category || '',
    housecall_job_number: order.housecall_job_number || '',
    housecall_job_link: order.housecall_job_link || '',
    supplier: order.supplier || '',
    supplier_id: order.supplier_id || '',
    po_number: order.po_number || '',
    date_ordered: order.date_ordered || '',
    expected_delivery_date: order.expected_delivery_date || '',
    date_received: order.date_received || '',
    ordered_by: order.ordered_by || '',
    ordered_by_id: order.ordered_by_id || '',
    shop_location: order.shop_location || '',
    notes: order.notes || '',
    job_draft_id: order.job_draft_id || '',
    status: order.date_received ? 'Received' : 'Ordered'
  };
}

async function markReceived(orderId) {
  const order = state.orders.find((entry) => entry.id === orderId);
  try {
    // The server fills in today's date in Phoenix.
    const data = await sendJson(`/api/orders/${orderId}/mark-received`, { updated_at: order?.updated_at });
    offerUndo(`${order?.customer_name || 'Order'} marked received.`, () => sendJson(`/api/orders/${orderId}/reopen`, { updated_at: data.order.updated_at }));
    await loadOrders();
  } catch (error) {
    showStatus(error.message, 'error');
  }
}

async function reopenOrder(orderId) {
  const order = state.orders.find((entry) => entry.id === orderId);
  try {
    const data = await sendJson(`/api/orders/${orderId}/reopen`, { updated_at: order?.updated_at });
    offerUndo(`${order?.customer_name || 'Order'} reopened.`, () => sendJson(`/api/orders/${orderId}/mark-received`, { date_received: order?.date_received, updated_at: data.order.updated_at }));
    await loadOrders();
  } catch (error) {
    showStatus(error.message, 'error');
  }
}

function progressOf(order) {
  return {
    shop_location: order.shop_location || '',
    job_scheduled: Number(order.job_scheduled || 0),
    scheduled_date: order.scheduled_date || '',
    schedule_note: order.schedule_note || '',
    job_completed: Number(order.job_completed || 0),
    completed_date: order.completed_date || '',
    invoiced: Number(order.invoiced || 0),
    invoice_reference: order.invoice_reference || ''
  };
}

async function saveProgress(order, values, message) {
  const data = await sendJson(`/api/orders/${order.id}/progress`, { ...values, updated_at: order.updated_at }, 'PUT');
  offerUndo(`${message}.`, () => sendJson('/api/order-progress/restore', { updated_at: data.updated_at, items: data.previous }));
  await loadOrders();
}

async function markJobComplete(order) {
  try {
    // The server fills in today's date in Phoenix.
    await saveProgress(order, { ...progressOf(order), job_completed: 1, completed_date: '' }, `${order.customer_name} marked complete`);
  } catch (error) {
    showStatus(error.message, 'error');
  }
}

async function markJobInvoiced(order) {
  try {
    await saveProgress(order, { ...progressOf(order), invoiced: 1 }, `${order.customer_name} marked invoiced`);
  } catch (error) {
    showStatus(error.message, 'error');
  }
}

function openProgressDialog(order, focus = '') {
  const values = progressOf(order);
  if (focus === 'schedule') values.job_scheduled = 1;
  state.editingProgress = order;
  elements.progressCustomer.textContent = [order.customer_name, order.supplier, order.housecall_job_number ? `Job ${order.housecall_job_number}` : ''].filter(Boolean).join(' · ');
  elements.progressShopLocation.value = values.shop_location;
  elements.progressScheduled.checked = Boolean(values.job_scheduled);
  elements.progressScheduledDate.value = values.scheduled_date;
  elements.progressScheduleNote.value = values.schedule_note;
  elements.progressCompleted.checked = Boolean(values.job_completed);
  elements.progressCompletedDate.value = values.completed_date;
  elements.progressInvoiced.checked = Boolean(values.invoiced);
  elements.progressInvoiceReference.value = values.invoice_reference;
  const fromHcp = Boolean(order.hcp && order.hcp.status !== 'canceled');
  elements.progressJobHint.textContent = fromHcp ? 'Scheduled and complete come from Housecall Pro; change them there.' : '';
  elements.progressError.textContent = '';
  state.progressFromHcp = fromHcp;
  syncProgressInputs();
  elements.progressDialog.showModal();
  if (focus === 'schedule') elements.progressScheduledDate.focus();
}

function syncProgressInputs(event) {
  const locked = Boolean(state.progressFromHcp);
  elements.progressScheduled.disabled = locked;
  elements.progressCompleted.disabled = locked;
  elements.progressScheduledDate.disabled = locked || !elements.progressScheduled.checked;
  elements.progressCompletedDate.disabled = locked || !elements.progressCompleted.checked;
  // Ticking Complete suggests today; a job already complete keeps its date (or none).
  if (event?.target === elements.progressCompleted && elements.progressCompleted.checked && !elements.progressCompletedDate.value) elements.progressCompletedDate.value = localToday();
}

async function saveProgressDialog() {
  const order = state.editingProgress;
  if (!order) return;
  const values = {
    shop_location: elements.progressShopLocation.value,
    job_scheduled: elements.progressScheduled.checked ? 1 : 0,
    scheduled_date: elements.progressScheduledDate.value,
    schedule_note: elements.progressScheduleNote.value,
    job_completed: elements.progressCompleted.checked ? 1 : 0,
    completed_date: elements.progressCompletedDate.value,
    invoiced: elements.progressInvoiced.checked ? 1 : 0,
    invoice_reference: elements.progressInvoiceReference.value
  };
  try {
    await saveProgress(order, values, 'Job progress saved');
    elements.progressDialog.close();
  } catch (error) {
    elements.progressError.textContent = error.message;
  }
}

function openSheetImport() {
  state.sheetImport = null;
  elements.sheetImportFile.value = '';
  elements.sheetImportError.textContent = '';
  elements.sheetImportPreview.classList.add('hidden');
  elements.sheetImportDialog.querySelectorAll('input[name="sheetImportMode"]').forEach((input) => { input.checked = false; });
  elements.sheetImportConfirmation.value = '';
  syncSheetImportConfirmation();
  elements.sheetImportDialog.showModal();
}

// A different file, or a new preview, needs its own preview and confirmation.
function resetSheetImportPreview() {
  state.sheetImport = null;
  elements.sheetImportConfirmation.value = '';
  elements.sheetImportPreview.classList.add('hidden');
  syncSheetImportConfirmation();
}

async function previewSheetImport() {
  const file = elements.sheetImportFile.files?.[0];
  elements.sheetImportError.textContent = '';
  resetSheetImportPreview();
  if (!file) {
    elements.sheetImportError.textContent = 'Choose the downloaded .xlsx file first.';
    return;
  }
  elements.previewSheetImportButton.disabled = true;
  elements.previewSheetImportButton.textContent = 'Reading…';
  try {
    const response = await fetch('/api/admin/sheet-import/preview', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Unable to read the sheet.');
    state.sheetImport = data;
    renderSheetImportPreview(data);
  } catch (error) {
    elements.sheetImportError.textContent = error.message;
  } finally {
    elements.previewSheetImportButton.disabled = false;
    elements.previewSheetImportButton.textContent = 'Preview';
  }
}

function renderSheetImportPreview(data) {
  const stage = order => !order.date_received ? 'ordered' : order.job_completed ? (order.invoiced ? 'invoiced' : 'complete') : order.job_scheduled ? 'scheduled' : 'received';
  const counts = { ordered: 0, received: 0, scheduled: 0, complete: 0, invoiced: 0 };
  data.orders.forEach(order => { counts[stage(order)] += 1; });
  const names = list => list.map(item => `${escapeHtml(item.name)}${item.existing ? '' : ' <small>(new)</small>'}`).join(', ');
  const skippedReasons = data.skipped.reduce((all, row) => ({ ...all, [row.reason]: (all[row.reason] || 0) + 1 }), {});
  const withJobNumber = data.orders.filter(order => order.housecall_job_number).length;
  elements.sheetImportSummary.innerHTML = `
    <p><strong>${data.orders.length} orders</strong> will come in: ${data.tabs.map(tab => `${tab.imported} from ${escapeHtml(tab.name)}`).join(', ')}.</p>
    <ul class="import-stages">
      <li>${counts.ordered} not received yet</li>
      <li>${counts.received} received, not scheduled</li>
      <li>${counts.scheduled} scheduled</li>
      <li>${counts.complete} complete, need invoice</li>
    </ul>
    ${data.skipped.length ? `<p>${data.skipped.length} rows left out: ${Object.entries(skippedReasons).map(([reason, count]) => `${count} ${escapeHtml(reason.toLowerCase())}`).join(', ')}.</p>` : ''}
    <p><strong>Suppliers:</strong> ${names(data.suppliers)}</p>
    <p><strong>Ordered by:</strong> ${names(data.staff)}. These are the initials from the sheet; rename them to full names under Ordered By staff afterwards.</p>
    <p><strong>Check after importing:</strong></p>
    <ul>
      <li>Received dates are estimated, because the sheet only has a Received box.</li>
      <li>The glass tab is filed under Showers (Arcadia under Storefront). Change any that should be Flat Glass or Storefront.</li>
      <li>${withJobNumber} orders got their Housecall Pro job number from the invoice column.</li>
    </ul>
    <p class="import-current">The tracker has ${data.current.orders} orders, ${data.current.jobs} approved jobs, ${data.current.suppliers} suppliers and ${data.current.staff} staff right now.</p>
    <details>
      <summary>See all ${data.orders.length} orders</summary>
      <div class="import-table-wrap"><table>
        <thead><tr><th>Customer</th><th>Supplier</th><th>Category</th><th>Ordered</th><th>Step</th></tr></thead>
        <tbody>${data.orders.map(order => `<tr><td>${escapeHtml(order.customer_name)}</td><td>${escapeHtml(order.supplier)}</td><td>${escapeHtml(order.category)}</td><td>${formatDate(order.date_ordered)}</td><td>${STAGE_LABELS[stage(order)]}</td></tr>`).join('')}</tbody>
      </table></div>
    </details>`;
  elements.sheetImportPreview.classList.remove('hidden');
  syncSheetImportConfirmation();
}

function sheetImportMode() {
  return elements.sheetImportDialog.querySelector('input[name="sheetImportMode"]:checked')?.value || '';
}

function syncSheetImportConfirmation() {
  const mode = sheetImportMode();
  const word = mode === 'replace' ? 'REPLACE' : 'IMPORT';
  elements.sheetImportWord.textContent = word;
  elements.applySheetImportButton.disabled = !state.sheetImport || !mode || elements.sheetImportConfirmation.value.trim() !== word;
}

async function applySheetImport() {
  const mode = sheetImportMode();
  elements.applySheetImportButton.disabled = true;
  elements.sheetImportError.textContent = '';
  try {
    const result = await sendJson('/api/admin/sheet-import/apply', { token: state.sheetImport.token, mode, confirmation: elements.sheetImportConfirmation.value.trim() });
    elements.sheetImportDialog.close();
    elements.masterListsDialog.close();
    state.sheetImport = null;
    await Promise.all([loadSuppliers(), loadMasterLists(), loadJobDrafts(), loadOrders()]);
    showStatus(`Imported ${result.orders} orders from the sheet${result.duplicates ? ` (${result.duplicates} already in the tracker were skipped)` : ''}. Added ${result.suppliers_added} suppliers and ${result.staff_added} staff.`, 'success');
  } catch (error) {
    elements.sheetImportError.textContent = error.message;
    syncSheetImportConfirmation();
  }
}

function formatDateTime(value) {
  const parsed = new Date(value);
  return value && !Number.isNaN(parsed.getTime())
    ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(parsed)
    : 'never';
}

async function loadHcpStatus() {
  elements.hcpWebhookUrl.textContent = `${window.location.origin}/api/hcp/webhooks`;
  try {
    const response = await fetch('/api/hcp/status');
    if (!response.ok) return;
    renderHcpStatus(await response.json());
  } catch {
    elements.hcpStatusText.textContent = 'Could not check the Housecall Pro connection.';
  }
}

function renderHcpStatus(status) {
  const sync = status.last_sync_summary;
  if (!status.api && !status.webhooks) {
    elements.hcpStatusText.textContent = 'Not connected yet. The server needs HCP_API_KEY and HCP_WEBHOOK_SECRET (see docs/housecall-pro.md).';
  } else {
    elements.hcpStatusText.textContent = [
      `API ${status.api ? 'connected' : 'not set up (HCP_API_KEY)'}`,
      `webhooks ${status.webhooks ? 'set up' : 'not set up (HCP_WEBHOOK_SECRET)'}`,
      `${status.linked_jobs} linked ${status.linked_jobs === 1 ? 'job' : 'jobs'}`,
      `last webhook ${formatDateTime(status.last_event_at)}`,
      `last sync ${formatDateTime(status.last_sync_at)}${sync ? ` (${sync.jobs_refreshed} refreshed, ${sync.jobs_found_by_number} found by job number, ${sync.numbers_not_found} job numbers not found)` : ''}`,
      status.last_error ? `last problem: ${status.last_error}` : ''
    ].filter(Boolean).join(' · ');
  }
  elements.hcpSyncButton.disabled = !status.api;
  elements.hcpRecentEvents.innerHTML = (status.recent_events || []).map(event => `<li>${escapeHtml(formatDateTime(event.received_at))} · ${escapeHtml(event.event)} · ${escapeHtml(event.outcome)}</li>`).join('');
}

async function syncHousecallPro() {
  elements.hcpSyncButton.disabled = true;
  elements.hcpSyncButton.textContent = 'Syncing…';
  try {
    const result = await sendJson('/api/hcp/sync');
    showStatus(`Synced with Housecall Pro: ${result.orders_updated} ${result.orders_updated === 1 ? 'order' : 'orders'} updated.`, 'success');
    await loadOrders();
  } catch (error) {
    showStatus(error.message, 'error');
  } finally {
    elements.hcpSyncButton.textContent = 'Sync with Housecall Pro now';
    await loadHcpStatus();
  }
}

function showStatus(message, type = 'success') {
  elements.statusMessage.textContent = message;
  elements.statusMessage.className = `message-box ${type}`;
}

async function sendJson(url, body = {}, method = 'POST') {
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Unable to save right now.');
  return data;
}

// After a change, a bar at the bottom offers to put things back for 15 seconds.
function offerUndo(message, undo) {
  showStatus('');
  clearTimeout(state.undoTimer);
  state.undo = undo;
  elements.undoMessage.textContent = message;
  elements.undoToast.classList.remove('hidden');
  state.undoTimer = setTimeout(hideUndo, 15000);
}

function hideUndo() {
  clearTimeout(state.undoTimer);
  state.undo = null;
  elements.undoToast.classList.add('hidden');
}

async function runUndo() {
  const undo = state.undo;
  hideUndo();
  if (!undo) return;
  try {
    await undo();
    showStatus('Undone.', 'success');
  } catch (error) {
    showStatus(`Couldn't undo: ${error.message}`, 'error');
  }
  await Promise.all([loadJobDrafts(), loadOrders()]);
}

function localToday() {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

// "Oct 26" for this year, "Oct 26, 2025" otherwise, so dates fit on one line.
function formatDate(value) {
  if (!value) return '—';
  const parsed = new Date(`${value}T12:00:00`);
  if (Number.isNaN(parsed.getTime())) return value;
  const options = parsed.getFullYear() === new Date().getFullYear()
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' };
  return new Intl.DateTimeFormat('en-US', options).format(parsed);
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
