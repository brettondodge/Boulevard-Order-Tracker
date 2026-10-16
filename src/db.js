import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import Database from 'better-sqlite3';
import pg from 'pg';
import { migratePostgres } from './postgres-migrations.js';
import { postgresOptions } from './postgres-connection.js';
import { supplierCleanupPlan, requireUnchangedCleanup } from './supplier-cleanup.js';
import { isoNow, todayPhoenixString } from './utils.js';

dotenv.config();

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.SQLITE_DATA_DIR ? path.resolve(process.env.SQLITE_DATA_DIR) : path.resolve(__dirname, '../data');
fs.mkdirSync(dataDir, { recursive: true });

export const isProduction = process.env.NODE_ENV === 'production' || process.env.RENDER === 'true';
const db = isProduction ? null : new Database(path.join(dataDir, 'boulevard_orders.db'));
let postgresPool = null;

export function validateRuntimeDatabaseConfig() {
  if (!isProduction) {
    return;
  }

  if (!process.env.CF_ACCESS_TEAM_DOMAIN || !process.env.CF_ACCESS_AUD) {
    throw new Error('Production requires CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD. Staff access must be configured before deployment.');
  }
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
    throw new Error('Production requires a SESSION_SECRET of at least 32 characters.');
  }
  if (!process.env.ADMIN_PASSWORD && !process.env.ADMIN_PASSWORD_HASH) {
    throw new Error('Production requires ADMIN_PASSWORD or ADMIN_PASSWORD_HASH for the separate admin gate.');
  }

  if (!process.env.DATABASE_URL) {
    throw new Error('Production deployment requires DATABASE_URL. The app will not fall back to the local SQLite database in Render.');
  }

  if (!/^postgres(ql)?:\/\//i.test(process.env.DATABASE_URL)) {
    throw new Error('DATABASE_URL is not a valid Postgres connection string. Use the existing Render Postgres internal URL for this service.');
  }
}

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
    throw new Error('Production mode requires the Postgres runtime. The SQLite database is intentionally disabled in production.');
  }

  return db;
}

export async function getPool() {
  if (!isProduction) {
    return null;
  }

  validateRuntimeDatabaseConfig();
  postgresPool ||= new Pool({ ...postgresOptions(process.env.DATABASE_URL), max: 10, idleTimeoutMillis: 30000 });
  return postgresPool;
}

export async function pingDatabase() {
  if (!isProduction) {
    return true;
  }

  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query('SELECT 1');
    return true;
  } finally {
    client.release();
  }
}

function normalizeQuestionMarks(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => {
    index += 1;
    return `$${index}`;
  });
}

export async function dbGet(sql, params = []) {
  if (isProduction) {
    const pool = await getPool();
    const result = await pool.query(normalizeQuestionMarks(sql), params);
    return result.rows[0] || null;
  }

  return db.prepare(sql).get(...params);
}

export async function dbAll(sql, params = []) {
  if (isProduction) {
    const pool = await getPool();
    const result = await pool.query(normalizeQuestionMarks(sql), params);
    return result.rows;
  }

  return db.prepare(sql).all(...params);
}

export async function dbRun(sql, params = []) {
  if (isProduction) {
    const pool = await getPool();
    const result = await pool.query(normalizeQuestionMarks(sql), params);
    return {
      changes: Number(result.rowCount || 0),
      lastInsertRowid: result.rows?.[0]?.id || null
    };
  }

  return db.prepare(sql).run(...params);
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

export async function resolveOrderSupplierAsync(selection, existingOrder = null) {
  const name = (selection.supplier || '').trim();
  const id = (selection.supplier_id || '').trim();
  const supplier = id
    ? await dbGet('SELECT id, name, active FROM suppliers WHERE id = ?', [id])
    : name ? await dbGet('SELECT id, name, active FROM suppliers WHERE lower(name) = lower(?)', [name]) : null;
  if (supplier && Number(supplier.active) !== 0) return supplier;
  // Editing history may keep its original inactive supplier, but must not
  // reactivate it or assign an inactive supplier to a different order.
  if (supplier && existingOrder && (
    existingOrder.supplier_id === supplier.id ||
    (!existingOrder.supplier_id && String(existingOrder.supplier || '').trim().toLowerCase() === supplier.name.toLowerCase())
  )) return supplier;
  if (!supplier && !id && existingOrder && !existingOrder.supplier_id && name && name.toLowerCase() === String(existingOrder.supplier || '').trim().toLowerCase()) {
    return { id: null, name: existingOrder.supplier };
  }
  return null;
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

export async function ensureProductionUsers() {
  if (!isProduction) {
    return;
  }

  const pool = await getPool();
  const userCountResult = await pool.query('SELECT COUNT(*)::int AS count FROM users');
  if (Number(userCountResult.rows[0].count) > 0) {
    return;
  }

  const adminUsername = (process.env.ADMIN_USERNAME || 'admin').trim();
  const password = process.env.ADMIN_PASSWORD;
  if (!password && !process.env.ADMIN_PASSWORD_HASH) throw new Error('ADMIN_PASSWORD is required to initialize production users.');
  const hash = process.env.ADMIN_PASSWORD_HASH || bcrypt.hashSync(password, 10);
  const id = cryptoRandomId('user');
  await pool.query(
    'INSERT INTO users (id, username, password_hash, full_name, created_at) VALUES ($1, $2, $3, $4, $5)',
    [id, adminUsername, hash, 'Office Admin', isoNow()]
  );
}

export async function initializeDatabase() {
  if (isProduction) {
    const pool = await getPool();
    await migratePostgres(pool);

    await ensureProductionUsers();
    return;
  }

  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  db.transaction(() => {
    const name = '002-freeport.sql';
    if (!db.prepare('SELECT name FROM schema_migrations WHERE name = ?').get(name)) {
      db.exec(fs.readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
      db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run(name);
    }
  })();
  seedUsers();
  if (process.env.PREVIEW_MODE !== 'false') {
    seedPreviewData();
  }
}

export function getActiveSuppliers() {
  return db.prepare('SELECT * FROM suppliers WHERE active = 1 ORDER BY name COLLATE NOCASE ASC').all();
}

export async function getActiveSuppliersAsync() {
  if (isProduction) {
    return await dbAll('SELECT * FROM suppliers WHERE active = 1 ORDER BY LOWER(name) ASC');
  }

  return getActiveSuppliers();
}

export function getAllSuppliers() {
  return db.prepare('SELECT * FROM suppliers ORDER BY name COLLATE NOCASE ASC').all();
}

export async function getAllSuppliersAsync() {
  if (isProduction) {
    return await dbAll('SELECT * FROM suppliers ORDER BY LOWER(name) ASC');
  }

  return getAllSuppliers();
}

export function getActiveStaffNames() {
  return db.prepare('SELECT * FROM staff_names WHERE active = 1 ORDER BY name COLLATE NOCASE ASC').all();
}

export async function getActiveStaffNamesAsync() {
  if (isProduction) {
    return await dbAll('SELECT * FROM staff_names WHERE active = 1 ORDER BY LOWER(name) ASC');
  }

  return getActiveStaffNames();
}

export function getAllStaffNames() {
  return db.prepare('SELECT * FROM staff_names ORDER BY name COLLATE NOCASE ASC').all();
}

export async function getAllStaffNamesAsync() {
  if (isProduction) {
    return await dbAll('SELECT * FROM staff_names ORDER BY LOWER(name) ASC');
  }

  return getAllStaffNames();
}

export async function upsertSupplierMasterRowAsync(record) {
  const trimmedName = (record.name || '').trim();
  if (!trimmedName) {
    return null;
  }

  if (!isProduction) {
    return upsertSupplierMasterRow(record);
  }

  const now = isoNow();
  const existing = record.id
    ? await dbGet('SELECT * FROM suppliers WHERE id = ?', [record.id])
    : await dbGet('SELECT * FROM suppliers WHERE lower(name) = lower(?)', [trimmedName]);

  if (existing) {
    await dbRun('UPDATE suppliers SET name = ?, active = ?, updated_at = ? WHERE id = ?', [trimmedName, record.active === false ? 0 : 1, now, existing.id]);
    return await dbGet('SELECT * FROM suppliers WHERE id = ?', [existing.id]);
  }

  const id = record.id || cryptoRandomId('supplier');
  await dbRun('INSERT INTO suppliers (id, name, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [id, trimmedName, record.active === false ? 0 : 1, now, now]);
  return await dbGet('SELECT * FROM suppliers WHERE id = ?', [id]);
}

export async function previewInactiveSupplierCleanup(includeHistorical = false) {
  return supplierCleanupPlan(await dbAll('SELECT * FROM suppliers ORDER BY id'), await dbAll('SELECT * FROM orders ORDER BY id'), includeHistorical);
}

export async function deleteInactiveSupplierRecords(expectedFingerprint, includeHistorical = false) {
  if (!isProduction) {
    // Keep SQLite's entire confirmation and deletion synchronous and atomic.
    return db.transaction(() => {
      const plan = supplierCleanupPlan(db.prepare('SELECT * FROM suppliers ORDER BY id').all(), db.prepare('SELECT * FROM orders ORDER BY id').all(), includeHistorical);
      requireUnchangedCleanup(plan, expectedFingerprint);
      for (const id of plan.order_ids) db.prepare('DELETE FROM orders WHERE id = ?').run(id);
      for (const row of plan.suppliers) db.prepare('DELETE FROM suppliers WHERE id = ?').run(row.id);
      return { deleted_suppliers: plan.supplier_count, deleted_orders: plan.order_count };
    })();
  }
  const client = await (await getPool()).connect();
  try {
    await client.query('BEGIN');
    await client.query('LOCK TABLE suppliers, orders IN EXCLUSIVE MODE');
    const plan = supplierCleanupPlan((await client.query('SELECT * FROM suppliers ORDER BY id')).rows, (await client.query('SELECT * FROM orders ORDER BY id')).rows, includeHistorical);
    requireUnchangedCleanup(plan, expectedFingerprint);
    for (const id of plan.order_ids) await client.query('DELETE FROM orders WHERE id = $1', [id]);
    for (const row of plan.suppliers) await client.query('DELETE FROM suppliers WHERE id = $1', [row.id]);
    await client.query('COMMIT');
    return { deleted_suppliers: plan.supplier_count, deleted_orders: plan.order_count };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export function upsertSupplierMasterRow(record) {
  const trimmedName = (record.name || '').trim();
  if (!trimmedName) return null;

  const now = isoNow();
  const existing = record.id
    ? db.prepare('SELECT * FROM suppliers WHERE id = ?').get(record.id)
    : db.prepare('SELECT * FROM suppliers WHERE lower(name) = lower(?)').get(trimmedName);

  if (existing) {
    db.prepare('UPDATE suppliers SET name = ?, active = ?, updated_at = ? WHERE id = ?').run(trimmedName, record.active === false ? 0 : 1, now, existing.id);
    return db.prepare('SELECT * FROM suppliers WHERE id = ?').get(existing.id);
  }

  const id = record.id || cryptoRandomId('supplier');
  db.prepare('INSERT INTO suppliers (id, name, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, trimmedName, record.active === false ? 0 : 1, now, now);
  return db.prepare('SELECT * FROM suppliers WHERE id = ?').get(id);
}

export async function upsertStaffMasterRowAsync(record) {
  const trimmedName = (record.name || '').trim();
  if (!trimmedName) {
    return null;
  }

  if (!isProduction) {
    return upsertStaffMasterRow(record);
  }

  const now = isoNow();
  const existing = record.id
    ? await dbGet('SELECT * FROM staff_names WHERE id = ?', [record.id])
    : await dbGet('SELECT * FROM staff_names WHERE lower(name) = lower(?)', [trimmedName]);

  if (existing) {
    await dbRun('UPDATE staff_names SET name = ?, active = ?, updated_at = ? WHERE id = ?', [trimmedName, record.active === false ? 0 : 1, now, existing.id]);
    return await dbGet('SELECT * FROM staff_names WHERE id = ?', [existing.id]);
  }

  const id = record.id || cryptoRandomId('staff');
  await dbRun('INSERT INTO staff_names (id, name, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', [id, trimmedName, record.active === false ? 0 : 1, now, now]);
  return await dbGet('SELECT * FROM staff_names WHERE id = ?', [id]);
}

export function upsertStaffMasterRow(record) {
  const trimmedName = (record.name || '').trim();
  if (!trimmedName) return null;

  const now = isoNow();
  const existing = record.id
    ? db.prepare('SELECT * FROM staff_names WHERE id = ?').get(record.id)
    : db.prepare('SELECT * FROM staff_names WHERE lower(name) = lower(?)').get(trimmedName);

  if (existing) {
    db.prepare('UPDATE staff_names SET name = ?, active = ?, updated_at = ? WHERE id = ?').run(trimmedName, record.active === false ? 0 : 1, now, existing.id);
    return db.prepare('SELECT * FROM staff_names WHERE id = ?').get(existing.id);
  }

  const id = record.id || cryptoRandomId('staff');
  db.prepare('INSERT INTO staff_names (id, name, active, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(id, trimmedName, record.active === false ? 0 : 1, now, now);
  return db.prepare('SELECT * FROM staff_names WHERE id = ?').get(id);
}

export function sanitizeSupplierName(value) {
  const supplier = (value || '').trim();
  return supplier || '';
}

export function seedPreviewData() {
  const existingPreview = db.prepare('SELECT COUNT(*) as count FROM orders WHERE is_preview_data = 1').get();

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


function cryptoRandomId(prefix) {
  const random = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}-${random}`;
}
