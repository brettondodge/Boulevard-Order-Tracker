import { createHash } from 'node:crypto';
export const businessTables = ['users', 'suppliers', 'staff_names', 'job_drafts', 'orders'];
export async function recordFingerprint(client) {
  const result = {};
  for (const table of businessTables) {
    const rows = (await client.query(`SELECT * FROM ${table} ORDER BY id`)).rows;
    const normalized = rows.map(row => Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])));
    result[table] = { count: rows.length, sha256: createHash('sha256').update(JSON.stringify(normalized)).digest('hex') };
  }
  return result;
}
