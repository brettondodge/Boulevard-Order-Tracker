import pg from 'pg';
import { recordFingerprint } from '../src/record-fingerprint.js';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
for (const name of ['DATABASE_URL', 'S3_BACKUP_BUCKET', 'S3_BACKUP_PREFIX', 'AWS_REGION', 'BACKUP_HEARTBEAT_URL']) if (!process.env[name]) throw new Error(`${name} is required`);
const heartbeat = new URL(process.env.BACKUP_HEARTBEAT_URL);
if (heartbeat.protocol !== 'https:') throw new Error('Heartbeat requires HTTPS');
const db = new URL(process.env.DATABASE_URL);
const directory = await mkdtemp(path.join(tmpdir(), 'boulevard-backup-'));
const filename = path.join(directory, 'database.dump');
const key = `${process.env.S3_BACKUP_PREFIX.replace(/\/+$/, '')}/${new Date().toISOString().slice(0, 10)}.dump`;
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000 });
let client;
const s3 = new S3Client({ region: process.env.AWS_REGION });
try {
  client = await pool.connect();
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const snapshot = (await client.query('SELECT pg_export_snapshot() AS snapshot')).rows[0].snapshot;
  const fingerprint = await recordFingerprint(client);
  await new Promise((resolve, reject) => {
    const child = spawn('pg_dump', ['--format=custom', '--no-owner', '--no-acl', '--snapshot', snapshot, '--file', filename], {
      env: { ...process.env, PGHOST: db.hostname, PGPORT: db.port || '5432', PGDATABASE: decodeURIComponent(db.pathname.slice(1)), PGUSER: decodeURIComponent(db.username), PGPASSWORD: decodeURIComponent(db.password), PGSSLMODE: db.searchParams.get('sslmode') || process.env.PGSSLMODE || 'prefer' }, stdio: 'ignore'
    });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error('pg_dump failed')));
  });
  await client.query('COMMIT');
  const body = await readFile(filename);
  const checksum = createHash('sha256').update(body).digest('base64');
  await s3.send(new PutObjectCommand({ Bucket: process.env.S3_BACKUP_BUCKET, Key: key, Body: body, ServerSideEncryption: 'AES256', ChecksumSHA256: checksum, Metadata: { 'record-fingerprint': JSON.stringify(fingerprint) } }));
  const uploaded = await s3.send(new GetObjectCommand({ Bucket: process.env.S3_BACKUP_BUCKET, Key: key, ChecksumMode: 'ENABLED' }));
  const downloaded = await uploaded.Body.transformToByteArray();
  if (createHash('sha256').update(downloaded).digest('base64') !== checksum) throw new Error('Checksum mismatch');
  const response = await fetch(heartbeat, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error('Heartbeat failed');
  console.log('Encrypted daily backup uploaded and download checksum verified.');
} catch {
  await fetch(`${heartbeat.href.replace(/\/$/, '')}/fail`, { signal: AbortSignal.timeout(15000) }).catch(() => {});
  console.error('Backup failed. Check provider logs, database access, bucket permissions and heartbeat.');
  process.exitCode = 1;
} finally {
  if (client) { await client.query('ROLLBACK').catch(() => {}); client.release(); }
  await pool.end();
  await rm(directory, { recursive: true, force: true });
}
