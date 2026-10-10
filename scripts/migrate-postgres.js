import bcrypt from 'bcryptjs';
import { Client } from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is required before running the Postgres migration. Set it in the Render environment for this service.');
  process.exit(1);
}

const client = new Client({ connectionString });

const schemaSql = `
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

  ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS active INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS updated_at TEXT;
  ALTER TABLE staff_names ADD COLUMN IF NOT EXISTS active INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE job_drafts ADD COLUMN IF NOT EXISTS is_archived INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE job_drafts ADD COLUMN IF NOT EXISTS archived_at TEXT;
  ALTER TABLE job_drafts ADD COLUMN IF NOT EXISTS archive_source TEXT;
  ALTER TABLE job_drafts ADD COLUMN IF NOT EXISTS archive_reason TEXT;
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS supplier_id TEXT;
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS category TEXT;
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS combined_group TEXT;
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS ordered_by TEXT;
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS ordered_by_id TEXT;
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS job_draft_id TEXT;
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS is_archived INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS archived_at TEXT;
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS archive_source TEXT;
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS archive_reason TEXT;
`;

const adminUsername = (process.env.ADMIN_USERNAME || 'admin').trim();
const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';

try {
  await client.connect();
  await client.query('BEGIN');
  for (const statement of schemaSql.split(';').map((part) => part.trim()).filter(Boolean)) {
    await client.query(statement + ';');
  }

  const userCount = await client.query('SELECT COUNT(*)::int AS count FROM users');
  if (Number(userCount.rows[0].count) === 0) {
    const hash = bcrypt.hashSync(adminPassword, 10);
    await client.query(
      'INSERT INTO users (id, username, password_hash, full_name, created_at) VALUES ($1, $2, $3, $4, $5)',
      [`user-${Date.now()}`, adminUsername, hash, 'Office Admin', new Date().toISOString()]
    );
  }

  await client.query('COMMIT');
  console.log('Postgres migration completed successfully.');
  console.log(`Admin user created or validated for: ${adminUsername}`);
} catch (error) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('Postgres migration failed.');
  console.error(error.message);
  process.exit(1);
} finally {
  await client.end();
}
