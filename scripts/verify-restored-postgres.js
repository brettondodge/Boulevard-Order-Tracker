import pg from 'pg';
import { readFile } from 'node:fs/promises';
import { recordFingerprint } from '../src/record-fingerprint.js';
import { postgresOptions } from '../src/postgres-connection.js';
const expected = JSON.parse(await readFile(process.argv[2], 'utf8'));
const pool = new pg.Pool(postgresOptions(process.env.RESTORE_TEST_DATABASE_URL));
const client = await pool.connect();
try {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const actual = await recordFingerprint(client);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Restored records differ from the backed-up snapshot');
  console.log('Restored business tables match snapshot counts and hashes. Application checks still required.');
} finally { await client.query('ROLLBACK'); client.release(); await pool.end(); }
