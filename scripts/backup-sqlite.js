import Database from 'better-sqlite3';
import { mkdir, copyFile, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const sourcePath = process.argv[2] || 'data/boulevard_orders.db';
const directory = path.resolve('data/backups', 'verified-' + new Date().toISOString().replaceAll(':', '-'));
await mkdir(directory, { recursive: true, mode: 0o700 });
const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
const snapshot = path.join(directory, 'snapshot.db');
let restored;
try {
  await source.backup(snapshot);
  const restorePath = path.join(directory, 'restore-test.db');
  await copyFile(snapshot, restorePath);
  restored = new Database(restorePath, { readonly: true, fileMustExist: true });
  const integrity = restored.pragma('integrity_check');
  if (integrity.length !== 1 || integrity[0].integrity_check !== 'ok') throw new Error('Restored integrity check failed');
  const tables = restored.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
  const counts = Object.fromEntries(tables.map(({ name }) => [name, restored.prepare('SELECT count(*) AS count FROM "' + name.replaceAll('"', '""') + '"').get().count]));
  const evidence = { createdAt: new Date().toISOString(), method: 'SQLite online backup API', snapshot, restorePath, integrity, counts, sha256: createHash('sha256').update(await readFile(snapshot)).digest('hex') };
  await writeFile(path.join(directory, 'verification.json'), JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log('Backup and restored-copy verification passed. Evidence: ' + path.join(directory, 'verification.json'));
} finally { restored?.close(); source.close(); }
