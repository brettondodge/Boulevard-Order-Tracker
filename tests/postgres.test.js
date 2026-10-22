import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import Database from 'better-sqlite3';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { recordFingerprint } from '../src/record-fingerprint.js';

// Uses a fresh temporary cluster and synthetic records only. No provider credentials.
test('real Postgres production access, orders, admin gate and restart persistence', { timeout: 90000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'boulevard-pg-test-'));
  const cluster = new EmbeddedPostgres({ databaseDir: path.join(directory, 'cluster'), port: 55439, user: 'testuser', password: 'test-password', persistent: false, onLog: () => {}, onError: () => {} });
  let server;
  let pool;
  try {
    await cluster.initialise(); await cluster.start(); await cluster.createDatabase('tracker_test');
    const connection = 'postgresql://testuser:test-password@127.0.0.1:55439/tracker_test';
    pool = new pg.Pool({ connectionString: connection });
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey); jwk.kid = 'test-key'; jwk.alg = 'RS256';
    const preload = path.join(directory, 'jwks.mjs');
    // Only this test child intercepts Cloudflare JWKS; production has no bypass setting.
    await writeFile(preload, `const original=globalThis.fetch; globalThis.fetch=(url, options)=>String(url)==='https://test-team.cloudflareaccess.com/cdn-cgi/access/certs' ? Promise.resolve(new Response(${JSON.stringify(JSON.stringify({ keys: [jwk] }))}, {headers:{'content-type':'application/json'}})) : original(url,options);`);
    const env = { ...process.env, NODE_ENV: 'production', RENDER: 'false', DATABASE_URL: connection, SESSION_SECRET: 'synthetic-test-secret-longer-than-32-characters', ADMIN_USERNAME: 'office-admin', ADMIN_PASSWORD: 'synthetic-admin-password', CF_ACCESS_TEAM_DOMAIN: 'test-team.cloudflareaccess.com', CF_ACCESS_AUD: 'test-audience', PREVIEW_MODE: 'false', APP_PORT: '4209' };
    async function start() {
      let output = '';
      server = spawn(process.execPath, ['--import', preload, 'src/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      server.stderr.on('data', chunk => { output += chunk; });
      for (let i = 0; i < 100; i++) {
        if (server.exitCode !== null) throw new Error(`Production server exited: ${output}`);
        try { if ((await fetch('http://127.0.0.1:4209/healthz')).ok) return; } catch {}
        await delay(100);
      }
      throw new Error('Startup timed out');
    }
    async function stop() { if (server && server.exitCode === null && server.signalCode === null) { const done = once(server, 'exit'); server.kill(); await done; } }
    const token = await new SignJWT({ email: 'staff@example.test' }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer('https://test-team.cloudflareaccess.com').setAudience('test-audience').setSubject('staff-id').setIssuedAt().setExpirationTime('1h').sign(privateKey);
    let cookie = '';
    async function request(route, body, tokenValue = token, host = 'tools.blvdglass.com', methodOverride) {
      const response = await fetch(`http://127.0.0.1:4209${route}`, { method: methodOverride || (body ? 'POST' : 'GET'), headers: { Host: host, 'X-Forwarded-Host': host, 'X-Forwarded-Proto': 'https', 'Cf-Access-Jwt-Assertion': tokenValue, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) { assert.match(setCookie, /Secure/); cookie = setCookie.split(';')[0]; }
      return { status: response.status, body: await response.json() };
    }
    await start();
    assert.equal((await request('/api/orders', null, '')).status, 403);
    assert.equal((await request('/api/orders', null, 'forged')).status, 403);
    assert.equal((await request('/api/orders', null, token, 'tracker.onrender.com')).status, 403);
    const wrongAudience = await new SignJWT({ email: 'staff@example.test' }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer('https://test-team.cloudflareaccess.com').setAudience('wrong-audience').setSubject('staff-id').setIssuedAt().setExpirationTime('1h').sign(privateKey);
    assert.equal((await request('/api/orders', null, wrongAudience)).status, 403);
    for (const claims of [{ issuer: 'https://wrong.cloudflareaccess.com', expires: '1h' }, { issuer: 'https://test-team.cloudflareaccess.com', expires: '-1h' }]) {
      const invalid = await new SignJWT({ email: 'staff@example.test' }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer(claims.issuer).setAudience('test-audience').setSubject('staff-id').setIssuedAt().setExpirationTime(claims.expires).sign(privateKey);
      assert.equal((await request('/api/orders', null, invalid)).status, 403);
    }

    const identity = await request('/api/me');
    assert.equal(identity.status, 200, JSON.stringify(identity));
    assert.equal(identity.body.user.username, 'staff@example.test');
    assert.equal((await request('/api/master-lists/suppliers', { name: 'Blocked Supplier' })).status, 401);
    assert.equal((await request('/api/admin/login', { username: 'office-admin', password: 'synthetic-admin-password' })).status, 200);

    // Freeport records share Access identity and come from the Postgres migration.
    assert.equal((await request('/api/freeport/config')).body.accounts.length, 14);
    const freeportInvoice = { number: 'PG-1', installDate: '2026-09-29', omegaDate: '2026-10-06', orderNumber: '100000000001', accountCode: '1060401328', status: 'Ready', lines: [{ sku: 'Labor', quantity: '2.5', rateCents: 12500 }] };
    const createdInvoice = await request('/api/freeport/invoices', freeportInvoice);
    assert.equal(createdInvoice.status, 201, JSON.stringify(createdInvoice.body));
    assert.equal(createdInvoice.body.billingMonth, '2026-09');
    assert.equal(createdInvoice.body.createdBy, 'staff@example.test');
    assert.equal((await request('/api/freeport/invoices', freeportInvoice)).status, 409);
    assert.deepEqual((await request('/api/freeport/months')).body, [{ month: '2026-09', invoices: 1, needsReview: 0 }]);
    assert.equal((await request('/api/freeport/invoices/PG-1', { ...freeportInvoice, version: 9 }, token, 'tools.blvdglass.com', 'PUT')).status, 409);
    const fingerprint = await recordFingerprint(pool);
    assert.equal(fingerprint.freeport_invoices.count, 1);
    assert.equal(fingerprint.freeport_accounts.count, 14);
    await request('/api/master-lists/suppliers', { items: [{ name: 'Test Supplier', active: true }] });
    const order = await request('/api/orders', { customer_name: 'Synthetic Test Job', supplier: 'Test Supplier', ordered_by: 'Test Staff', category: 'Windows', date_ordered: '2026-10-10' });
    assert.equal(order.status, 201);
    // Legacy names remain searchable in orders but do not populate staff choices.
    await pool.query("INSERT INTO orders (id, customer_name, supplier, date_ordered, ordered_by, created_at, updated_at) VALUES ('historical-1', 'Synthetic history', 'Test Supplier', '2026-10-10', 'alice', '2026-10-10', '2026-10-10'), ('historical-2', 'Synthetic history', 'Test Supplier', '2026-10-10', 'alice', '2026-10-10', '2026-10-10'), ('historical-3', 'Synthetic history', 'Test Supplier', '2026-10-10', 'Zoe', '2026-10-10', '2026-10-10')");
    const lists = await request('/api/master-lists');
    assert.equal(lists.status, 200);
    assert.deepEqual(lists.body.ordered_by_options, lists.body.staff_names.map(item => item.name));
    assert.equal(lists.body.ordered_by_options.includes('alice'), false);
    assert.equal(lists.body.ordered_by_options.includes('Zoe'), false);
    await pool.query("DELETE FROM orders WHERE id IN ('historical-1', 'historical-2', 'historical-3')");
    // A failed asynchronous database request returns a safe error, and the
    // process remains alive instead of restarting and breaking live updates.
    await pool.query('ALTER TABLE orders RENAME TO orders_unavailable');
    try {
      const failed = await request('/api/orders');
      assert.equal(failed.status, 500);
      assert.deepEqual(failed.body, { error: 'Unable to complete this request right now.' });
      assert.equal((await fetch('http://127.0.0.1:4209/healthz')).status, 200);
    } finally { await pool.query('ALTER TABLE orders_unavailable RENAME TO orders'); }
    assert.equal((await request('/api/orders')).body.orders.length, 1);
    const stream = await fetch('http://127.0.0.1:4209/api/events', { headers: { Host: 'tools.blvdglass.com', 'X-Forwarded-Host': 'tools.blvdglass.com', 'X-Forwarded-Proto': 'https', 'Cf-Access-Jwt-Assertion': token, Cookie: cookie }, signal: AbortSignal.timeout(5000) });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get('content-type'), /text\/event-stream/);
    const reader = stream.body.getReader();
    try { assert.match(new TextDecoder().decode((await reader.read()).value), /event: connected/); }
    finally { await reader.cancel(); }
    assert.equal(Number((await pool.query('SELECT count(*) AS count FROM orders')).rows[0].count), 1);
    assert.equal(Number((await pool.query("SELECT count(*) AS count FROM users WHERE username='mary'")).rows[0].count), 0);
    const sessionsBefore = (await pool.query('SELECT sid FROM sessions')).rows.map(row => row.sid);
    assert.ok(sessionsBefore.length);
    await stop(); await start();
    assert.equal((await request('/api/orders')).body.orders.length, 1);
    assert.equal((await request('/api/admin/me')).status, 200);
    assert.equal((await request('/api/freeport/invoices/PG-1')).body.lines[0].quantity, '2.5');
    assert.equal((await request('/api/freeport/config')).body.accounts.length, 14);
    const sessionsAfter = (await pool.query('SELECT sid FROM sessions')).rows.map(row => row.sid);
    assert.deepEqual(sessionsAfter, sessionsBefore);
    // Rename/deactivate a linked supplier and staff member: filters use stable IDs.
    const savedSupplier = order.body.order.supplier_id;
    const staff = await request('/api/master-lists/ordered-by', { items: [{ name: 'Original Staff', active: true }] });
    const staffId = staff.body.staff_names[0].id;
    await pool.query('UPDATE orders SET ordered_by_id=$1, ordered_by=$2 WHERE id=$3', [staffId, 'Original Staff', order.body.order.id]);
    await request('/api/master-lists/ordered-by', { items: [{ id: staffId, name: 'Renamed Staff', active: true }] });
    await request('/api/master-lists/suppliers', { items: [{ id: savedSupplier, name: 'Renamed Supplier', active: false }] });
    const filtered = await request(`/api/orders?supplier=${savedSupplier}&ordered_by=${staffId}`);
    assert.equal(filtered.body.orders.length, 1);
    assert.equal(filtered.body.orders[0].supplier, 'Renamed Supplier');
    assert.equal(filtered.body.orders[0].ordered_by, 'Renamed Staff');
    assert.ok((await request('/api/master-lists')).body.supplier_filter_options.some(item => item.id === savedSupplier && item.active === false));
    assert.equal((await request('/api/suppliers')).body.suppliers.includes('Renamed Supplier'), false);
    // Cleanup does not cascade to drafts or orders linked to an active supplier.
    await pool.query("INSERT INTO job_drafts (id, customer_name, created_at, updated_at) VALUES ('cleanup-draft', 'Synthetic Draft', '2026-10-10', '2026-10-10')");
    await pool.query('UPDATE orders SET job_draft_id=$1 WHERE id=$2', ['cleanup-draft', order.body.order.id]);
    await request('/api/master-lists/suppliers', { items: [{ name: 'Active Supplier', active: true }] });
    const supplierCount = Number((await pool.query('SELECT count(*) FROM suppliers')).rows[0].count);
    assert.equal((await request('/api/orders', { customer_name: 'Unknown supplier', supplier: 'Never Added', ordered_by: 'Renamed Staff', category: 'Windows', date_ordered: '2026-10-10' })).status, 400);
    assert.equal((await request('/api/orders', { customer_name: 'Inactive supplier', supplier: 'Renamed Supplier', supplier_id: savedSupplier, ordered_by: 'Renamed Staff', category: 'Windows', date_ordered: '2026-10-10' })).status, 400);
    assert.equal(Number((await pool.query('SELECT count(*) FROM suppliers')).rows[0].count), supplierCount);
    assert.equal((await pool.query('SELECT active FROM suppliers WHERE id=$1', [savedSupplier])).rows[0].active, 0);
    const editInactive = await request(`/api/orders/${order.body.order.id}`, { ...filtered.body.orders[0], notes: 'Edit inactive history' }, token, 'tools.blvdglass.com', 'PUT');
    assert.equal(editInactive.status, 200);
    assert.equal((await pool.query('SELECT active FROM suppliers WHERE id=$1', [savedSupplier])).rows[0].active, 0);
    assert.equal((await request(`/api/orders/${order.body.order.id}`, { ...editInactive.body.order, supplier: 'Never Added', supplier_id: '' }, token, 'tools.blvdglass.com', 'PUT')).status, 400);
    const other = await request('/api/orders', { customer_name: 'Other synthetic job', supplier: 'Active Supplier', ordered_by: 'Renamed Staff', category: 'Windows', date_ordered: '2026-10-10' });
    assert.equal(other.status, 201);
    let preview = await request('/api/admin/inactive-suppliers/preview');
    assert.equal(preview.body.supplier_count, 1); assert.equal(preview.body.order_count, 1);
    assert.equal((await request('/api/admin/inactive-suppliers/delete', {confirmation_token: preview.body.confirmation_token, confirmation:'wrong'})).status, 409);
    await pool.query('UPDATE orders SET notes=$1 WHERE id=$2', ['Changed since preview', order.body.order.id]);
    assert.equal((await request('/api/admin/inactive-suppliers/delete', {confirmation_token: preview.body.confirmation_token, confirmation:'DELETE'})).status, 409);
    assert.equal(Number((await pool.query('SELECT count(*) FROM orders')).rows[0].count),2);
    preview = await request('/api/admin/inactive-suppliers/preview');
    const removed = await request('/api/admin/inactive-suppliers/delete', {confirmation_token: preview.body.confirmation_token, confirmation:'DELETE'});
    assert.equal(removed.status,200); assert.deepEqual(removed.body,{deleted_suppliers:1,deleted_orders:1});
    assert.equal((await pool.query('SELECT id FROM orders')).rows[0].id,other.body.order.id);
    assert.equal(Number((await pool.query('SELECT count(*) FROM job_drafts WHERE id=$1',['cleanup-draft'])).rows[0].count),1);
    assert.equal(Number((await pool.query('SELECT count(*) FROM suppliers WHERE id=$1',[savedSupplier])).rows[0].count),0);
    assert.equal((await request('/api/admin/inactive-suppliers/delete', {confirmation_token: preview.body.confirmation_token, confirmation:'DELETE'})).status,409);
    for (const name of ['North Valley Glass', 'Pacific Hardware']) {
      await pool.query('INSERT INTO orders (id, customer_name, supplier, date_ordered, job_draft_id, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)', [`history-${name}`, 'Synthetic history', name, '2026-10-11', 'cleanup-draft', '2026-10-11', '2026-10-11']);
    }
    const historicalLists = (await request('/api/master-lists')).body;
    assert.ok(historicalLists.historical_suppliers.some(row => row.name === 'North Valley Glass' && row.order_count === 1));
    assert.ok(historicalLists.supplier_filter_options.some(row => row.name === 'Pacific Hardware' && row.historical === true && row.active !== false));
    preview = await request('/api/admin/inactive-suppliers/preview');
    assert.equal(preview.body.order_count, 0);
    // The delete request cannot broaden the scope stored with the preview.
    assert.deepEqual((await request('/api/admin/inactive-suppliers/delete', {confirmation_token: preview.body.confirmation_token, confirmation:'DELETE', include_historical: true})).body, { deleted_suppliers: 0, deleted_orders: 0 });
    preview = await request('/api/admin/inactive-suppliers/preview?include_historical=true');
    assert.equal(preview.body.historical_supplier_count, 2); assert.equal(preview.body.order_count, 2);
    await pool.query('UPDATE orders SET notes=$1 WHERE id=$2', ['Changed history', 'history-Pacific Hardware']);
    assert.equal((await request('/api/admin/inactive-suppliers/delete', {confirmation_token: preview.body.confirmation_token, confirmation:'DELETE'})).status, 409);
    assert.equal(Number((await pool.query('SELECT count(*) FROM orders')).rows[0].count), 3);
    preview = await request('/api/admin/inactive-suppliers/preview?include_historical=true');
    assert.deepEqual((await request('/api/admin/inactive-suppliers/delete', {confirmation_token: preview.body.confirmation_token, confirmation:'DELETE'})).body, { deleted_suppliers: 0, deleted_orders: 2 });
    assert.equal((await pool.query('SELECT id FROM orders')).rows[0].id, other.body.order.id);
    assert.equal(Number((await pool.query('SELECT count(*) FROM job_drafts WHERE id=$1', ['cleanup-draft'])).rows[0].count), 1);
    await stop();
    await cluster.createDatabase('import_test');
    const sqliteFile = path.join(directory, 'synthetic.db');
    const sqlite = new Database(sqliteFile);
    const schema = await readFile(new URL('../migrations/001-initial.sql', import.meta.url), 'utf8');
    sqlite.exec(schema.slice(0, schema.indexOf('CREATE TABLE IF NOT EXISTS sessions')));
    const timestamp = '2026-10-10T00:00:00.000Z';
    sqlite.prepare('INSERT INTO job_drafts (id, customer_name, created_at, updated_at) VALUES (?, ?, ?, ?)').run('stable-draft', 'Synthetic Job', timestamp, timestamp);
    sqlite.prepare('INSERT INTO suppliers (id, name, created_at) VALUES (?, ?, ?)').run('stable-supplier', 'Synthetic Supplier', timestamp);
    sqlite.prepare('INSERT INTO orders (id, customer_name, supplier, supplier_id, date_ordered, job_draft_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('stable-order', 'Synthetic Job', 'Synthetic Supplier', 'stable-supplier', '2026-10-10', 'stable-draft', timestamp, timestamp);
    sqlite.close();
    async function runImport() {
      const child = spawn(process.execPath, ['scripts/import-sqlite.js', sqliteFile], { env: { ...process.env, IMPORT_DATABASE_URL: connection.replace('/tracker_test', '/import_test'), CONFIRM_EMPTY_IMPORT: 'yes' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = ''; child.stdout.on('data', chunk => { output += chunk; });
      const [code] = await once(child, 'exit'); return { code, output };
    }
    const imported = await runImport();
    assert.equal(imported.code, 0, imported.output);
    assert.equal(JSON.parse(imported.output).exactFieldComparison, true);
    assert.equal((await runImport()).code, 1, 'Second import must refuse a populated target');
    const importPool = new pg.Pool({ connectionString: connection.replace('/tracker_test', '/import_test') });
    try {
      const saved = (await importPool.query('SELECT id, job_draft_id, supplier_id FROM orders')).rows;
      assert.deepEqual(saved, [{ id: 'stable-order', job_draft_id: 'stable-draft', supplier_id: 'stable-supplier' }]);
    } finally { await importPool.end(); }
  } finally {
    if (server && server.exitCode === null && server.signalCode === null) { const done = once(server, 'exit'); server.kill(); await done; }
    await pool?.end(); await cluster.stop();
  }
});
