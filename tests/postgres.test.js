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
    async function request(route, body, tokenValue = token, host = 'tools.blvdglass.com') {
      const response = await fetch(`http://127.0.0.1:4209${route}`, { method: body ? 'POST' : 'GET', headers: { Host: host, 'X-Forwarded-Host': host, 'X-Forwarded-Proto': 'https', 'Cf-Access-Jwt-Assertion': tokenValue, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
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
    const order = await request('/api/orders', { customer_name: 'Synthetic Test Job', supplier: 'Test Supplier', ordered_by: 'Test Staff', category: 'Windows', date_ordered: '2026-10-10' });
    assert.equal(order.status, 201);
    assert.equal(Number((await pool.query('SELECT count(*) AS count FROM orders')).rows[0].count), 1);
    assert.equal(Number((await pool.query("SELECT count(*) AS count FROM users WHERE username='mary'")).rows[0].count), 0);
    const sessionsBefore = (await pool.query('SELECT sid FROM sessions')).rows.map(row => row.sid);
    assert.ok(sessionsBefore.length);
    await stop(); await start();
    assert.equal((await request('/api/orders')).body.orders.length, 1);
    assert.equal((await request('/api/admin/me')).status, 200);
    const sessionsAfter = (await pool.query('SELECT sid FROM sessions')).rows.map(row => row.sid);
    assert.deepEqual(sessionsAfter, sessionsBefore);
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
