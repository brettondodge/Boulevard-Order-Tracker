import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { migratePostgres } from '../src/postgres-migrations.js';

// Production ran 002-freeport.sql before the omega_snapshot column was added to
// it, so the column must arrive through a later migration. Synthetic data only.
test('a database that ran the first 002-freeport.sql gets every newer Freeport and order column', { timeout: 90000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'boulevard-pg-upgrade-'));
  const cluster = new EmbeddedPostgres({ databaseDir: path.join(directory, 'cluster'), port: 55441, user: 'testuser', password: 'test-password', persistent: false, onLog: () => {}, onError: () => {} });
  let pool;
  try {
    await cluster.initialise();
    await cluster.start();
    await cluster.createDatabase('upgrade_test');
    pool = new pg.Pool({ connectionString: 'postgresql://testuser:test-password@127.0.0.1:55441/upgrade_test' });

    // The database as production had it: 001 and the earlier 002 applied.
    const migration = name => readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8');
    const deployed002 = (await migration('002-freeport.sql')).split('\n').filter(line => !line.includes('omega_snapshot TEXT')).join('\n');
    await pool.query('CREATE TABLE schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
    await pool.query(await migration('001-initial.sql'));
    await pool.query(deployed002);
    await pool.query("INSERT INTO schema_migrations (name) VALUES ('001-initial.sql'), ('002-freeport.sql')");
    const column = async name => (await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'freeport_invoices' AND column_name = $1", [name])).rowCount;
    const added = ['omega_snapshot', 'equipment_number', 'serial_number'];
    for (const name of added) assert.equal(await column(name), 0);

    await migratePostgres(pool);
    for (const name of added) assert.equal(await column(name), 1, name);
    await migratePostgres(pool); // running again changes nothing
    for (const name of added) assert.equal(await column(name), 1, name);
    const table = async name => (await pool.query('SELECT to_regclass($1) AS name', [name])).rows[0].name;
    assert.equal(await table('freeport_months'), 'freeport_months');
    assert.equal(await table('freeport_month_sends'), 'freeport_month_sends');
    const orderColumn = async name => (await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'orders' AND column_name = $1", [name])).rowCount;
    for (const name of ['shop_location', 'job_scheduled', 'scheduled_date', 'schedule_note', 'job_completed', 'completed_date', 'invoiced', 'invoice_reference']) assert.equal(await orderColumn(name), 1, name);
  } finally {
    await pool?.end();
    await cluster.stop();
  }
});
