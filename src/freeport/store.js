import { randomUUID } from 'node:crypto';
import { getDb, getPool, isProduction } from '../db.js';

let queue = Promise.resolve();
// Every Freeport mutation uses the same database transaction lock. Claims and
// snapshots commit together; neither async requests nor another server can race.
export async function transaction(fn) {
  const previous = queue;
  let release;
  queue = new Promise(resolve => { release = resolve; });
  await previous;
  let client;
  try {
    client = isProduction ? await (await getPool()).connect() : getDb();
    const query = async (sql, args = []) => {
      if (isProduction) { let n = 0; return (await client.query(sql.replace(/\?/g, () => `$${++n}`), args)).rows; }
      const stmt = client.prepare(sql);
      return stmt.reader ? stmt.all(...args) : (stmt.run(...args), []);
    };
    await query(isProduction ? 'BEGIN' : 'BEGIN IMMEDIATE');
    if (isProduction) await query('SELECT pg_advisory_xact_lock(824618)');
    const tx = {
      query,
      async list(kind) { return (await query('SELECT * FROM freeport_records WHERE kind = ? ORDER BY updated_at, id', [kind])).map(decode); },
      async get(kind, id) { const row = (await query('SELECT * FROM freeport_records WHERE kind = ? AND id = ?', [kind, id]))[0]; if (!row) throw fail(404, 'Record not found.'); return decode(row); },
      async save(kind, data, version) {
        const old = (await query('SELECT * FROM freeport_records WHERE kind = ? AND id = ?', [kind, data.id]))[0];
        if (old && Number(version) !== Number(old.version)) throw fail(409, 'Another staff member changed this record. Reload before saving.');
        const next = Number(old?.version || 0) + 1;
        const body = { ...data }; delete body.version;
        await query('INSERT INTO freeport_records(kind,id,version,body,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET version=excluded.version,body=excluded.body,updated_at=excluded.updated_at', [kind, data.id, next, JSON.stringify(body), new Date().toISOString()]);
        return { ...body, version: next };
      },
      async audit(actor, action, id, detail = {}) { await query('INSERT INTO freeport_audit VALUES(?,?,?,?,?,?)', [randomUUID(), actor, action, id, JSON.stringify(detail), new Date().toISOString()]); }
    };
    const result = await fn(tx);
    await query('COMMIT');
    return result;
  } catch (error) {
    if (client) { try { isProduction ? await client.query('ROLLBACK') : client.exec('ROLLBACK'); } catch {} }
    throw error;
  } finally { if (isProduction) client?.release(); release(); }
}
function decode(row) { return { ...JSON.parse(row.body), version: Number(row.version) }; }
export function fail(status, message) { return Object.assign(new Error(message), { status }); }
