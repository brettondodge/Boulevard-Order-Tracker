import pg from 'pg';
import { migratePostgres } from '../src/postgres-migrations.js';
import { postgresOptions } from '../src/postgres-connection.js';
const pool = new pg.Pool(postgresOptions(process.env.DATABASE_URL));
try {
  await migratePostgres(pool);
  console.log('Recorded migrations completed. No accounts or demo orders were seeded.');
} catch {
  console.error('Migration failed. Check database connectivity and configuration.');
  process.exitCode = 1;
} finally { await pool.end(); }
