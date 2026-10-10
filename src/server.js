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

app.get('/api/admin/me', (req, res) => {
  if (!req.session.admin || req.session.admin.username !== currentAdminUsername()) {
    return res.status(401).json({ error: 'Not authenticated as admin.' });
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

  return res.json({ staff_names: saved.map((item) => ({ id: item.id, name: item.name, active: Number(item.active) !== 0 })) });
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

  const sortKey = (req.query.sort || 'expected_delivery_date').toString();
  filtered.sort((a, b) => {
    if (sortKey === 'order_date') {
      const aDate = a.date_ordered || '9999-12-31';
      const bDate = b.date_ordered || '9999-12-31';
      return aDate.localeCompare(bDate);
    }

    const aValue = a.expected_delivery_date || '9999-12-31';
    const bValue = b.expected_delivery_date || '9999-12-31';
    return aValue.localeCompare(bValue);
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

    if (!orderData.customer_name) {
      return res.status(400).json({ error: 'Customer name is required.' });
    }

    if (!orderData.supplier) {
      return res.status(400).json({ error: 'Supplier is required.' });
    }

    if (!orderData.category) {
      return res.status(400).json({ error: 'Category is required.' });
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
        po_number, date_ordered, expected_delivery_date, date_received, ordered_by, ordered_by_id, status, notes,
        created_at, updated_at, created_by, updated_by, is_preview_data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
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
      now,
      now,
      'office-user',
      'office-user'
    );

    const created = getDb().prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
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

  const receivedDate = normalizeText(req.body.date_received) || todayPhoenixString();
  const now = isoNow();
  getDb().prepare(
    'UPDATE orders SET date_received = ?, status = ?, updated_at = ?, updated_by = ? WHERE id = ?'
  ).run(receivedDate, 'Received', now, 'office-user', req.params.id);

  const updated = getDb().prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  return res.json({ order: { ...updated, status: statusFromOrder(updated) } });
});

app.post('/api/orders/:id/reopen', (req, res) => {
  const existing = getDb().prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!existing) {
    return res.status(404).json({ error: 'Order not found.' });
  }

  const now = isoNow();
  getDb().prepare(
    'UPDATE orders SET date_received = NULL, status = ?, updated_at = ?, updated_by = ? WHERE id = ?'
  ).run('Ordered', now, 'office-user', req.params.id);

  const updated = getDb().prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  return res.json({ order: { ...updated, status: statusFromOrder(updated) } });
});

app.listen(port, () => {
  console.log(`Boulevard Glass Order Tracker listening at http://localhost:${port}`);
});
