const state = {
  status: 'Outstanding',
  groupView: 'All Orders',
  category: '',
  supplier: [],
  search: '',
  sort: 'expected_delivery_date',
  orders: [],
  suppliers: []
};

const elements = {
  currentUser: document.getElementById('currentUser'),
  searchInput: document.getElementById('searchInput'),
  groupFilter: document.getElementById('groupFilter'),
  categoryFilter: document.getElementById('categoryFilter'),
  supplierFilter: document.getElementById('supplierFilter'),
  sortSelect: document.getElementById('sortSelect'),
  addOrderButton: document.getElementById('addOrderButton'),
  logoutButton: document.getElementById('logoutButton'),
  tableBody: document.getElementById('ordersTableBody'),
  emptyState: document.getElementById('emptyState'),
  statusMessage: document.getElementById('statusMessage'),
  dialog: document.getElementById('orderDialog'),
  form: document.getElementById('orderForm'),
  formError: document.getElementById('formError'),
  closeDialogButton: document.getElementById('closeDialogButton'),
  cancelOrderButton: document.getElementById('cancelOrderButton'),
  dialogTitle: document.getElementById('dialogTitle'),
  orderId: document.getElementById('orderId'),
  orderUpdatedAt: document.getElementById('orderUpdatedAt'),
  categorySelect: document.getElementById('categorySelect')
};

document.addEventListener('DOMContentLoaded', async () => {
  bindEvents();

  try {
    const sessionResponse = await fetch('/api/me');
    if (!sessionResponse.ok) {
      window.location.href = '/login';
      return;
    }

    const { user } = await sessionResponse.json();
    elements.currentUser.textContent = user.full_name || user.username;
    await Promise.all([loadSuppliers(), loadOrders()]);
  } catch (error) {
    showStatus('Unable to load the tracker. Please refresh the page.', 'error');
  }
});

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

  elements.supplierFilter.addEventListener('change', () => {
    state.supplier = Array.from(elements.supplierFilter.selectedOptions).map((option) => option.value);
    loadOrders();
  });

  elements.sortSelect.addEventListener('change', (event) => {
    state.sort = event.target.value;
    loadOrders();
  });

  elements.addOrderButton.addEventListener('click', () => openOrderDialog());
  elements.closeDialogButton.addEventListener('click', () => closeDialog());
  elements.cancelOrderButton.addEventListener('click', () => closeDialog());
  elements.logoutButton.addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/login';
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

async function loadSuppliers() {
  const response = await fetch('/api/suppliers');
  const data = await response.json();
  state.suppliers = data.suppliers || [];

  const options = state.suppliers.map((supplier) => `<option value="${escapeHtml(supplier)}">${escapeHtml(supplier)}</option>`).join('');
  elements.supplierFilter.innerHTML = options;
  const selected = Array.isArray(state.supplier) ? state.supplier : [state.supplier].filter(Boolean);
  for (const supplier of selected) {
    const option = [...elements.supplierFilter.options].find((entry) => entry.value === supplier);
    if (option) option.selected = true;
  }

  const datalist = document.getElementById('supplierList');
  datalist.innerHTML = state.suppliers
    .map((supplier) => `<option value="${escapeHtml(supplier)}"></option>`)
    .join('');
}

async function loadOrders() {
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

  const response = await fetch(`/api/orders?${params.toString()}`);
  if (!response.ok) {
    showStatus('Unable to load orders right now.', 'error');
    return;
  }

  const data = await response.json();
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
          <td>${escapeHtml(order.supplier)}</td>
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

async function saveOrder() {
  const payload = {
    customer_name: document.getElementById('customerName').value,
    category: elements.categorySelect.value,
    housecall_job_number: document.getElementById('housecallJobNumber').value,
    housecall_job_link: document.getElementById('housecallJobLink').value,
    supplier: document.getElementById('supplierInput').value,
    po_number: document.getElementById('poNumber').value,
    date_ordered: document.getElementById('dateOrdered').value,
    expected_delivery_date: document.getElementById('expectedDeliveryDate').value,
    date_received: document.getElementById('dateReceived').value,
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
    await loadSuppliers();
    await loadOrders();
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
