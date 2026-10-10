import express from 'express';
import session from 'express-session';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import {
  getDb,
  initializeDatabase,
  ensureSupplierExists,
  getActiveSuppliers,
  getAllSuppliers,
  getActiveStaffNames,
  getAllStaffNames,
  upsertSupplierMasterRow,
  upsertStaffMasterRow
} from './db.js';
import {
  ORDER_CATEGORIES,
  getOrderGroup,
  isoNow,
  normalizeCategory,
  normalizeOrderInput,
  normalizeText,
  statusFromOrder,
  todayPhoenixString
} from './utils.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../public');
const app = express();
const port = Number(process.env.APP_PORT || process.env.PORT || 3000);
const liveClients = new Set();
const VALID_DEPOSIT_STATUSES = [
  'Awaiting deposit',
  'Deposit received',
  'Deposit waived / not required'
];

function broadcastLiveEvent(type, payload = {}) {
  const envelope = JSON.stringify({
    type,
    timestamp: isoNow(),
    ...payload
  });

  for (const client of [...liveClients]) {
    try {
      client.write(`event: ${type}\ndata: ${envelope}\n\n`);
    } catch (error) {
      liveClients.delete(client);
    }
  }
}

initializeDatabase();

app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '1mb' }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'boulevard-session-secret-change-me',
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 1000 * 60 * 60 * 12,
      sameSite: 'lax',
      httpOnly: true
    }
  })
);

app.use(express.static(publicDir));

function currentAdminUsername() {
  return (process.env.ADMIN_USERNAME || 'admin').trim();
}

function currentAdminPasswordHash() {
  return process.env.ADMIN_PASSWORD_HASH || bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'admin123', 10);
}

function requireAdminAuth(req, res, next) {
  if (!req.session.admin || req.session.admin.username !== currentAdminUsername()) {
    return res.status(401).json({ error: 'Administrator authentication required.' });
  }

  next();
}

function parseMultiValueFilter(req, key) {
  const raw = [].concat(req.query[key] || []);
  return raw
    .flatMap((value) => (Array.isArray(value) ? value : [value]))
    .map((value) => String(value).trim())
    .filter(Boolean);
}

function normalizeDraftDepositStatus(value) {
  const status = normalizeText(value || '');
  if (VALID_DEPOSIT_STATUSES.includes(status)) {
    return status;
  }
  return 'Awaiting deposit';
}

function normalizeArchiveSource(value) {
  const source = normalizeText(value || 'manual');
  return source === 'future_hcp_automation' ? 'future_hcp_automation' : 'manual';
}

function getJobDraftById(id) {
  const draftId = normalizeText(id || '');
  if (!draftId) {
    return null;
  }

  return getDb().prepare('SELECT * FROM job_drafts WHERE id = ?').get(draftId) || null;
}

function isDraftReadyForOrdering(draft) {
  if (!draft) return false;
  return draft.status !== 'Completed' && draft.deposit_status !== 'Awaiting deposit';
}

function serializeJobDraft(draft) {
  if (!draft) return null;

  const supplierOrderCount = Number(getDb()
    .prepare('SELECT COUNT(*) as count FROM orders WHERE job_draft_id = ? AND is_archived = 0')
    .get(draft.id)?.count || 0);

  return {
    ...draft,
    is_archived: Boolean(Number(draft.is_archived || 0)),
    status: draft.status || 'Open',
    deposit_status: normalizeDraftDepositStatus(draft.deposit_status),
    hcp_job_id: normalizeText(draft.hcp_job_id || ''),
    ready_to_order: isDraftReadyForOrdering(draft),
    supplier_order_count: supplierOrderCount
  };
}

function getArchivedOrderIdsForDraft(draftId) {
  const rows = getDb()
    .prepare('SELECT id, customer_name, supplier, po_number, status FROM orders WHERE job_draft_id = ? AND is_archived = 0 ORDER BY date_ordered DESC, created_at DESC')
    .all(draftId);

  return rows.map((order) => ({
    id: order.id,
    customer_name: order.customer_name,
    supplier: order.supplier,
    po_number: order.po_number,
    status: order.status || 'Ordered'
  }));
}

function markOrdersArchived(orderIds, metadata = {}) {
  if (!Array.isArray(orderIds) || !orderIds.length) {
    return [];
  }

  const stamp = isoNow();
  const source = normalizeArchiveSource(metadata.source || 'manual');
  const reason = (metadata.reason || '').trim();

  const uniqueIds = [...new Set(orderIds.map((id) => normalizeText(id || '')).filter(Boolean))];
  const placeholders = uniqueIds.map(() => '?').join(', ');
  getDb().prepare(`UPDATE orders SET is_archived = 1, archived_at = ?, archive_source = ?, archive_reason = ? WHERE id IN (${placeholders})`).run(
    stamp,
    source,
    reason,
    ...uniqueIds
  );

  return uniqueIds;
}

function markDraftsArchived(draftIds, metadata = {}) {
  if (!Array.isArray(draftIds) || !draftIds.length) {
    return [];
  }

  const stamp = isoNow();
  const source = normalizeArchiveSource(metadata.source || 'manual');
  const reason = (metadata.reason || '').trim();

  const uniqueIds = [...new Set(draftIds.map((id) => normalizeText(id || '')).filter(Boolean))];
  const placeholders = uniqueIds.map(() => '?').join(', ');
  getDb().prepare(`UPDATE job_drafts SET is_archived = 1, archived_at = ?, archive_source = ?, archive_reason = ? WHERE id IN (${placeholders})`).run(
    stamp,
    source,
    reason,
    ...uniqueIds
  );

  return uniqueIds;
}

function restoreOrders(orderIds) {
  if (!Array.isArray(orderIds) || !orderIds.length) {
    return [];
  }

  const uniqueIds = [...new Set(orderIds.map((id) => normalizeText(id || '')).filter(Boolean))];
  const placeholders = uniqueIds.map(() => '?').join(', ');
  getDb().prepare(`UPDATE orders SET is_archived = 0, archived_at = NULL, archive_source = NULL, archive_reason = NULL WHERE id IN (${placeholders})`).run(...uniqueIds);
  return uniqueIds;
}

function restoreDrafts(draftIds) {
  if (!Array.isArray(draftIds) || !draftIds.length) {
    return [];
  }

  const uniqueIds = [...new Set(draftIds.map((id) => normalizeText(id || '')).filter(Boolean))];
  const placeholders = uniqueIds.map(() => '?').join(', ');
  getDb().prepare(`UPDATE job_drafts SET is_archived = 0, archived_at = NULL, archive_source = NULL, archive_reason = NULL WHERE id IN (${placeholders})`).run(...uniqueIds);
  return uniqueIds;
}

app.get('/', (req, res) => {
  return res.redirect('/app');
});

app.get('/login', (req, res) => {
  return res.sendFile(path.join(publicDir, 'login.html'));
});

app.get('/app', (req, res) => {
  return res.sendFile(path.join(publicDir, 'index.html'));
});

app.post('/api/login', (req, res) => {
  const username = normalizeText(req.body.username);
  const password = normalizeText(req.body.password);

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  const user = getDb().prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  const valid = bcrypt.compareSync(password, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }

  req.session.user = {
    id: user.id,
    username: user.username,
    full_name: user.full_name
  };

  return res.json({
    success: true,
    user: req.session.user
  });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ success: true });
  });
});

app.get('/api/me', (req, res) => {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Not authenticated.' });
  }

  return res.json({ user: req.session.user });
});

function resolveSupplierDisplay(order) {
  const supplierId = normalizeText(order.supplier_id || '');
  if (supplierId) {
    const supplier = getDb().prepare('SELECT name FROM suppliers WHERE id = ?').get(supplierId);
    if (supplier && supplier.name) {
      return supplier.name;
    }
  }

  return normalizeText(order.supplier || '');
}

function resolveOrderedByDisplay(order) {
  const orderedById = normalizeText(order.ordered_by_id || '');
  if (orderedById) {
    const staff = getDb().prepare('SELECT name FROM staff_names WHERE id = ?').get(orderedById);
    if (staff && staff.name) {
      return staff.name;
    }
  }

  return normalizeText(order.ordered_by || '');
}

app.get('/api/suppliers', (req, res) => {
  const suppliers = getActiveSuppliers();
  return res.json({ suppliers: suppliers.map((item) => item.name) });
});

app.get('/api/master-lists', (req, res) => {
  const suppliers = getAllSuppliers();
  const staffNames = getAllStaffNames();
  const historicalOrderedBy = getDb()
    .prepare("SELECT DISTINCT ordered_by FROM orders WHERE ordered_by IS NOT NULL AND ordered_by <> '' ORDER BY ordered_by COLLATE NOCASE ASC")
    .all()
    .map((row) => row.ordered_by);
  const mergedStaffNames = [...new Set([
    ...staffNames.map((item) => item.name),
    ...historicalOrderedBy
  ].filter(Boolean))];

  return res.json({
    suppliers: suppliers.map((item) => ({
      id: item.id,
      name: item.name,
      active: Number(item.active) !== 0
    })),
    staff_names: staffNames.map((item) => ({
      id: item.id,
      name: item.name,
      active: Number(item.active) !== 0
    })),
    ordered_by_options: mergedStaffNames
  });
});

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  liveClients.add(res);
  res.write(`event: connected\ndata: ${JSON.stringify({ type: 'connected', timestamp: isoNow() })}\n\n`);

  const heartbeat = setInterval(() => {
    try {
      res.write(`event: heartbeat\ndata: ${JSON.stringify({ type: 'heartbeat', timestamp: isoNow() })}\n\n`);
    } catch (error) {
      clearInterval(heartbeat);
      liveClients.delete(res);
    }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    liveClients.delete(res);
  });
});

app.get('/api/job-drafts', (req, res) => {
  const statusFilter = normalizeText(req.query.status || '');
  const archivedOnly = req.query.archived === 'true' || statusFilter === 'Archived';
  const rows = statusFilter === 'Archived'
    ? getDb().prepare('SELECT * FROM job_drafts WHERE is_archived = 1 ORDER BY archived_at DESC, updated_at DESC').all()
    : statusFilter
      ? getDb().prepare('SELECT * FROM job_drafts WHERE status = ? AND is_archived = ? ORDER BY updated_at DESC, created_at DESC').all(statusFilter, archivedOnly ? 1 : 0)
      : getDb().prepare('SELECT * FROM job_drafts WHERE is_archived = ? ORDER BY updated_at DESC, created_at DESC').all(archivedOnly ? 1 : 0);

  return res.json({ drafts: rows.map((row) => serializeJobDraft(row)) });
});

app.post('/api/job-drafts', (req, res) => {
  const draftData = {
    customer_name: normalizeText(req.body.customer_name),
    housecall_job_number: normalizeText(req.body.housecall_job_number),
    housecall_job_link: normalizeText(req.body.housecall_job_link),
    hcp_job_id: normalizeText(req.body.hcp_job_id),
    notes: typeof req.body.notes === 'string' ? req.body.notes.trim() : '',
    deposit_status: normalizeDraftDepositStatus(req.body.deposit_status),
    status: 'Open'
  };

  if (!draftData.customer_name) {
    return res.status(400).json({ error: 'Customer name is required.' });
  }

  const now = isoNow();
  const id = `draft-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  getDb().prepare(`
    INSERT INTO job_drafts (
      id, customer_name, housecall_job_number, housecall_job_link, hcp_job_id, notes,
      deposit_status, status, created_at, updated_at, created_by, updated_by, is_preview_data
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(
    id,
    draftData.customer_name,
    draftData.housecall_job_number,
    draftData.housecall_job_link,
    draftData.hcp_job_id,
    draftData.notes,
    draftData.deposit_status,
    draftData.status,
    now,
    now,
    'office-user',
    'office-user'
  );

  const draft = serializeJobDraft(getJobDraftById(id));
  broadcastLiveEvent('job-drafts', { action: 'created', draftId: id, time: isoNow() });
  return res.status(201).json({ draft });
});

app.put('/api/job-drafts/:id', (req, res) => {
  const draft = getJobDraftById(req.params.id);
  if (!draft) {
    return res.status(404).json({ error: 'Job draft not found.' });
  }

  const draftData = {
    customer_name: normalizeText(req.body.customer_name || draft.customer_name),
    housecall_job_number: normalizeText(req.body.housecall_job_number || draft.housecall_job_number),
    housecall_job_link: normalizeText(req.body.housecall_job_link || draft.housecall_job_link),
    hcp_job_id: normalizeText(req.body.hcp_job_id || draft.hcp_job_id),
    notes: typeof req.body.notes === 'string' ? req.body.notes.trim() : (draft.notes || ''),
    deposit_status: normalizeDraftDepositStatus(req.body.deposit_status || draft.deposit_status),
    status: normalizeText(req.body.status || draft.status || 'Open')
  };

  if (!draftData.customer_name) {
    return res.status(400).json({ error: 'Customer name is required.' });
  }

  const now = isoNow();
  getDb().prepare(`
    UPDATE job_drafts SET
      customer_name = ?,
      housecall_job_number = ?,
      housecall_job_link = ?,
      hcp_job_id = ?,
      notes = ?,
      deposit_status = ?,
      status = ?,
      updated_at = ?,
      updated_by = ?
    WHERE id = ?
  `).run(
    draftData.customer_name,
    draftData.housecall_job_number,
    draftData.housecall_job_link,
    draftData.hcp_job_id,
    draftData.notes,
    draftData.deposit_status,
    draftData.status === 'Completed' ? 'Completed' : 'Open',
    now,
    'office-user',
    req.params.id
  );

  const updated = serializeJobDraft(getJobDraftById(req.params.id));
  broadcastLiveEvent('job-drafts', { action: 'updated', draftId: req.params.id, time: isoNow() });
  return res.json({ draft: updated });
});

app.post('/api/job-drafts/:id/complete', (req, res) => {
  const draft = getJobDraftById(req.params.id);
  if (!draft) {
    return res.status(404).json({ error: 'Job draft not found.' });
  }

  const now = isoNow();
  getDb().prepare('UPDATE job_drafts SET status = ?, updated_at = ?, updated_by = ? WHERE id = ?').run('Completed', now, 'office-user', req.params.id);
  const updated = serializeJobDraft(getJobDraftById(req.params.id));
  broadcastLiveEvent('job-drafts', { action: 'completed', draftId: req.params.id, time: isoNow() });
  return res.json({ draft: updated });
});

app.post('/api/job-drafts/:id/archive', (req, res) => {
  const draft = getJobDraftById(req.params.id);
  if (!draft) {
    return res.status(404).json({ error: 'Job draft not found.' });
  }

  const linkedOrders = getArchivedOrderIdsForDraft(draft.id);
  const hasOutstanding = linkedOrders.some((order) => order.status !== 'Received');
  const confirmed = req.body.confirm === true || req.body.confirm === 'true';
  const source = normalizeArchiveSource(req.body.source || 'manual');
  const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
  const warningMessage = hasOutstanding
    ? 'This job still has outstanding supplier orders or unfinished ordering work. Archive is allowed only after explicit staff confirmation.'
    : null;

  const archivedIds = markDraftsArchived([draft.id], { source, reason });
  const archivedOrderIds = markOrdersArchived(linkedOrders.map((order) => order.id), { source, reason });

  broadcastLiveEvent('job-drafts', { action: 'archived', draftId: draft.id, time: isoNow() });
  broadcastLiveEvent('orders', { action: 'archived', orderIds: archivedOrderIds, time: isoNow() });

  return res.json({
    archived: archivedIds.length > 0,
    draft_id: draft.id,
    order_ids: archivedOrderIds,
    warning: warningMessage,
    requires_confirmation: false,
    source,
    reason
  });
});

app.post('/api/job-drafts/:id/restore', (req, res) => {
  const draft = getJobDraftById(req.params.id);
  if (!draft) {
    return res.status(404).json({ error: 'Job draft not found.' });
  }

  const restoredDraftIds = restoreDrafts([draft.id]);
  const linkedOrders = getDb().prepare('SELECT id FROM orders WHERE job_draft_id = ?').all(draft.id).map((row) => row.id);
  restoreOrders(linkedOrders);

  broadcastLiveEvent('job-drafts', { action: 'restored', draftId: draft.id, time: isoNow() });
  broadcastLiveEvent('orders', { action: 'restored', orderIds: linkedOrders, time: isoNow() });

  return res.json({ restored: restoredDraftIds.length > 0, draft_id: draft.id, order_ids: linkedOrders });
});

app.post('/api/job-drafts/:id/reopen', (req, res) => {
  const draft = getJobDraftById(req.params.id);
  if (!draft) {
    return res.status(404).json({ error: 'Job draft not found.' });
  }

  const now = isoNow();
  getDb().prepare('UPDATE job_drafts SET status = ?, updated_at = ?, updated_by = ? WHERE id = ?').run('Open', now, 'office-user', req.params.id);
  const updated = serializeJobDraft(getJobDraftById(req.params.id));
  broadcastLiveEvent('job-drafts', { action: 'reopened', draftId: req.params.id, time: isoNow() });
  return res.json({ draft: updated });
});

app.get('/api/admin/me', (req, res) => {
  if (!req.session.admin || req.session.admin.username !== currentAdminUsername()) {
    return res.json({ admin: null });
  }

  return res.json({ admin: req.session.admin });
});

app.post('/api/admin/login', (req, res) => {
  const username = normalizeText(req.body.username);
  const password = normalizeText(req.body.password);

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  const adminUsername = currentAdminUsername();
  if (username !== adminUsername) {
    return res.status(401).json({ error: 'Invalid administrator credentials.' });
  }

  const expectedHash = currentAdminPasswordHash();
  const valid = bcrypt.compareSync(password, expectedHash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid administrator credentials.' });
  }

  req.session.admin = { username: adminUsername };
  return res.json({ success: true, admin: req.session.admin });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.admin = null;
  return res.json({ success: true });
});

app.post('/api/master-lists/suppliers', requireAdminAuth, (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  const saved = items
    .map((item) => upsertSupplierMasterRow({
      id: item.id || '',
      name: item.name,
      active: item.active !== false
    }))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  broadcastLiveEvent('master-lists', { collection: 'suppliers', action: 'updated', count: saved.length, time: isoNow() });

  return res.json({ suppliers: saved.map((item) => ({ id: item.id, name: item.name, active: Number(item.active) !== 0 })) });
});

app.post('/api/master-lists/ordered-by', requireAdminAuth, (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  const saved = items
    .map((item) => upsertStaffMasterRow({
      id: item.id || '',
      name: item.name,
      active: item.active !== false
    }))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  broadcastLiveEvent('master-lists', { collection: 'ordered_by', action: 'updated', count: saved.length, time: isoNow() });

  return res.json({ staff_names: saved.map((item) => ({ id: item.id, name: item.name, active: Number(item.active) !== 0 })) });
});

app.post('/api/orders/archive', (req, res) => {
  const ids = Array.isArray(req.body.order_ids) ? req.body.order_ids : [];
  if (!ids.length) {
    return res.status(400).json({ error: 'At least one order must be selected to archive.' });
  }

  const source = normalizeArchiveSource(req.body.source || 'manual');
  const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
  const selected = ids
    .map((id) => normalizeText(id || ''))
    .filter(Boolean);

  if (!selected.length) {
    return res.status(400).json({ error: 'No valid orders were selected for archiving.' });
  }

  const archivedIds = markOrdersArchived(selected, { source, reason });
  const jobDraftIds = getDb().prepare('SELECT DISTINCT job_draft_id FROM orders WHERE id IN (' + selected.map(() => '?').join(', ') + ') AND job_draft_id IS NOT NULL').all(...selected).map((row) => row.job_draft_id).filter(Boolean);
  if (jobDraftIds.length) {
    markDraftsArchived(jobDraftIds, { source, reason });
  }

  broadcastLiveEvent('orders', { action: 'archived', orderIds: archivedIds, time: isoNow() });
  return res.json({ archived: true, order_ids: archivedIds, source, reason });
});

app.post('/api/orders/:id/restore', (req, res) => {
  const order = getDb().prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) {
    return res.status(404).json({ error: 'Order not found.' });
  }

  const restoredIds = restoreOrders([order.id]);
  if (order.job_draft_id) {
    const linkedOrders = getDb().prepare('SELECT id FROM orders WHERE job_draft_id = ?').all(order.job_draft_id).map((row) => row.id);
    restoreOrders(linkedOrders);
    const linkedDraft = getDb().prepare('SELECT * FROM job_drafts WHERE id = ?').get(order.job_draft_id);
    if (linkedDraft && Number(linkedDraft.is_archived) === 1) {
      restoreDrafts([linkedDraft.id]);
    }
  }

  broadcastLiveEvent('orders', { action: 'restored', orderId: order.id, time: isoNow() });
  return res.json({ restored: restoredIds.length > 0, order_id: order.id });
});

app.get('/api/orders', (req, res) => {
  const rows = getDb()
    .prepare('SELECT * FROM orders ORDER BY date_ordered DESC, created_at DESC')
    .all();

  const statusFilter = (req.query.status || 'Outstanding').toString();
  const viewFilter = (req.query.view || 'All Orders').toString();
  const categoryFilter = (req.query.category || '').toString();
  const supplierFilters = parseMultiValueFilter(req, 'supplier');
  const orderedByFilters = parseMultiValueFilter(req, 'ordered_by');
  const searchTerm = (req.query.search || '').toString().trim().toLowerCase();

  let filtered = rows.filter((order) => {
    const status = statusFromOrder(order);
    const resolvedGroup = order.category ? getOrderGroup(order.category) : (order.combined_group || '');

    if (Number(order.is_archived || 0) === 1 && statusFilter !== 'Archived') {
      return false;
    }
    if (statusFilter === 'Archived' && Number(order.is_archived || 0) !== 1) {
      return false;
    }

    if (statusFilter === 'Outstanding' && status !== 'Ordered') return false;
    if (statusFilter === 'Overdue') {
      if (status !== 'Ordered') return false;
      if (!order.expected_delivery_date) return false;
      if (order.expected_delivery_date >= todayPhoenixString()) return false;
    }
    if (statusFilter === 'Received' && status !== 'Received') return false;

    if (viewFilter === 'Windows / Flat Glass' && !['Windows / Flat Glass'].includes(resolvedGroup)) {
      return false;
    }
    if (viewFilter === 'Heavy Glass / Storefront' && !['Heavy Glass / Storefront'].includes(resolvedGroup)) {
      return false;
    }

    if (categoryFilter && order.category !== categoryFilter) {
      return false;
    }

    if (supplierFilters.length && !supplierFilters.includes(order.supplier)) {
      return false;
    }

    if (orderedByFilters.length) {
      const selectedNames = orderedByFilters.map((name) => name.toLowerCase());
      const orderName = (order.ordered_by || '').trim().toLowerCase();
      if (!selectedNames.includes(orderName)) {
        return false;
      }
    }

    if (searchTerm) {
      const haystack = [
        order.customer_name,
        order.housecall_job_number,
        order.supplier,
        order.po_number,
        order.category || '',
        resolvedGroup
      ]
        .join(' ')
        .toLowerCase();

      if (!haystack.includes(searchTerm)) {
        return false;
      }
    }

    return true;
  });

  const sortKey = (req.query.sort || 'customer_name').toString();
  filtered.sort((a, b) => {
    if (sortKey === 'customer_name') {
      const aName = (a.customer_name || '').trim().toLocaleLowerCase();
      const bName = (b.customer_name || '').trim().toLocaleLowerCase();
      const nameCompare = aName.localeCompare(bName, undefined, { sensitivity: 'base' });
      if (nameCompare !== 0) {
        return nameCompare;
      }
      const aTie = a.created_at || a.updated_at || '9999-12-31';
      const bTie = b.created_at || b.updated_at || '9999-12-31';
      return aTie.localeCompare(bTie) || String(a.id || '').localeCompare(String(b.id || ''));
    }

    if (sortKey === 'order_date') {
      const aDate = a.date_ordered || '9999-12-31';
      const bDate = b.date_ordered || '9999-12-31';
      return aDate.localeCompare(bDate) || String(a.id || '').localeCompare(String(b.id || ''));
    }

    const aValue = a.expected_delivery_date || '9999-12-31';
    const bValue = b.expected_delivery_date || '9999-12-31';
    return aValue.localeCompare(bValue) || String(a.id || '').localeCompare(String(b.id || ''));
  });

  const normalized = filtered.map((order) => ({
    ...order,
    category: order.category || '',
    combined_group: order.category ? getOrderGroup(order.category) : (order.combined_group || ''),
    status: statusFromOrder(order),
    is_overdue: order.expected_delivery_date && order.status === 'Ordered' && order.expected_delivery_date < todayPhoenixString()
  }));

  return res.json({ orders: normalized });
});

app.post('/api/orders', (req, res) => {
  try {
    const orderData = normalizeOrderInput(req.body);
    const draftId = normalizeText(req.body.job_draft_id || '');

    if (draftId) {
      const draft = getJobDraftById(draftId);
      if (!draft) {
        return res.status(404).json({ error: 'Job draft not found.' });
      }

      if (draft.status === 'Completed') {
        return res.status(400).json({ error: 'This job draft is already marked complete. Reopen it before ordering more materials.' });
      }

      if (draft.deposit_status === 'Awaiting deposit') {
        return res.status(400).json({ error: 'Deposit must be received or waived before creating a supplier order.' });
      }

      orderData.job_draft_id = draftId;
    }

    if (!orderData.customer_name) {
      return res.status(400).json({ error: 'Customer name is required.' });
    }

    if (!orderData.supplier) {
      return res.status(400).json({ error: 'Supplier is required.' });
    }

    if (!orderData.category) {
      return res.status(400).json({ error: 'Category is required.' });
    }

    if (!orderData.ordered_by) {
      return res.status(400).json({ error: 'Ordered by is required.' });
    }
    const supplierRecord = ensureSupplierExists(orderData.supplier);
    if (!supplierRecord) {
      return res.status(400).json({ error: 'Supplier is required.' });
    }

    orderData.supplier = supplierRecord.name;
    orderData.supplier_id = supplierRecord.id;
    orderData.category = normalizeCategory(orderData.category);
    orderData.combined_group = getOrderGroup(orderData.category);

    if (!orderData.category) {
      return res.status(400).json({ error: 'Category is required.' });
    }

    const orderId = `order-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const now = isoNow();

    const insert = getDb().prepare(`
      INSERT INTO orders (
        id, customer_name, housecall_job_number, housecall_job_link, supplier, supplier_id, category, combined_group,
        po_number, date_ordered, expected_delivery_date, date_received, ordered_by, ordered_by_id, status, notes, job_draft_id,
        created_at, updated_at, created_by, updated_by, is_preview_data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `);

    insert.run(
      orderId,
      orderData.customer_name,
      orderData.housecall_job_number,
      orderData.housecall_job_link,
      orderData.supplier,
      orderData.supplier_id || null,
      orderData.category,
      orderData.combined_group,
      orderData.po_number,
      orderData.date_ordered,
      orderData.expected_delivery_date,
      orderData.date_received,
      orderData.ordered_by || '',
      orderData.ordered_by_id || null,
      orderData.date_received ? 'Received' : 'Ordered',
      orderData.notes,
      orderData.job_draft_id || null,
      now,
      now,
      'office-user',
      'office-user'
    );

    const created = getDb().prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    broadcastLiveEvent('orders', { action: 'created', orderId, updatedAt: created.updated_at, time: isoNow() });
    return res.status(201).json({
      order: {
        ...created,
        status: statusFromOrder(created),
        supplier: resolveSupplierDisplay(created),
        ordered_by: resolveOrderedByDisplay(created)
      }
    });
  } catch (error) {
    return res.status(500).json({ error: 'Unable to save the order.', details: error.message });
  }
});

app.put('/api/orders/:id', (req, res) => {
  try {
    const existing = getDb().prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    if (!existing) {
      return res.status(404).json({ error: 'Order not found.' });
    }

    const incomingVersion = (req.body.updated_at || req.body.version || '').toString();
    if (incomingVersion && incomingVersion !== existing.updated_at) {
      return res.status(409).json({
        error: 'This order was edited by another staff member. Please refresh and try again.'
      });
    }

    const orderData = normalizeOrderInput(req.body);
    if (!orderData.customer_name) {
      return res.status(400).json({ error: 'Customer name is required.' });
    }

    if (!orderData.supplier) {
      return res.status(400).json({ error: 'Supplier is required.' });
    }

    if (!orderData.category) {
      return res.status(400).json({ error: 'Category is required.' });
    }

    if (!orderData.ordered_by) {
      return res.status(400).json({ error: 'Ordered by is required.' });
    }

    const supplierRecord = ensureSupplierExists(orderData.supplier);
    if (!supplierRecord) {
      return res.status(400).json({ error: 'Supplier is required.' });
    }

    orderData.supplier = supplierRecord.name;
    orderData.supplier_id = supplierRecord.id;
    orderData.category = normalizeCategory(orderData.category);
    orderData.combined_group = getOrderGroup(orderData.category);

    if (req.body.status === 'Received') {
      orderData.date_received = req.body.date_received || todayPhoenixString();
    } else if (req.body.status === 'Ordered') {
      orderData.date_received = '';
    }

    const now = isoNow();
    getDb().prepare(`
      UPDATE orders SET
        customer_name = ?,
        housecall_job_number = ?,
        housecall_job_link = ?,
        supplier = ?,
        supplier_id = ?,
        category = ?,
        combined_group = ?,
        po_number = ?,
        date_ordered = ?,
        expected_delivery_date = ?,
        date_received = ?,
        ordered_by = ?,
        ordered_by_id = ?,
        status = ?,
        notes = ?,
        updated_at = ?,
        updated_by = ?
      WHERE id = ?
    `).run(
      orderData.customer_name,
      orderData.housecall_job_number,
      orderData.housecall_job_link,
      orderData.supplier,
      orderData.supplier_id || null,
      orderData.category,
      orderData.combined_group,
      orderData.po_number,
      orderData.date_ordered,
      orderData.expected_delivery_date,
      orderData.date_received,
      orderData.ordered_by || '',
      orderData.ordered_by_id || null,
      orderData.date_received ? 'Received' : 'Ordered',
      orderData.notes,
      now,
      'office-user',
      req.params.id
    );

    const updated = getDb().prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
    broadcastLiveEvent('orders', { action: 'updated', orderId: req.params.id, updatedAt: updated.updated_at, time: isoNow() });
    return res.json({
      order: {
        ...updated,
        status: statusFromOrder(updated),
        supplier: resolveSupplierDisplay(updated),
        ordered_by: resolveOrderedByDisplay(updated),
        is_overdue: updated.expected_delivery_date && updated.status === 'Ordered' && updated.expected_delivery_date < todayPhoenixString()
      }
    });
  } catch (error) {
    return res.status(500).json({ error: 'Unable to update the order.', details: error.message });
  }
});

app.post('/api/orders/:id/mark-received', (req, res) => {
  const existing = getDb().prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!existing) {
    return res.status(404).json({ error: 'Order not found.' });
  }

  const incomingVersion = (req.body.updated_at || req.body.version || '').toString();
  if (incomingVersion && incomingVersion !== existing.updated_at) {
    return res.status(409).json({
      error: 'This order changed elsewhere. Your draft was kept. Review the latest version and try again.'
    });
  }

  const receivedDate = normalizeText(req.body.date_received) || todayPhoenixString();
  const now = isoNow();
  getDb().prepare(
    'UPDATE orders SET date_received = ?, status = ?, updated_at = ?, updated_by = ? WHERE id = ?'
  ).run(receivedDate, 'Received', now, 'office-user', req.params.id);

  const updated = getDb().prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  broadcastLiveEvent('orders', { action: 'received', orderId: req.params.id, updatedAt: updated.updated_at, time: isoNow() });
  return res.json({ order: { ...updated, status: statusFromOrder(updated) } });
});

app.post('/api/orders/:id/reopen', (req, res) => {
  const existing = getDb().prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!existing) {
    return res.status(404).json({ error: 'Order not found.' });
  }

  const incomingVersion = (req.body.updated_at || req.body.version || '').toString();
  if (incomingVersion && incomingVersion !== existing.updated_at) {
    return res.status(409).json({
      error: 'This order changed elsewhere. Your draft was kept. Review the latest version and try again.'
    });
  }

  const now = isoNow();
  getDb().prepare(
    'UPDATE orders SET date_received = NULL, status = ?, updated_at = ?, updated_by = ? WHERE id = ?'
  ).run('Ordered', now, 'office-user', req.params.id);

  const updated = getDb().prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  broadcastLiveEvent('orders', { action: 'reopened', orderId: req.params.id, updatedAt: updated.updated_at, time: isoNow() });
  return res.json({ order: { ...updated, status: statusFromOrder(updated) } });
});

app.listen(port, () => {
  console.log(`Boulevard Glass Order Tracker listening at http://localhost:${port}`);
});
