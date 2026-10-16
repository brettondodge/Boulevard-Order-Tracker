import { createHash } from 'node:crypto';
export const businessTables = ['users', 'suppliers', 'staff_names', 'job_drafts', 'orders'];
export async function recordFingerprint(client, { includeFreeport = true } = {}) {
  const result = {};
  const tables = [...businessTables];
  if (includeFreeport) {
    for (const table of ['freeport_records', 'freeport_files', 'freeport_invoice_claims', 'freeport_audit']) {
      if ((await client.query('SELECT to_regclass($1) AS name', [table])).rows[0]?.name) tables.push(table);
    }
  }
  for (const table of tables) {
    const rows = (await client.query(`SELECT * FROM ${table} ORDER BY ${table === 'freeport_records' ? 'kind, id' : table === 'freeport_invoice_claims' ? 'invoice_id' : 'id'}`)).rows;
    const normalized = rows.map(row => Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])));
    result[table] = { count: rows.length, sha256: createHash('sha256').update(JSON.stringify(normalized)).digest('hex') };
  }
  return result;
}
