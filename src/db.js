import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import { isoNow, todayPhoenixString } from './utils.js';

export function validateRuntimeDatabaseConfig() {
  const isProduction = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';
  if (!isProduction) {
    return;
  }

  if (!process.env.DATABASE_URL) {
    throw new Error('Production deployment requires DATABASE_URL. The app will not fall back to the local SQLite database in Render.');
  }

  if (!/^postgres(ql)?:\/\//i.test(process.env.DATABASE_URL)) {
    throw new Error('DATABASE_URL is not a valid Postgres connection string. Use the existing Render Postgres internal URL for this service.');
  }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, '../data');
fs.mkdirSync(dataDir, { recursive: true });

const isProduction = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';
const db = isProduction ? null : new Database(path.join(dataDir, 'boulevard_orders.db'));

if (!isProduction) {
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      full_name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS suppliers (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS staff_names (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS job_drafts (
      id TEXT PRIMARY KEY,
      customer_name TEXT NOT NULL,
      housecall_job_number TEXT,
      housecall_job_link TEXT,
      hcp_job_id TEXT,
      notes TEXT,
      deposit_status TEXT NOT NULL DEFAULT 'Awaiting deposit',
      status TEXT NOT NULL DEFAULT 'Open',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by TEXT,
      updated_by TEXT,
      is_archived INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT,
      archive_source TEXT,
      archive_reason TEXT,
      is_preview_data INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      customer_name TEXT NOT NULL,
      housecall_job_number TEXT,
      housecall_job_link TEXT,
      supplier TEXT NOT NULL,
      supplier_id TEXT,
      category TEXT,
      combined_group TEXT,
      po_number TEXT,
      date_ordered TEXT NOT NULL,
      expected_delivery_date TEXT,
      date_received TEXT,
      ordered_by TEXT,
      ordered_by_id TEXT,
      status TEXT NOT NULL DEFAULT 'Ordered',
      notes TEXT,
      job_draft_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by TEXT,
      updated_by TEXT,
      is_archived INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT,
      archive_source TEXT,
      archive_reason TEXT,
      is_preview_data INTEGER NOT NULL DEFAULT 0
    );
  `);

  const hasCategoryColumn = db.prepare("SELECT COUNT(*) as count FROM pragma_table_info('orders') WHERE name = 'category'").get();
  if (Number(hasCategoryColumn.count) === 0) {
    db.exec('ALTER TABLE orders ADD COLUMN category TEXT;');
  }

  const hasCombinedGroupColumn = db.prepare("SELECT COUNT(*) as count FROM pragma_table_info('orders') WHERE name = 'combined_group'").get();
  if (Number(hasCombinedGroupColumn.count) === 0) {
    db.exec('ALTER TABLE orders ADD COLUMN combined_group TEXT;');
  }

  const hasSupplierIdColumn = db.prepare("SELECT COUNT(*) as count FROM pragma_table_info('orders') WHERE name = 'supplier_id'").get();
  if (Number(hasSupplierIdColumn.count) === 0) {
    db.exec('ALTER TABLE orders ADD COLUMN supplier_id TEXT;');
  }

  const hasOrderedByColumn = db.prepare("SELECT COUNT(*) as count FROM pragma_table_info('orders') WHERE name = 'ordered_by'").get();
  if (Number(hasOrderedByColumn.count) === 0) {
    db.exec('ALTER TABLE orders ADD COLUMN ordered_by TEXT;');
  }

  const hasOrderedByIdColumn = db.prepare("SELECT COUNT(*) as count FROM pragma_table_info('orders') WHERE name = 'ordered_by_id'").get();
  if (Number(hasOrderedByIdColumn.count) === 0) {
    db.exec('ALTER TABLE orders ADD COLUMN ordered_by_id TEXT;');
  }

  const hasJobDraftIdColumn = db.prepare("SELECT COUNT(*) as count FROM pragma_table_info('orders') WHERE name = 'job_draft_id'").get();
  if (Number(hasJobDraftIdColumn.count) === 0) {
    db.exec('ALTER TABLE orders ADD COLUMN job_draft_id TEXT;');
  }

  const hasJobDraftTable = db.prepare("SELECT COUNT(*) as count FROM sqlite_master WHERE type = 'table' AND name = 'job_drafts'").get();
  if (Number(hasJobDraftTable.count) === 0) {
    db.exec(`
      CREATE TABLE job_drafts (
        id TEXT PRIMARY KEY,
        customer_name TEXT NOT NULL,
        housecall_job_number TEXT,
        housecall_job_link TEXT,
        hcp_job_id TEXT,
        notes TEXT,
        deposit_status TEXT NOT NULL DEFAULT 'Awaiting deposit',
        status TEXT NOT NULL DEFAULT 'Open',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        created_by TEXT,
        updated_by TEXT,
        is_archived INTEGER NOT NULL DEFAULT 0,
        archived_at TEXT,
        archive_source TEXT,
        archive_reason TEXT,
        is_preview_data INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  const hasJobDraftArchivedColumn = db.prepare("SELECT COUNT(*) as count FROM pragma_table_info('job_drafts') WHERE name = 'is_archived'").get();
  if (Number(hasJobDraftArchivedColumn.count) === 0) {
    db.exec('ALTER TABLE job_drafts ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0;');
    db.exec('ALTER TABLE job_drafts ADD COLUMN archived_at TEXT;');
    db.exec('ALTER TABLE job_drafts ADD COLUMN archive_source TEXT;');
    db.exec('ALTER TABLE job_drafts ADD COLUMN archive_reason TEXT;');
  }

  const hasOrderArchivedColumn = db.prepare("SELECT COUNT(*) as count FROM pragma_table_info('orders') WHERE name = 'is_archived'").get();
  if (Number(hasOrderArchivedColumn.count) === 0) {
    db.exec('ALTER TABLE orders ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0;');
    db.exec('ALTER TABLE orders ADD COLUMN archived_at TEXT;');
    db.exec('ALTER TABLE orders ADD COLUMN archive_source TEXT;');
    db.exec('ALTER TABLE orders ADD COLUMN archive_reason TEXT;');
  }

  const hasSupplierActiveColumn = db.prepare("SELECT COUNT(*) as count FROM pragma_table_info('suppliers') WHERE name = 'active'").get();
  if (Number(hasSupplierActiveColumn.count) === 0) {
    db.exec('ALTER TABLE suppliers ADD COLUMN active INTEGER NOT NULL DEFAULT 1;');
  }

  const hasSupplierUpdatedAtColumn = db.prepare("SELECT COUNT(*) as count FROM pragma_table_info('suppliers') WHERE name = 'updated_at'").get();
  if (Number(hasSupplierUpdatedAtColumn.count) === 0) {
    db.exec('ALTER TABLE suppliers ADD COLUMN updated_at TEXT;');
  }

  const hasStaffTable = db.prepare("SELECT COUNT(*) as count FROM sqlite_master WHERE type = 'table' AND name = 'staff_names'").get();
  if (Number(hasStaffTable.count) === 0) {
    db.exec(`
      CREATE TABLE staff_names (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }
}

export function getDb() {
  if (isProduction) {
    throw new Error('Production mode requires a live Postgres database connection. Local SQLite access is intentionally disabled in production.');
  }

  return db;
}

export function ensureSupplierExists(name) {
  const trimmed = (name || '').trim();
  if (!trimmed) {
    return null;
  }

  const existing = db
    .prepare('SELECT id, name, active FROM suppliers WHERE lower(name) = lower(?)')
    .get(trimmed);

  if (existing) {
    if (Number(existing.active) === 0) {
      db.prepare('UPDATE suppliers SET active = 1, updated_at = ? WHERE id = ?').run(isoNow(), existing.id);
    }
    return { id: existing.id, name: existing.name };
  }

  const id = cryptoRandomId('supplier');
  db.prepare('INSERT INTO suppliers (id, name, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)').run(
    id,
    trimmed,
    isoNow(),
    isoNow()
  );

  return { id, name: trimmed };
}

export function seedUsers() {
  const anyUser = db.prepare('SELECT COUNT(*) as count FROM users').get();
  if (Number(anyUser.count) > 0) {
    return;
  }

  const users = [
    { username: 'admin', password: process.env.DEMO_ADMIN_PASSWORD || 'admin123', full_name: 'Office Admin' },
    { username: 'mary', password: process.env.DEMO_STAFF_PASSWORD || 'staff123', full_name: 'Mary Johnson' }
  ];

  for (const user of users) {
    const hash = bcrypt.hashSync(user.password, 10);
    db.prepare(
      'INSERT INTO users (id, username, password_hash, full_name, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(cryptoRandomId('user'), user.username, hash, user.full_name, isoNow());
  }
}

export function getActiveSuppliers() {
  return db
    .prepare('SELECT * FROM suppliers WHERE active = 1 ORDER BY name COLLATE NOCASE ASC')
    .all();
}

export function getAllSuppliers() {
  return db
    .prepare('SELECT * FROM suppliers ORDER BY name COLLATE NOCASE ASC')
    .all();
}

export function getActiveStaffNames() {
  return db
    .prepare('SELECT * FROM staff_names WHERE active = 1 ORDER BY name COLLATE NOCASE ASC')
    .all();
}

export function getAllStaffNames() {
  return db
    .prepare('SELECT * FROM staff_names ORDER BY name COLLATE NOCASE ASC')
    .all();
}

export function upsertSupplierMasterRow(record) {
  const trimmedName = (record.name || '').trim();
  if (!trimmedName) return null;

  const now = isoNow();
  const existing = record.id
    ? db.prepare('SELECT * FROM suppliers WHERE id = ?').get(record.id)
    : db.prepare('SELECT * FROM suppliers WHERE lower(name) = lower(?)').get(trimmedName);

  if (existing) {
    db.prepare('UPDATE suppliers SET name = ?, active = ?, updated_at = ? WHERE id = ?').run(
      trimmedName,
      record.active === false ? 0 : 1,
      now,
      existing.id
    );
    return db.prepare('SELECT * FROM suppliers WHERE id = ?').get(existing.id);
  }

  const id = record.id || cryptoRandomId('supplier');
  db.prepare('INSERT INTO suppliers (id, name, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
    id,
    trimmedName,
    record.active === false ? 0 : 1,
    now,
    now
  );
  return db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
}

export function upsertStaffMasterRow(record) {
  const trimmedName = (record.name || '').trim();
  if (!trimmedName) return null;

  const now = isoNow();
  const existing = record.id
    ? db.prepare('SELECT * FROM staff_names WHERE id = ?').get(record.id)
    : db.prepare('SELECT * FROM staff_names WHERE lower(name) = lower(?)').get(trimmedName);

  if (existing) {
    db.prepare('UPDATE staff_names SET name = ?, active = ?, updated_at = ? WHERE id = ?').run(
      trimmedName,
      record.active === false ? 0 : 1,
      now,
      existing.id
    );
    return db.prepare('SELECT * FROM staff_names WHERE id = ?').get(existing.id);
  }

  const id = record.id || cryptoRandomId('staff');
  db.prepare('INSERT INTO staff_names (id, name, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
    id,
    trimmedName,
    record.active === false ? 0 : 1,
    now,
    now
  );
  return db.prepare('SELECT * FROM staff_names WHERE id = ?').get(id);
}

export function sanitizeSupplierName(value) {
  const supplier = (value || '').trim();
  return supplier || '';
}

export function seedPreviewData() {
  const existingPreview = db
    .prepare('SELECT COUNT(*) as count FROM orders WHERE is_preview_data = 1')
    .get();

  if (Number(existingPreview.count) > 0) {
    return;
  }

  const sampleOrders = [
    {
      id: cryptoRandomId('order'),
      customer_name: 'Harrison Homes',
      housecall_job_number: 'HC-2048',
      housecall_job_link: 'https://example.com/jobs/hc-2048',
      supplier: 'Duralite Glass',
      category: 'Flat Glass',
      po_number: 'PO-2048-A',
      date_ordered: '2026-09-30',
      expected_delivery_date: '2026-10-07',
      date_received: null,
      status: 'Ordered',
      notes: 'Need final dimensions confirmed before cutting.',
      created_by: 'preview',
      updated_by: 'preview',
      is_preview_data: 1
    },
    {
      id: cryptoRandomId('order'),
      customer_name: 'Harrison Homes',
      housecall_job_number: 'HC-2048',
      housecall_job_link: 'https://example.com/jobs/hc-2048',
      supplier: 'Arrow Shower Door',
      category: 'Showers',
      po_number: 'PO-2048-B',
      date_ordered: '2026-10-01',
      expected_delivery_date: todayPhoenixString(),
      date_received: null,
      status: 'Ordered',
      notes: 'Due today; no sign of arrival yet.',
      created_by: 'preview',
      updated_by: 'preview',
      is_preview_data: 1
    },
    {
      id: cryptoRandomId('order'),
      customer_name: 'Crestview Residence',
      housecall_job_number: 'HC-3104',
      housecall_job_link: 'https://example.com/jobs/hc-3104',
      supplier: 'Pacific Hardware',
      category: 'Storefront',
      po_number: 'PO-3104-1',
      date_ordered: '2026-10-02',
      expected_delivery_date: '2026-10-05',
      date_received: '2026-10-04',
      status: 'Received',
      notes: 'Received in good condition. Hardware bag sealed.',
      created_by: 'preview',
      updated_by: 'preview',
      is_preview_data: 1
    },
    {
      id: cryptoRandomId('order'),
      customer_name: 'Riverview Condo',
      housecall_job_number: 'HC-1807',
      housecall_job_link: 'https://example.com/jobs/hc-1807',
      supplier: 'Northridge Glass',
      category: 'Windows',
      po_number: '0001842',
      date_ordered: '2026-09-23',
      expected_delivery_date: '2026-10-08',
      date_received: null,
      status: 'Ordered',
      notes: 'Partial shipment was not received; order remains open.',
      created_by: 'preview',
      updated_by: 'preview',
      is_preview_data: 1
    },
    {
      id: cryptoRandomId('order'),
      customer_name: 'Skyline Commercial',
      housecall_job_number: 'HC-9921',
      housecall_job_link: 'https://example.com/jobs/hc-9921',
      supplier: 'Mesa Commercial Supply',
      category: 'Storefront',
      po_number: 'COMM-9921',
      date_ordered: '2026-09-12',
      expected_delivery_date: '2026-09-20',
      date_received: null,
      status: 'Ordered',
      notes: 'Past due; waiting on supplier confirmation.',
      created_by: 'preview',
      updated_by: 'preview',
      is_preview_data: 1
    }
  ];

  for (const order of sampleOrders) {
    ensureSupplierExists(order.supplier);
    db.prepare(
      `INSERT INTO orders (
        id, customer_name, housecall_job_number, housecall_job_link, supplier, category, combined_group,
        po_number, date_ordered, expected_delivery_date, date_received, status, notes,
        created_at, updated_at, created_by, updated_by, is_preview_data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      order.id,
      order.customer_name,
      order.housecall_job_number,
      order.housecall_job_link,
      order.supplier,
      order.category,
      order.category ? (order.category === 'Windows' || order.category === 'Flat Glass' ? 'Windows / Flat Glass' : 'Heavy Glass / Storefront') : null,
      order.po_number,
      order.date_ordered,
      order.expected_delivery_date,
      order.date_received,
      order.status,
      order.notes,
      isoNow(),
      isoNow(),
      order.created_by,
      order.updated_by,
      order.is_preview_data
    );
  }
}

export function initializeDatabase() {
  if (isProduction) {
    throw new Error('Production mode requires a live Postgres database connection. The app will not initialize against local SQLite in Render.');
  }

  seedUsers();
  if (process.env.PREVIEW_MODE !== 'false') {
    seedPreviewData();
  }
}

function cryptoRandomId(prefix) {
  const random = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${random}`;
}
