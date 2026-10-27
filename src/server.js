import express from 'express';
import { createAccessMiddleware } from './access.js';
import { freeportRouter } from './freeport/routes.js';
import { initializeFreeport } from './freeport/store.js';
import { createPostgresSessionStore, configureSessionMiddleware } from './session-config.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import { createHash, randomUUID } from 'node:crypto';
import {
  resolveOrderSupplierAsync,
  getActiveSuppliersAsync,
  getAllSuppliersAsync,
  getAllStaffNamesAsync,
  initializeDatabase,
  upsertSupplierMasterRowAsync,
  upsertStaffMasterRowAsync,
  validateRuntimeDatabaseConfig,
  getPool,
  previewInactiveSupplierCleanup,
  deleteInactiveSupplierRecords,
  dbAll,
  dbGet,
  dbRun,
  runInTransaction
} from './db.js';
import { importStatements, parseOrderSheet } from './sheet-import.js';
import { HcpError, hcpApiConfigured } from './hcp/client.js';
import {
  handleHcpWebhook,
  hcpStatus,
  hcpSummary,
  hcpWebhookConfigured,
  refreshHcpJobSoon,
  resolveOrderHcpJobId,
  syncHcp,
  verifyWebhookSignature
} from './hcp/sync.js';
import {
  ORDER_CATEGORIES,
  getOrderGroup,
  groupOrdersByJob,
  isoNow,
  normalizeCategory,
  normalizeOrderInput,
  normalizeProgressInput,
  normalizeText,
  orderStage,
  PROGRESS_FIELDS,
  statusFromOrder,
  todayPhoenixString
} from './utils.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../public');
const isProduction = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';
const port = Number(process.env.APP_PORT || process.env.PORT || 3000);
const liveClients = new Set();
const VALID_DEPOSIT_STATUSES = [
  'Awaiting deposit',
  'Deposit received',
  'Deposit waived / not required'
];

validateRuntimeDatabaseConfig();
await initializeDatabase();
await initializeFreeport({ includePreviewInvoices: !isProduction && process.env.PREVIEW_MODE !== 'false' });

const app = express();
// Express 4 needs rejected route promises forwarded to its error middleware.
const asyncRoute = (handler) => (req, res, next) => Promise.resolve().then(() => handler(req, res, next)).catch(next);
app.get('/healthz', asyncRoute(async (req, res) => {
  try { await dbGet('SELECT 1'); res.json({ ok: true }); }
  catch { res.status(503).json({ ok: false }); }
}));
// Housecall Pro webhooks come from HCP's servers, not a signed-in browser,
// so they sit before the Cloudflare Access check and are authenticated by
// HCP's signature instead (docs/housecall-pro.md).
app.post('/api/hcp/webhooks', express.raw({ type: () => true, limit: '1mb' }), asyncRoute(async (req, res) => {
  if (!hcpWebhookConfigured()) {
    return res.status(503).json({ error: 'Housecall Pro webhooks are not set up.' });
  }
  const timestamp = req.get('Api-Timestamp');
  const signature = req.get('Api-Signature');
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  if (!verifyWebhookSignature({ secret: process.env.HCP_WEBHOOK_SECRET, timestamp, signature, rawBody })) {
    return res.status(401).json({ error: 'Invalid signature.' });
  }
  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid JSON.' });
  }
  const eventId = createHash('sha256').update(`${timestamp}.${signature}`).digest('hex');
  const result = await handleHcpWebhook(payload, { eventId });
  if (result.orderIds?.length) broadcastLiveEvent('orders', { action: 'housecall-pro', orderIds: result.orderIds });
  if (result.draftId) broadcastLiveEvent('job-drafts', { action: 'housecall-pro', draftId: result.draftId });
  return res.json({ received: true, outcome: result.outcome });
}));

if (isProduction) {
  app.use(createAccessMiddleware({ teamDomain: process.env.CF_ACCESS_TEAM_DOMAIN, audience: process.env.CF_ACCESS_AUD }));
}
const sessionStore = isProduction ? createPostgresSessionStore(await getPool()) : undefined;

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

app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '1mb' }));
configureSessionMiddleware(app, { store: sessionStore, isProduction });
if (isProduction) app.use((req, res, next) => {
  req.session.user = req.accessUser;
  next();
});

app.get('/', (req, res) => req.session.user ? res.sendFile(path.join(publicDir, '../views/tools.html')) : res.redirect('/login'));
app.get(['/tools.html', '/freeport.html'], (req, res) => req.session.user ? res.sendFile(path.join(publicDir, '../views', req.path.slice(1))) : res.redirect('/login'));
app.use(express.static(publicDir, { index: false }));

function requireStaffAuth(req, res, next) {
  if (!req.session || !req.session.user || !req.session.user.username) {
    return res.status(401).json({ error: 'Staff authentication required.' });
  }

  next();
}

// The signed-in staff email in production; the local login name in development.
function actor(req) {
  return req.session?.user?.username || 'office-user';
}

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

async function getJobDraftById(id) {
  const draftId = normalizeText(id || '');
  if (!draftId) {
    return null;
  }

  return (await dbGet('SELECT * FROM job_drafts WHERE id = ?', [draftId])) || null;
}

function isDraftReadyForOrdering(draft) {
  if (!draft) return false;
  return draft.status !== 'Completed' && draft.deposit_status !== 'Awaiting deposit';
}

async function serializeJobDraft(draft, knownOrderCount) {
  if (!draft) return null;

  const supplierOrderCount = knownOrderCount ?? Number((await dbGet('SELECT COUNT(*) as count FROM orders WHERE job_draft_id = ? AND is_archived = 0', [draft.id]))?.count || 0);

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

async function getActiveOrdersForDraft(draftId) {
  const rows = await dbAll('SELECT id, customer_name, supplier, po_number, status FROM orders WHERE job_draft_id = ? AND is_archived = 0 ORDER BY date_ordered DESC, created_at DESC', [draftId]);

  return rows.map((order) => ({
    id: order.id,
    customer_name: order.customer_name,
    supplier: order.supplier,
    po_number: order.po_number,
    status: order.status || 'Ordered'
  }));
}

async function markOrdersArchived(orderIds, metadata = {}) {
  if (!Array.isArray(orderIds) || !orderIds.length) {
    return [];
  }

  const stamp = metadata.stamp || isoNow();
  const source = normalizeArchiveSource(metadata.source || 'manual');
  const reason = (metadata.reason || '').trim();
  const uniqueIds = [...new Set(orderIds.map((id) => normalizeText(id || '')).filter(Boolean))];
  if (!uniqueIds.length) {
    return [];
  }

  const placeholders = uniqueIds.map(() => '?').join(', ');
  await dbRun(`UPDATE orders SET is_archived = 1, archived_at = ?, archive_source = ?, archive_reason = ? WHERE id IN (${placeholders})`, [stamp, source, reason, ...uniqueIds]);
  return uniqueIds;
}

async function markDraftsArchived(draftIds, metadata = {}) {
  if (!Array.isArray(draftIds) || !draftIds.length) {
    return [];
  }

  const stamp = metadata.stamp || isoNow();
  const source = normalizeArchiveSource(metadata.source || 'manual');
  const reason = (metadata.reason || '').trim();
  const uniqueIds = [...new Set(draftIds.map((id) => normalizeText(id || '')).filter(Boolean))];
  if (!uniqueIds.length) {
    return [];
  }

  const placeholders = uniqueIds.map(() => '?').join(', ');
  await dbRun(`UPDATE job_drafts SET is_archived = 1, archived_at = ?, archive_source = ?, archive_reason = ? WHERE id IN (${placeholders})`, [stamp, source, reason, ...uniqueIds]);
  return uniqueIds;
}

async function restoreOrders(orderIds) {
  if (!Array.isArray(orderIds) || !orderIds.length) {
    return [];
  }

  const uniqueIds = [...new Set(orderIds.map((id) => normalizeText(id || '')).filter(Boolean))];
  if (!uniqueIds.length) {
    return [];
  }

  const placeholders = uniqueIds.map(() => '?').join(', ');
  await dbRun(`UPDATE orders SET is_archived = 0, archived_at = NULL, archive_source = NULL, archive_reason = NULL WHERE id IN (${placeholders})`, uniqueIds);
  return uniqueIds;
}

async function restoreDrafts(draftIds) {
  if (!Array.isArray(draftIds) || !draftIds.length) {
    return [];
  }

  const uniqueIds = [...new Set(draftIds.map((id) => normalizeText(id || '')).filter(Boolean))];
  if (!uniqueIds.length) {
    return [];
  }

  const placeholders = uniqueIds.map(() => '?').join(', ');
  await dbRun(`UPDATE job_drafts SET is_archived = 0, archived_at = NULL, archive_source = NULL, archive_reason = NULL WHERE id IN (${placeholders})`, uniqueIds);
  return uniqueIds;
}

app.get('/api/tools', requireStaffAuth, asyncRoute(async (req, res) => {
  const { readFile } = await import('node:fs/promises');
  res.json(JSON.parse(await readFile(path.join(publicDir, 'tools.json'), 'utf8')));
}));
app.use('/api/freeport', freeportRouter({ requireStaffAuth, requireAdminAuth }));
app.get(['/freeport', '/freeport/*'], (req, res) => req.session.user ? res.sendFile(path.join(publicDir, '../views/freeport.html')) : res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`));
app.get('/login', (req, res) => res.sendFile(path.join(publicDir, 'login.html')));
app.get('/app', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

app.post('/api/login', asyncRoute(async (req, res) => {
  if (isProduction) return res.json({ success: true, user: req.accessUser });
  const username = normalizeText(req.body.username);
  const password = normalizeText(req.body.password);

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  const user = await dbGet('SELECT * FROM users WHERE username = ?', [username]);
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

  return res.json({ success: true, user: req.session.user });
}));

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

async function resolveSupplierDisplay(order) {
  const supplierId = normalizeText(order.supplier_id || '');
  if (supplierId) {
    const supplier = await dbGet('SELECT name FROM suppliers WHERE id = ?', [supplierId]);
    if (supplier && supplier.name) {
      return supplier.name;
    }
  }

  return normalizeText(order.supplier || '');
}

async function resolveOrderedByDisplay(order) {
  const orderedById = normalizeText(order.ordered_by_id || '');
  if (orderedById) {
    const staff = await dbGet('SELECT name FROM staff_names WHERE id = ?', [orderedById]);
    if (staff && staff.name) {
      return staff.name;
    }
  }

  return normalizeText(order.ordered_by || '');
}

app.get('/api/suppliers', asyncRoute(async (req, res) => {
  const suppliers = await getActiveSuppliersAsync();
  return res.json({ suppliers: suppliers.map((item) => item.name) });
}));

app.get('/api/master-lists', asyncRoute(async (req, res) => {
  const suppliers = await getAllSuppliersAsync();
  const staffNames = await getAllStaffNamesAsync();
  const historicalSuppliers = await dbAll("SELECT supplier, COUNT(*) AS order_count FROM orders WHERE (supplier_id IS NULL OR supplier_id = '') AND supplier IS NOT NULL AND supplier <> '' GROUP BY supplier ORDER BY supplier");
  const knownSupplierNames = new Set(suppliers.map(item => item.name.trim().toLowerCase()));

  return res.json({
    suppliers: suppliers.map((item) => ({ id: item.id, name: item.name, active: Number(item.active) !== 0 })),
    staff_names: staffNames.map((item) => ({ id: item.id, name: item.name, active: Number(item.active) !== 0 })),
    ordered_by_options: staffNames.map(item => item.name),
    historical_suppliers: historicalSuppliers.filter(item => !knownSupplierNames.has(item.supplier.trim().toLowerCase())).map(item => ({ name: item.supplier, order_count: Number(item.order_count) })),
    supplier_filter_options: [
      ...suppliers.map(item => ({ id: item.id, name: item.name, active: Number(item.active) !== 0 })),
      ...historicalSuppliers.filter(item => !knownSupplierNames.has(item.supplier.trim().toLowerCase())).map(item => ({ id: '', name: item.supplier, historical: true }))
    ]
  });
}));

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

app.get('/api/job-drafts', asyncRoute(async (req, res) => {
  const statusFilter = normalizeText(req.query.status || '');
  const archivedOnly = req.query.archived === 'true' || statusFilter === 'Archived';
  const rows = statusFilter === 'Archived'
    ? await dbAll('SELECT * FROM job_drafts WHERE is_archived = 1 ORDER BY archived_at DESC, updated_at DESC')
    : statusFilter
      ? await dbAll('SELECT * FROM job_drafts WHERE status = ? AND is_archived = ? ORDER BY updated_at DESC, created_at DESC', [statusFilter, archivedOnly ? 1 : 0])
      : await dbAll('SELECT * FROM job_drafts WHERE is_archived = ? ORDER BY updated_at DESC, created_at DESC', [archivedOnly ? 1 : 0]);

  const counts = await dbAll('SELECT job_draft_id, COUNT(*) AS count FROM orders WHERE is_archived = 0 AND job_draft_id IS NOT NULL GROUP BY job_draft_id');
  const countByDraft = new Map(counts.map(row => [row.job_draft_id, Number(row.count)]));
  return res.json({ drafts: await Promise.all(rows.map(row => serializeJobDraft(row, countByDraft.get(row.id) || 0))) });
}));

app.post('/api/job-drafts', requireStaffAuth, asyncRoute(async (req, res) => {
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
  await dbRun(`
    INSERT INTO job_drafts (
      id, customer_name, housecall_job_number, housecall_job_link, hcp_job_id, notes,
      deposit_status, status, created_at, updated_at, created_by, updated_by, is_preview_data
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `, [
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
    actor(req),
    actor(req)
  ]);

  const draft = await serializeJobDraft(await getJobDraftById(id));
  broadcastLiveEvent('job-drafts', { action: 'created', draftId: id, time: isoNow() });
  return res.status(201).json({ draft });
}));

app.put('/api/job-drafts/:id', requireStaffAuth, asyncRoute(async (req, res) => {
  const draft = await getJobDraftById(req.params.id);
  if (!draft) {
    return res.status(404).json({ error: 'Job draft not found.' });
  }

  if (!req.body.updated_at) {
    return res.status(400).json({ error: 'Refresh the page and try again.' });
  }

  // A field that is sent replaces the saved value, even when it is blank.
  const field = key => (Object.hasOwn(req.body, key) ? req.body[key] : draft[key]);
  const draftData = {
    customer_name: normalizeText(field('customer_name')),
    housecall_job_number: normalizeText(field('housecall_job_number')),
    housecall_job_link: normalizeText(field('housecall_job_link')),
    hcp_job_id: normalizeText(field('hcp_job_id')),
    notes: typeof req.body.notes === 'string' ? req.body.notes.trim() : (draft.notes || ''),
    deposit_status: normalizeDraftDepositStatus(field('deposit_status')),
    status: normalizeText(field('status')) || 'Open'
  };

  if (!draftData.customer_name) {
    return res.status(400).json({ error: 'Customer name is required.' });
  }

  const now = isoNow();
  const result = await dbRun(`
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
    WHERE id = ? AND updated_at = ?
  `, [
    draftData.customer_name,
    draftData.housecall_job_number,
    draftData.housecall_job_link,
    draftData.hcp_job_id,
    draftData.notes,
    draftData.deposit_status,
    draftData.status === 'Completed' ? 'Completed' : 'Open',
    now,
    actor(req),
    req.params.id,
    String(req.body.updated_at)
  ]);
  if (!result.changes) {
    return res.status(409).json({ error: 'Someone else changed this job. Close this window to see their changes, then try again.' });
  }

  const updated = await serializeJobDraft(await getJobDraftById(req.params.id));
  broadcastLiveEvent('job-drafts', { action: 'updated', draftId: req.params.id, time: isoNow() });
  return res.json({ draft: updated });
}));

app.post('/api/job-drafts/:id/complete', requireStaffAuth, asyncRoute(async (req, res) => {
  const draft = await getJobDraftById(req.params.id);
  if (!draft) {
    return res.status(404).json({ error: 'Job draft not found.' });
  }

  const now = isoNow();
  await dbRun('UPDATE job_drafts SET status = ?, updated_at = ?, updated_by = ? WHERE id = ?', ['Completed', now, actor(req), req.params.id]);
  const updated = await serializeJobDraft(await getJobDraftById(req.params.id));
  broadcastLiveEvent('job-drafts', { action: 'completed', draftId: req.params.id, time: isoNow() });
  return res.json({ draft: updated });
}));

app.post('/api/job-drafts/:id/delete', requireStaffAuth, asyncRoute(async (req, res) => {
  const draft = await getJobDraftById(req.params.id);
  if (!draft) {
    return res.status(404).json({ error: 'Job not found.' });
  }

  const linkedOrders = await getActiveOrdersForDraft(draft.id);
  const metadata = { stamp: isoNow(), reason: `Deleted by ${actor(req)}` };
  await markDraftsArchived([draft.id], metadata);
  const deletedOrderIds = await markOrdersArchived(linkedOrders.map((order) => order.id), metadata);

  broadcastLiveEvent('job-drafts', { action: 'deleted', draftId: draft.id, time: isoNow() });
  broadcastLiveEvent('orders', { action: 'deleted', orderIds: deletedOrderIds, time: isoNow() });
  return res.json({ deleted: true, draft_id: draft.id, order_ids: deletedOrderIds });
}));

// Undo for a deleted job: brings back the job and only the orders deleted with it.
app.post('/api/job-drafts/:id/restore', requireStaffAuth, asyncRoute(async (req, res) => {
  const draft = await getJobDraftById(req.params.id);
  if (!draft) {
    return res.status(404).json({ error: 'Job not found.' });
  }

  const deletedWithJob = draft.archived_at
    ? (await dbAll('SELECT id FROM orders WHERE job_draft_id = ? AND is_archived = 1 AND archived_at = ?', [draft.id, draft.archived_at])).map((row) => row.id)
    : [];
  const restoredDraftIds = await restoreDrafts([draft.id]);
  await restoreOrders(deletedWithJob);

  broadcastLiveEvent('job-drafts', { action: 'restored', draftId: draft.id, time: isoNow() });
  broadcastLiveEvent('orders', { action: 'restored', orderIds: deletedWithJob, time: isoNow() });
  return res.json({ restored: restoredDraftIds.length > 0, draft_id: draft.id, order_ids: deletedWithJob });
}));

app.post('/api/job-drafts/:id/reopen', requireStaffAuth, asyncRoute(async (req, res) => {
  const draft = await getJobDraftById(req.params.id);
  if (!draft) {
    return res.status(404).json({ error: 'Job draft not found.' });
  }

  const now = isoNow();
  await dbRun('UPDATE job_drafts SET status = ?, updated_at = ?, updated_by = ? WHERE id = ?', ['Open', now, actor(req), req.params.id]);
  const updated = await serializeJobDraft(await getJobDraftById(req.params.id));
  broadcastLiveEvent('job-drafts', { action: 'reopened', draftId: req.params.id, time: isoNow() });
  return res.json({ draft: updated });
}));

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
  req.session.user = {
    id: `admin:${adminUsername}`,
    username: adminUsername,
    full_name: 'Office Admin'
  };
  return res.json({ success: true, admin: req.session.admin, user: req.session.user });
});

app.post('/api/admin/logout', (req, res) => {
  req.session.admin = null;
  return res.json({ success: true });
});

app.get('/api/admin/inactive-suppliers/preview', requireAdminAuth, asyncRoute(async (req, res) => {
  const includeHistorical = req.query.include_historical === 'true';
  const plan = await previewInactiveSupplierCleanup(includeHistorical);
  const confirmationToken = randomUUID();
  req.session.supplierCleanupPreview = { fingerprint: plan.fingerprint, includeHistorical, token: confirmationToken, expires: Date.now() + 15 * 60 * 1000 };
  return res.json({ suppliers: plan.suppliers, supplier_count: plan.supplier_count, historical_suppliers: plan.historical_suppliers, historical_supplier_count: plan.historical_supplier_count, order_count: plan.order_count, confirmation_token: confirmationToken });
}));

app.post('/api/admin/inactive-suppliers/delete', requireAdminAuth, asyncRoute(async (req, res) => {
  const preview = req.session.supplierCleanupPreview;
  if (!preview || preview.expires < Date.now() || req.body.confirmation_token !== preview.token || req.body.confirmation !== 'DELETE') {
    return res.status(409).json({ error: 'Preview the cleanup and type DELETE to confirm.' });
  }
  try {
    const result = await deleteInactiveSupplierRecords(preview.fingerprint, preview.includeHistorical === true);
    delete req.session.supplierCleanupPreview;
    broadcastLiveEvent('master-lists', { collection: 'suppliers', action: 'deleted' });
    broadcastLiveEvent('orders', { action: 'deleted' });
    return res.json(result);
  } catch (error) {
    if (error.code === 'CLEANUP_CHANGED') {
      delete req.session.supplierCleanupPreview;
      return res.status(409).json({ error: error.message });
    }
    throw error;
  }
}));

app.post('/api/master-lists/suppliers', requireAdminAuth, asyncRoute(async (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  const saved = (await Promise.all(items.map((item) => upsertSupplierMasterRowAsync({ id: item.id || '', name: item.name, active: item.active !== false }))))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  broadcastLiveEvent('master-lists', { collection: 'suppliers', action: 'updated', count: saved.length, time: isoNow() });
  return res.json({ suppliers: saved.map((item) => ({ id: item.id, name: item.name, active: Number(item.active) !== 0 })) });
}));

app.post('/api/master-lists/ordered-by', requireAdminAuth, asyncRoute(async (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  const saved = (await Promise.all(items.map((item) => upsertStaffMasterRowAsync({ id: item.id || '', name: item.name, active: item.active !== false }))))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  broadcastLiveEvent('master-lists', { collection: 'ordered_by', action: 'updated', count: saved.length, time: isoNow() });
  return res.json({ staff_names: saved.map((item) => ({ id: item.id, name: item.name, active: Number(item.active) !== 0 })) });
}));

app.post('/api/orders/:id/delete', requireStaffAuth, asyncRoute(async (req, res) => {
  const order = await dbGet('SELECT id FROM orders WHERE id = ?', [req.params.id]);
  if (!order) {
    return res.status(404).json({ error: 'Order not found.' });
  }

  await markOrdersArchived([order.id], { reason: `Deleted by ${actor(req)}` });
  broadcastLiveEvent('orders', { action: 'deleted', orderIds: [order.id], time: isoNow() });
  return res.json({ deleted: true, order_id: order.id });
}));

// Undo for a deleted order. Its job comes back too if the job had been deleted.
app.post('/api/orders/:id/restore', requireStaffAuth, asyncRoute(async (req, res) => {
  const order = await dbGet('SELECT * FROM orders WHERE id = ?', [req.params.id]);
  if (!order) {
    return res.status(404).json({ error: 'Order not found.' });
  }

  const restoredIds = await restoreOrders([order.id]);
  if (order.job_draft_id) {
    const linkedDraft = await getJobDraftById(order.job_draft_id);
    if (linkedDraft && Number(linkedDraft.is_archived) === 1) {
      await restoreDrafts([linkedDraft.id]);
      broadcastLiveEvent('job-drafts', { action: 'restored', draftId: linkedDraft.id, time: isoNow() });
    }
  }

  broadcastLiveEvent('orders', { action: 'restored', orderId: order.id, time: isoNow() });
  return res.json({ restored: restoredIds.length > 0, order_id: order.id });
}));

app.get('/api/orders', asyncRoute(async (req, res) => {
  const [storedRows, suppliers, staffNames, hcpRows] = await Promise.all([
    dbAll('SELECT * FROM orders ORDER BY date_ordered DESC, created_at DESC'),
    getAllSuppliersAsync(), getAllStaffNamesAsync(),
    dbAll('SELECT * FROM hcp_jobs')
  ]);
  const hcpJobById = new Map(hcpRows.map(row => [row.id, row]));
  const supplierById = new Map(suppliers.map(item => [item.id, item]));
  const staffById = new Map(staffNames.map(item => [item.id, item]));
  const normalizeFilter = value => String(value || '').trim().toLowerCase();
  const matchesFilter = (order, values, idField, nameField, masterRows, byId) => !values.length || values.some(value => {
    const master = byId.get(value) || masterRows.find(item => normalizeFilter(item.name) === normalizeFilter(value));
    if (master && order[idField]) return order[idField] === master.id;
    return normalizeFilter(order[nameField]) === normalizeFilter(master?.name || value);
  });
  const rows = storedRows.map(order => ({
    ...order,
    supplier: supplierById.get(order.supplier_id)?.name || order.supplier,
    ordered_by: staffById.get(order.ordered_by_id)?.name || order.ordered_by
  }));

  // How many of each job's orders have arrived, so the labor meeting only
  // sees jobs with everything in the shop.
  const activeRows = rows.filter(order => Number(order.is_archived || 0) !== 1);
  const groupOf = groupOrdersByJob(activeRows);
  const jobTotals = new Map();
  for (const order of activeRows) {
    const totals = jobTotals.get(groupOf.get(order.id)) || { orders: 0, received: 0 };
    totals.orders += 1;
    if (order.date_received) totals.received += 1;
    jobTotals.set(groupOf.get(order.id), totals);
  }
  const jobInfo = (order) => {
    const totals = jobTotals.get(groupOf.get(order.id)) || { orders: 1, received: order.date_received ? 1 : 0 };
    return { job_group: groupOf.get(order.id) || order.id, job_order_count: totals.orders, job_received_count: totals.received, job_ready: totals.received === totals.orders };
  };

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
    if (statusFilter === 'To Schedule' && !(status === 'Received' && jobInfo(order).job_ready && !Number(order.job_scheduled) && !Number(order.job_completed))) return false;
    if (statusFilter === 'Scheduled' && !(Number(order.job_scheduled) && !Number(order.job_completed))) return false;
    if (statusFilter === 'Need Invoice' && !(Number(order.job_completed) && !Number(order.invoiced))) return false;

    if (viewFilter === 'Windows / Flat Glass' && !['Windows / Flat Glass'].includes(resolvedGroup)) {
      return false;
    }
    if (viewFilter === 'Heavy Glass / Storefront' && !['Heavy Glass / Storefront'].includes(resolvedGroup)) {
      return false;
    }

    if (categoryFilter && order.category !== categoryFilter) {
      return false;
    }

    if (!matchesFilter(order, supplierFilters, 'supplier_id', 'supplier', suppliers, supplierById)) {
      return false;
    }

    if (!matchesFilter(order, orderedByFilters, 'ordered_by_id', 'ordered_by', staffNames, staffById)) return false;

    if (searchTerm) {
      const haystack = [order.customer_name, order.housecall_job_number, order.supplier, order.po_number, order.category || '', resolvedGroup, order.shop_location, order.schedule_note, order.invoice_reference].join(' ').toLowerCase();
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

    if (sortKey === 'scheduled_date') {
      const aDate = a.scheduled_date || '9999-12-31';
      const bDate = b.scheduled_date || '9999-12-31';
      return aDate.localeCompare(bDate) || String(a.customer_name || '').localeCompare(String(b.customer_name || '')) || String(a.id || '').localeCompare(String(b.id || ''));
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
    ...jobInfo(order),
    category: order.category || '',
    combined_group: order.category ? getOrderGroup(order.category) : (order.combined_group || ''),
    status: statusFromOrder(order),
    stage: orderStage(order),
    hcp: hcpSummary(hcpJobById.get(order.hcp_job_id)),
    job_scheduled: Number(order.job_scheduled || 0),
    job_completed: Number(order.job_completed || 0),
    invoiced: Number(order.invoiced || 0),
    is_overdue: order.expected_delivery_date && order.status === 'Ordered' && order.expected_delivery_date < todayPhoenixString()
  }));

  return res.json({ orders: normalized });
}));

app.post('/api/orders', requireStaffAuth, asyncRoute(async (req, res) => {
  const orderData = normalizeOrderInput(req.body);
  const draftId = normalizeText(req.body.job_draft_id || '');

  if (draftId) {
    const draft = await getJobDraftById(draftId);
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

  if (!orderData.customer_name) return res.status(400).json({ error: 'Customer name is required.' });
  if (!orderData.supplier && !orderData.supplier_id) return res.status(400).json({ error: 'Supplier is required.' });
  if (!orderData.category) return res.status(400).json({ error: 'Category is required.' });
  if (!orderData.ordered_by) return res.status(400).json({ error: 'Ordered by is required.' });

  const supplierRecord = await resolveOrderSupplierAsync(orderData);
  if (!supplierRecord) {
    return res.status(400).json({ error: 'Select an active supplier from Master Lists.' });
  }

  orderData.supplier = supplierRecord.name;
  orderData.supplier_id = supplierRecord.id;
  orderData.category = normalizeCategory(orderData.category);
  orderData.combined_group = getOrderGroup(orderData.category);

  if (!orderData.category) {
    return res.status(400).json({ error: 'Category is required.' });
  }
  const hcpJobId = await resolveOrderHcpJobId({ link: orderData.housecall_job_link, number: orderData.housecall_job_number, draftId: orderData.job_draft_id });

  const orderId = `order-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const now = isoNow();

  await dbRun(`
    INSERT INTO orders (
      id, customer_name, housecall_job_number, housecall_job_link, supplier, supplier_id, category, combined_group,
      po_number, date_ordered, expected_delivery_date, date_received, ordered_by, ordered_by_id, status, notes, job_draft_id,
      created_at, updated_at, created_by, updated_by, is_preview_data, shop_location, hcp_job_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `, [
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
    actor(req),
    actor(req),
    orderData.shop_location,
    hcpJobId || null
  ]);

  const created = await dbGet('SELECT * FROM orders WHERE id = ?', [orderId]);
  broadcastLiveEvent('orders', { action: 'created', orderId, updatedAt: created.updated_at, time: isoNow() });
  refreshHcpJobSoon(hcpJobId, (orderIds) => broadcastLiveEvent('orders', { action: 'housecall-pro', orderIds }));
  return res.status(201).json({
    order: {
      ...created,
      status: statusFromOrder(created),
      supplier: await resolveSupplierDisplay(created),
      ordered_by: await resolveOrderedByDisplay(created)
    }
  });
}));

app.put('/api/orders/:id', requireStaffAuth, asyncRoute(async (req, res) => {
  const existing = await dbGet('SELECT * FROM orders WHERE id = ?', [req.params.id]);
  if (!existing) {
    return res.status(404).json({ error: 'Order not found.' });
  }

  const incomingVersion = (req.body.updated_at || '').toString();
  if (!incomingVersion) {
    return res.status(400).json({ error: 'Refresh the page and try again.' });
  }

  const orderData = normalizeOrderInput(req.body);
  if (!orderData.customer_name) return res.status(400).json({ error: 'Customer name is required.' });
  if (!orderData.supplier && !orderData.supplier_id) return res.status(400).json({ error: 'Supplier is required.' });
  if (!orderData.category) return res.status(400).json({ error: 'Category is required.' });
  if (!orderData.ordered_by) return res.status(400).json({ error: 'Ordered by is required.' });

  const supplierRecord = await resolveOrderSupplierAsync(orderData, existing);
  if (!supplierRecord) {
    return res.status(400).json({ error: 'Select an active supplier from Master Lists.' });
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
  const sameJob = String(existing.housecall_job_number || '').trim().toLowerCase() === orderData.housecall_job_number.toLowerCase()
    && String(existing.housecall_job_link || '') === orderData.housecall_job_link;
  const hcpJobId = await resolveOrderHcpJobId({ link: orderData.housecall_job_link, number: orderData.housecall_job_number, draftId: existing.job_draft_id, keep: sameJob ? existing.hcp_job_id : '' });

  const now = isoNow();
  const result = await dbRun(`
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
      shop_location = ?,
      hcp_job_id = ?,
      updated_at = ?,
      updated_by = ?
    WHERE id = ? AND updated_at = ?
  `, [
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
    orderData.shop_location,
    hcpJobId || null,
    now,
    actor(req),
    req.params.id,
    incomingVersion
  ]);
  if (!result.changes) {
    return res.status(409).json({ error: 'Someone else changed this order. Close this window to see their changes, then try again.' });
  }

  const updated = await dbGet('SELECT * FROM orders WHERE id = ?', [req.params.id]);
  broadcastLiveEvent('orders', { action: 'updated', orderId: req.params.id, updatedAt: updated.updated_at, time: isoNow() });
  if (hcpJobId && hcpJobId !== existing.hcp_job_id) refreshHcpJobSoon(hcpJobId, (orderIds) => broadcastLiveEvent('orders', { action: 'housecall-pro', orderIds }));
  return res.json({
    order: {
      ...updated,
      status: statusFromOrder(updated),
      supplier: await resolveSupplierDisplay(updated),
      ordered_by: await resolveOrderedByDisplay(updated),
      is_overdue: updated.expected_delivery_date && updated.status === 'Ordered' && updated.expected_delivery_date < todayPhoenixString()
    }
  });
}));

function progressValues(row) {
  return {
    job_scheduled: Number(row.job_scheduled || 0),
    scheduled_date: row.scheduled_date || '',
    schedule_note: row.schedule_note || '',
    job_completed: Number(row.job_completed || 0),
    completed_date: row.completed_date || '',
    invoiced: Number(row.invoiced || 0),
    invoice_reference: row.invoice_reference || ''
  };
}

const progressAssignments = PROGRESS_FIELDS.map((field) => `${field} = ?`).join(', ');

// Saves Scheduled / Complete / Invoiced for the whole job (every active order
// on it) and the shop location for this order, in one transaction. Returns
// the previous values so the screen can undo exactly.
app.put('/api/orders/:id/progress', requireStaffAuth, asyncRoute(async (req, res) => {
  const order = await dbGet('SELECT * FROM orders WHERE id = ? AND is_archived = 0', [req.params.id]);
  if (!order) {
    return res.status(404).json({ error: 'Order not found.' });
  }
  const version = String(req.body.updated_at || '');
  if (!version) {
    return res.status(400).json({ error: 'Refresh the page and try again.' });
  }

  const progress = normalizeProgressInput(req.body);
  const shopLocation = Object.hasOwn(req.body, 'shop_location') ? normalizeText(req.body.shop_location) : (order.shop_location || '');
  const active = await dbAll('SELECT * FROM orders WHERE is_archived = 0');
  const groupOf = groupOrdersByJob(active);
  const siblings = active.filter((row) => row.id !== order.id && groupOf.get(row.id) === groupOf.get(order.id));
  const now = isoNow();
  const values = PROGRESS_FIELDS.map((field) => progress[field]);
  try {
    await runInTransaction([
      { sql: `UPDATE orders SET ${progressAssignments}, shop_location = ?, updated_at = ?, updated_by = ? WHERE id = ? AND updated_at = ?`, params: [...values, shopLocation, now, actor(req), order.id, version], expect: 1 },
      ...siblings.map((row) => ({ sql: `UPDATE orders SET ${progressAssignments}, updated_at = ?, updated_by = ? WHERE id = ? AND updated_at = ?`, params: [...values, now, actor(req), row.id, row.updated_at], expect: 1 }))
    ]);
  } catch (error) {
    if (error.code === 'STATEMENT_EXPECTATION') {
      return res.status(409).json({ error: 'Someone else changed this job. Close this window to see their changes, then try again.' });
    }
    throw error;
  }

  const orderIds = [order.id, ...siblings.map((row) => row.id)];
  broadcastLiveEvent('orders', { action: 'progress', orderIds, time: isoNow() });
  return res.json({
    order_ids: orderIds,
    updated_at: now,
    previous: [{ id: order.id, shop_location: order.shop_location || '', ...progressValues(order) }, ...siblings.map((row) => ({ id: row.id, ...progressValues(row) }))]
  });
}));

// Undo for a progress save: puts back each order's previous values, as long
// as nobody has changed those orders since.
app.post('/api/order-progress/restore', requireStaffAuth, asyncRoute(async (req, res) => {
  const items = Array.isArray(req.body.items) ? req.body.items.filter((item) => item && typeof item.id === 'string') : [];
  const version = String(req.body.updated_at || '');
  if (!items.length || !version) {
    return res.status(400).json({ error: 'Nothing to undo.' });
  }

  const now = isoNow();
  try {
    await runInTransaction(items.map((item) => {
      const progress = normalizeProgressInput(item, { fillCompletedDate: false });
      const restoreShop = Object.hasOwn(item, 'shop_location');
      return {
        sql: `UPDATE orders SET ${progressAssignments}${restoreShop ? ', shop_location = ?' : ''}, updated_at = ?, updated_by = ? WHERE id = ? AND updated_at = ?`,
        params: [...PROGRESS_FIELDS.map((field) => progress[field]), ...(restoreShop ? [normalizeText(item.shop_location)] : []), now, actor(req), item.id, version],
        expect: 1
      };
    }));
  } catch (error) {
    if (error.code === 'STATEMENT_EXPECTATION') {
      return res.status(409).json({ error: 'Someone changed this job after you did.' });
    }
    throw error;
  }

  broadcastLiveEvent('orders', { action: 'progress-restored', orderIds: items.map((item) => item.id), time: isoNow() });
  return res.json({ restored: items.length });
}));

app.post('/api/orders/:id/mark-received', requireStaffAuth, asyncRoute(async (req, res) => {
  const existing = await dbGet('SELECT * FROM orders WHERE id = ?', [req.params.id]);
  if (!existing) {
    return res.status(404).json({ error: 'Order not found.' });
  }

  const incomingVersion = (req.body?.updated_at || '').toString();
  const receivedDate = normalizeText(req.body?.date_received) || todayPhoenixString();
  const now = isoNow();
  const result = await dbRun(`UPDATE orders SET date_received = ?, status = ?, updated_at = ?, updated_by = ? WHERE id = ?${incomingVersion ? ' AND updated_at = ?' : ''}`, [receivedDate, 'Received', now, actor(req), req.params.id, ...(incomingVersion ? [incomingVersion] : [])]);
  if (!result.changes) {
    return res.status(409).json({ error: 'Someone else changed this order. Refresh and try again.' });
  }

  const updated = await dbGet('SELECT * FROM orders WHERE id = ?', [req.params.id]);
  broadcastLiveEvent('orders', { action: 'received', orderId: req.params.id, updatedAt: updated.updated_at, time: isoNow() });
  return res.json({ order: { ...updated, status: statusFromOrder(updated) } });
}));

app.post('/api/orders/:id/reopen', requireStaffAuth, asyncRoute(async (req, res) => {
  const existing = await dbGet('SELECT * FROM orders WHERE id = ?', [req.params.id]);
  if (!existing) {
    return res.status(404).json({ error: 'Order not found.' });
  }

  const incomingVersion = (req.body?.updated_at || '').toString();
  const now = isoNow();
  const result = await dbRun(`UPDATE orders SET date_received = NULL, status = ?, updated_at = ?, updated_by = ? WHERE id = ?${incomingVersion ? ' AND updated_at = ?' : ''}`, ['Ordered', now, actor(req), req.params.id, ...(incomingVersion ? [incomingVersion] : [])]);
  if (!result.changes) {
    return res.status(409).json({ error: 'Someone else changed this order. Refresh and try again.' });
  }

  const updated = await dbGet('SELECT * FROM orders WHERE id = ?', [req.params.id]);
  broadcastLiveEvent('orders', { action: 'reopened', orderId: req.params.id, updatedAt: updated.updated_at, time: isoNow() });
  return res.json({ order: { ...updated, status: statusFromOrder(updated) } });
}));

app.get('/api/hcp/status', requireAdminAuth, asyncRoute(async (req, res) => res.json(await hcpStatus())));

app.post('/api/hcp/sync', requireAdminAuth, asyncRoute(async (req, res) => {
  if (!hcpApiConfigured()) {
    return res.status(503).json({ error: "Housecall Pro isn't connected. Add HCP_API_KEY to the server settings." });
  }
  try {
    const result = await syncHcp();
    if (result.order_ids.length) broadcastLiveEvent('orders', { action: 'housecall-pro', orderIds: result.order_ids });
    return res.json(result);
  } catch (error) {
    if (error instanceof HcpError) return res.status(502).json({ error: error.message });
    throw error;
  }
}));

// One-time import from the office's Google Sheet, downloaded as .xlsx.
// Preview parses the file and keeps the plan for 30 minutes; nothing is
// written until the admin confirms with IMPORT (add) or REPLACE.
const sheetImports = new Map();

app.post('/api/admin/sheet-import/preview', requireAdminAuth, express.raw({ type: () => true, limit: '25mb' }), asyncRoute(async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) {
    return res.status(400).json({ error: 'Choose the sheet file (.xlsx) first.' });
  }
  let plan;
  try {
    plan = await parseOrderSheet(req.body, { today: todayPhoenixString() });
  } catch {
    return res.status(400).json({ error: 'That file is not the order sheet. In Google Sheets use File > Download > Microsoft Excel (.xlsx).' });
  }

  for (const [token, entry] of sheetImports) if (entry.expires < Date.now()) sheetImports.delete(token);
  const token = randomUUID();
  sheetImports.set(token, { plan, expires: Date.now() + 30 * 60 * 1000 });
  const count = async (sql) => Number((await dbGet(sql))?.count || 0);
  const existingSuppliers = (await dbAll('SELECT name FROM suppliers')).map((row) => row.name.trim().toLowerCase());
  const existingStaff = (await dbAll('SELECT name FROM staff_names')).map((row) => row.name.trim().toLowerCase());
  return res.json({
    token,
    tabs: plan.tabs,
    orders: plan.orders.map((order) => ({
      tab: order.tab, row: order.row, customer_name: order.customer_name, supplier: order.supplier, category: order.category,
      date_ordered: order.date_ordered, date_received: order.date_received, job_scheduled: order.job_scheduled,
      job_completed: order.job_completed, invoiced: order.invoiced, housecall_job_number: order.housecall_job_number
    })),
    jobs: plan.jobs.length,
    suppliers: plan.suppliers.map((name) => ({ name, existing: existingSuppliers.includes(name.trim().toLowerCase()) })),
    staff: plan.staff.map((name) => ({ name, existing: existingStaff.includes(name.trim().toLowerCase()) })),
    skipped: plan.skipped,
    current: {
      orders: await count('SELECT COUNT(*) AS count FROM orders'),
      jobs: await count('SELECT COUNT(*) AS count FROM job_drafts'),
      suppliers: existingSuppliers.length,
      staff: existingStaff.length
    }
  });
}));

app.post('/api/admin/sheet-import/apply', requireAdminAuth, asyncRoute(async (req, res) => {
  const entry = sheetImports.get(String(req.body.token || ''));
  if (!entry || entry.expires < Date.now()) {
    return res.status(409).json({ error: 'Preview the sheet again before importing.' });
  }
  const mode = req.body.mode === 'replace' ? 'replace' : 'add';
  if (req.body.confirmation !== (mode === 'replace' ? 'REPLACE' : 'IMPORT')) {
    return res.status(400).json({ error: `Type ${mode === 'replace' ? 'REPLACE' : 'IMPORT'} to confirm.` });
  }

  const existing = {
    suppliers: await dbAll('SELECT id, name, active FROM suppliers'),
    staff: await dbAll('SELECT id, name FROM staff_names'),
    orders: await dbAll('SELECT customer_name, supplier, date_ordered FROM orders WHERE is_archived = 0')
  };
  const { statements, result } = importStatements(entry.plan, { mode, existing, now: isoNow(), actor: actor(req) });
  await runInTransaction(statements);
  sheetImports.delete(String(req.body.token));
  broadcastLiveEvent('master-lists', { action: 'sheet-import' });
  broadcastLiveEvent('job-drafts', { action: 'sheet-import' });
  broadcastLiveEvent('orders', { action: 'sheet-import' });
  return res.json(result);
}));

app.use((error, req, res, next) => {
  // Log a code and route only: database errors can contain customer data or secrets.
  console.error('Request failed', { method: req.method, route: req.route?.path || 'middleware', code: error.code || 'REQUEST_ERROR' });
  if (res.headersSent) return next(error);
  return res.status(500).json({ error: 'Unable to complete this request right now.' });
});

app.listen(port, () => {
  console.log(`Boulevard Glass Order Tracker listening at http://localhost:${port}`);
});

// Hourly catch-up with Housecall Pro (HCP_SYNC_INTERVAL_MINUTES, 0 = off).
const hcpSyncMinutes = Number(process.env.HCP_SYNC_INTERVAL_MINUTES ?? 60);
if (hcpApiConfigured() && hcpSyncMinutes > 0) {
  const runHcpSync = () => syncHcp()
    .then((result) => { if (result.order_ids.length) broadcastLiveEvent('orders', { action: 'housecall-pro', orderIds: result.order_ids }); })
    .catch(() => console.error('Housecall Pro sync failed; see the Housecall Pro section in Master Lists.'));
  setTimeout(runHcpSync, 60 * 1000).unref();
  setInterval(runHcpSync, hcpSyncMinutes * 60 * 1000).unref();
}
