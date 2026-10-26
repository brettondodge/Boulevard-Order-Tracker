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
test('a database that ran the first 002-freeport.sql gets the newer Freeport columns', { timeout: 90000 }, async () => {
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
    const column = async () => (await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'freeport_invoices' AND column_name = 'omega_snapshot'")).rowCount;
    assert.equal(await column(), 0);

    await migratePostgres(pool);
    assert.equal(await column(), 1);
    await migratePostgres(pool); // running again changes nothing
    assert.equal(await column(), 1);
  } finally {
    await pool?.end();
    await cluster.stop();
  }
});
