import { createHash } from 'node:crypto';
export const businessTables = ['users', 'suppliers', 'staff_names', 'job_drafts', 'orders'];
// Freeport tables are fingerprinted only where they exist, so manifests taken
// before the Freeport migration still verify.
const freeportTables = { freeport_settings: 'id', freeport_accounts: 'code', freeport_items: 'id', freeport_invoices: 'id', freeport_invoice_lines: 'id', freeport_months: 'month', freeport_month_sends: 'id' };
export async function recordFingerprint(client) {
  const result = {};
  const tables = businessTables.map(table => [table, 'id']);
  for (const [table, key] of Object.entries(freeportTables)) {
    if ((await client.query('SELECT to_regclass($1) AS name', [table])).rows[0].name) tables.push([table, key]);
  }
  for (const [table, key] of tables) {
    const rows = (await client.query(`SELECT * FROM ${table} ORDER BY ${key}`)).rows;
    const normalized = rows.map(row => Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])));
    result[table] = { count: rows.length, sha256: createHash('sha256').update(JSON.stringify(normalized)).digest('hex') };
  }
  return result;
}
