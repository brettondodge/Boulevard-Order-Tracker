import Database from 'better-sqlite3';
import pg from 'pg';
import { migratePostgres } from '../src/postgres-migrations.js';
import { postgresOptions } from '../src/postgres-connection.js';
const tables = ['users', 'suppliers', 'staff_names', 'job_drafts', 'orders'];
const filename = process.argv[2];
if (!filename || process.env.CONFIRM_EMPTY_IMPORT !== 'yes') throw new Error('Supply verified snapshot filename and CONFIRM_EMPTY_IMPORT=yes. Target must be empty.');
const sqlite = new Database(filename, { readonly: true, fileMustExist: true });
const pool = new pg.Pool(postgresOptions(process.env.IMPORT_DATABASE_URL));
let client;
try {
  const integrity = sqlite.pragma('integrity_check');
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error('SQLite integrity failed');
  const actualTables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name);
  if (actualTables.some(name => !tables.includes(name))) throw new Error('Unrecognized source table');
  sqlite.exec('BEGIN');
  await migratePostgres(pool);
  client = await pool.connect();
  await client.query('BEGIN');
  await client.query(`LOCK TABLE ${tables.join(', ')} IN ACCESS EXCLUSIVE MODE`);
  for (const table of tables) {
    if (Number((await client.query(`SELECT count(*) AS count FROM ${table}`)).rows[0].count)) throw new Error('Target contains records; import refused');
  }
  const counts = {};
  for (const table of tables) {
    const rows = sqlite.prepare(`SELECT * FROM ${table} ORDER BY id`).all();
    const columns = sqlite.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
    const quoted = columns.map(column => '"' + column.replaceAll('"', '""') + '"');
    for (const row of rows) await client.query(`INSERT INTO ${table} (${quoted.join(',')}) VALUES (${columns.map((_, i) => '$' + (i + 1)).join(',')})`, columns.map(column => row[column]));
    const imported = (await client.query(`SELECT ${quoted.join(',')} FROM ${table} ORDER BY id`)).rows;
    if (imported.length !== rows.length || rows.some((row, i) => columns.some(column => row[column] !== imported[i][column]))) throw new Error(`Exact field verification failed for ${table}`);
    counts[table] = rows.length;
  }
  await client.query('COMMIT');
  console.log(JSON.stringify({ imported: true, exactFieldComparison: true, counts }));
} catch {
  if (client) await client.query('ROLLBACK').catch(() => {});
  console.error('Import failed; record transaction rolled back. Inspect source schema and target configuration.');
  process.exitCode = 1;
} finally {
  client?.release(); sqlite.close(); await pool.end();
}
