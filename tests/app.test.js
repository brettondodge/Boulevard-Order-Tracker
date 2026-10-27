import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import express from 'express';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import {
  createPostgresSessionStore,
  configureSessionMiddleware
} from '../src/session-config.js';
import { syntheticOrderSheet } from './sheet-fixture.js';

const root = process.cwd();

function createCookieJar() {
  const cookies = new Map();

  return {
    record(response) {
      const setCookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [];
      for (const value of setCookies) {
        const [pair] = value.split(';');
        const [name, ...rest] = pair.split('=');
        if (!name || !rest.length) continue;
        cookies.set(name, rest.join('='));
      }
    },
    headers() {
      return cookies.size
        ? { Cookie: [...cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ') }
        : {};
    }
  };
}

function startServer() {
  const env = {
    ...process.env,
    SESSION_SECRET: 'test-secret',
    PREVIEW_MODE: 'true',
    APP_PORT: '4100',
    NODE_ENV: 'test',
    RENDER: 'false',
    SQLITE_DATA_DIR: mkdtempSync(path.join(tmpdir(), 'boulevard-test-')),
    // Never reach the real Omega API from tests, even with a key in the local .env.
    OMEGA_API_KEY: ''
  };
  // Explicit master-list fixtures for order tests. Runtime order creation must
  // never provision suppliers implicitly.
  const fixture = new Database(path.join(env.SQLITE_DATA_DIR, 'boulevard_orders.db'));
  fixture.exec('CREATE TABLE suppliers (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)');
  for (const name of ['Northline Glass', 'Oldcastle', 'Arrow Shower Door', 'Bayside Supply']) {
    fixture.prepare('INSERT INTO suppliers (id, name, active, created_at, updated_at) VALUES (?, ?, 1, ?, ?)').run(`fixture-${name}`, name, '2026-10-11', '2026-10-11');
  }
  fixture.close();

  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  child.testDataDir = env.SQLITE_DATA_DIR;
  return child;
}

test('production session store is a real express-session Store', () => {
  const store = createPostgresSessionStore({
    query: async () => ({ rows: [], rowCount: 0 })
  });

  assert.ok(store instanceof session.Store);
  assert.equal(typeof store.get, 'function');
  assert.equal(typeof store.set, 'function');
  assert.equal(typeof store.destroy, 'function');
});

test('Render proxy config keeps secure cookies enabled for HTTPS', async () => {
  const app = express();
  const fakeStore = createPostgresSessionStore({
    query: async () => ({ rows: [], rowCount: 0 })
  });

  configureSessionMiddleware(app, { store: fakeStore, isProduction: true, secret: 'render-proxy-test' });

  app.get('/session-check', (req, res) => {
    req.session.user = { username: 'admin' };
    res.json({ ok: true, user: req.session.user });
  });

  await new Promise((resolve) => {
    const server = app.listen(0, async () => {
      const { port } = server.address();
      const response = await fetch(`http://127.0.0.1:${port}/session-check`, {
        headers: {
          'X-Forwarded-Proto': 'https'
        }
      });

      const cookieHeader = response.headers.get('set-cookie') || '';
      assert.match(cookieHeader, /Secure/i);
      assert.match(cookieHeader, /SameSite=Lax/i);
      server.close(resolve);
    });
  });
});

async function requestJson(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.cookieJar) {
    Object.assign(headers, options.cookieJar.headers());
  }

  const response = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body
  });

  const bodyText = await response.text();
  let body = {};
  if (bodyText) {
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = bodyText;
    }
  }

  if (options.cookieJar) {
    options.cookieJar.record(response);
  }

  return { status: response.status, body, text: bodyText };
}

test('server starts and exposes login page', async () => {
  const child = startServer();
  await delay(1500);

  const response = await requestJson('http://127.0.0.1:4100/login');

  child.kill('SIGTERM');

  assert.equal(response.status, 200);
  assert.match(response.text, /Boulevard Glass Order Tracker/i);
});

test('orders remain publicly searchable without a staff login', async () => {
  const child = startServer();
  await delay(1500);

  const response = await requestJson('http://127.0.0.1:4100/api/orders');

  child.kill('SIGTERM');

  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body.orders));
});

test('ordered-by is required when creating an order', async () => {
  const child = startServer();
  await delay(1500);

  const cookieJar = createCookieJar();
  const login = await requestJson('http://127.0.0.1:4100/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'mary', password: 'staff123' }),
    cookieJar
  });

  assert.equal(login.status, 200);

  const response = await requestJson('http://127.0.0.1:4100/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_name: 'Missing Ordered By',
      supplier: 'Northline Glass',
      category: 'Windows',
      date_ordered: '2026-10-12'
    }),
    cookieJar
  });

  child.kill('SIGTERM');

  assert.equal(response.status, 400);
  assert.match(String(response.body.error || ''), /ordered by/i);
});

test('admin master-list editing is protected and ordered-by data persists', async () => {
  const child = startServer();
  await delay(1500);

  const cookieJar = createCookieJar();
  const publicListCheck = await requestJson('http://127.0.0.1:4100/api/master-lists');
  assert.equal(publicListCheck.status, 200);

  const blockedSupplierUpdate = await requestJson('http://127.0.0.1:4100/api/master-lists/suppliers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [{ name: 'Widget Glass', active: true }] })
  });
  assert.equal(blockedSupplierUpdate.status, 401);

  const login = await requestJson('http://127.0.0.1:4100/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    cookieJar
  });

  assert.equal(login.status, 200);

  const saveStaff = await requestJson('http://127.0.0.1:4100/api/master-lists/ordered-by', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: [
        { id: '', name: 'Alice Johnson', active: true },
        { id: '', name: 'Brian Lee', active: true }
      ]
    }),
    cookieJar
  });

  assert.equal(saveStaff.status, 200);
  const staffAlice = saveStaff.body.staff_names.find((person) => person.name === 'Alice Johnson');
  assert.ok(staffAlice);

  const saveSupplier = await requestJson('http://127.0.0.1:4100/api/master-lists/suppliers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: [
        { id: '', name: 'Northline Glass', active: true },
        { id: '', name: 'Bayside Supply', active: true }
      ]
    }),
    cookieJar
  });

  assert.equal(saveSupplier.status, 200);
  assert.ok(saveSupplier.body.suppliers.some((supplier) => supplier.name === 'Northline Glass'));

  const createdOrder = await requestJson('http://127.0.0.1:4100/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_name: 'Master List Test',
      supplier: 'Northline Glass',
      category: 'Windows',
      date_ordered: '2026-10-12',
      ordered_by: 'Alice Johnson',
      ordered_by_id: staffAlice.id
    }),
    cookieJar
  });

  assert.equal(createdOrder.status, 201);
  assert.equal(createdOrder.body.order.ordered_by, 'Alice Johnson');

  const reloaded = await requestJson('http://127.0.0.1:4100/api/orders?search=Master%20List%20Test');
  child.kill('SIGTERM');

  assert.equal(reloaded.status, 200);
  assert.ok(reloaded.body.orders.some((order) => order.ordered_by === 'Alice Johnson'));
});

test('category and group filters work with supplier selection', async () => {
  const child = startServer();
  await delay(1500);

  const cookieJar = createCookieJar();

  const login = await requestJson('http://127.0.0.1:4100/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    cookieJar
  });

  assert.equal(login.status, 200);

  const createWindows = await requestJson('http://127.0.0.1:4100/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_name: 'Category Test',
      supplier: 'Oldcastle',
      category: 'Windows',
      date_ordered: '2026-10-09',
      ordered_by: 'Admin User'
    }),
    cookieJar
  });

  const createFlat = await requestJson('http://127.0.0.1:4100/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_name: 'Category Test 2',
      supplier: 'Oldcastle',
      category: 'Flat Glass',
      date_ordered: '2026-10-10',
      ordered_by: 'Admin User'
    }),
    cookieJar
  });

  const createShowers = await requestJson('http://127.0.0.1:4100/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_name: 'Category Test 3',
      supplier: 'Oldcastle',
      category: 'Showers',
      date_ordered: '2026-10-11',
      ordered_by: 'Admin User'
    }),
    cookieJar
  });

  assert.equal(createWindows.status, 201);
  assert.equal(createFlat.status, 201);
  assert.equal(createShowers.status, 201);

  const groupResponse = await requestJson(
    'http://127.0.0.1:4100/api/orders?view=Windows%20%2F%20Flat%20Glass&supplier=Oldcastle',
    { cookieJar }
  );
  const categoryResponse = await requestJson(
    'http://127.0.0.1:4100/api/orders?category=Windows&supplier=Oldcastle',
    { cookieJar }
  );

  child.kill('SIGTERM');

  assert.equal(groupResponse.status, 200);
  assert.equal(categoryResponse.status, 200);
  assert.ok(groupResponse.body.orders.some((order) => order.category === 'Windows'));
  assert.ok(groupResponse.body.orders.some((order) => order.category === 'Flat Glass'));
  assert.ok(categoryResponse.body.orders.every((order) => order.category === 'Windows'));
});

test('ordered-by multi-select filter supports any-of matching and historical names', async () => {
  const child = startServer();
  await delay(1500);

  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const supplierA = `Filter Test Supplier A ${suffix}`;
  const supplierB = `Filter Test Supplier B ${suffix}`;
  const supplierC = `Filter Test Supplier C ${suffix}`;
  const orderAlex = `Ordered By Alex Filter ${suffix}`;
  const orderBeth = `Ordered By Beth Filter ${suffix}`;
  const orderCarol = `Ordered By Carol Filter ${suffix}`;

  const cookieJar = createCookieJar();
  const login = await requestJson('http://127.0.0.1:4100/api/admin/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
    cookieJar
  });

  assert.equal(login.status, 200);

  await requestJson('http://127.0.0.1:4100/api/master-lists/suppliers', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: [supplierA, supplierB, supplierC].map(name => ({ name, active: true })) }), cookieJar
  });
  const alex = await requestJson('http://127.0.0.1:4100/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_name: orderAlex,
      supplier: supplierA,
      category: 'Windows',
      date_ordered: '2026-10-13',
      ordered_by: 'Alex Morgan'
    }),
    cookieJar
  });

  const beth = await requestJson('http://127.0.0.1:4100/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_name: orderBeth,
      supplier: supplierB,
      category: 'Flat Glass',
      date_ordered: '2026-10-14',
      ordered_by: 'Beth Nguyen'
    }),
    cookieJar
  });

  const carol = await requestJson('http://127.0.0.1:4100/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_name: orderCarol,
      supplier: supplierC,
      category: 'Windows',
      date_ordered: '2026-10-15',
      ordered_by: 'Carol Smith'
    }),
    cookieJar
  });

  assert.equal(alex.status, 201);
  assert.equal(beth.status, 201);
  assert.equal(carol.status, 201);

  const filtered = await requestJson(
    `http://127.0.0.1:4100/api/orders?supplier=${encodeURIComponent(supplierA)}&supplier=${encodeURIComponent(supplierB)}&ordered_by=${encodeURIComponent('Alex Morgan')}&ordered_by=${encodeURIComponent('Beth Nguyen')}&status=Outstanding`,
    { cookieJar }
  );

  assert.equal(filtered.status, 200);
  assert.ok(filtered.body.orders.some((order) => order.customer_name === orderAlex));
  assert.ok(filtered.body.orders.some((order) => order.customer_name === orderBeth));
  assert.ok(filtered.body.orders.every((order) => ['Alex Morgan', 'Beth Nguyen'].includes(order.ordered_by)));

  const historicalLookup = await requestJson(
    `http://127.0.0.1:4100/api/orders?ordered_by=${encodeURIComponent('Alex Morgan')}&status=Outstanding`,
    { cookieJar }
  );

  assert.equal(historicalLookup.status, 200);
  assert.ok(historicalLookup.body.orders.some((order) => order.customer_name === orderAlex));

  child.kill('SIGTERM');
});

test('approved job drafts stay queued until deposit is received or waived and can create supplier orders', async () => {
  const child = startServer();
  await delay(1500);

  const cookieJar = createCookieJar();
  const login = await requestJson('http://127.0.0.1:4100/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'mary', password: 'staff123' }),
    cookieJar
  });

  assert.equal(login.status, 200);

  const draftName = `Draft Queue ${Date.now()}`;
  const draftResponse = await requestJson('http://127.0.0.1:4100/api/job-drafts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_name: draftName,
      housecall_job_number: 'HC-DRAFT-1001',
      housecall_job_link: 'https://example.com/jobs/hc-draft-1001',
      notes: 'Approved and waiting on deposit.',
      deposit_status: 'Awaiting deposit',
      hcp_job_id: 'hcp-draft-1001'
    }),
    cookieJar
  });

  assert.equal(draftResponse.status, 201);
  assert.equal(draftResponse.body.draft.deposit_status, 'Awaiting deposit');
  assert.equal(draftResponse.body.draft.status, 'Open');

  const draftId = draftResponse.body.draft.id;
  const blockedOrder = await requestJson('http://127.0.0.1:4100/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_name: draftName,
      housecall_job_number: 'HC-DRAFT-1001',
      job_draft_id: draftId,
      supplier: 'Northline Glass',
      category: 'Windows',
      date_ordered: '2026-10-18',
      ordered_by: 'Admin User'
    }),
    cookieJar
  });

  assert.equal(blockedOrder.status, 400);
  assert.match(String(blockedOrder.body.error || ''), /deposit/i);

  const readyResponse = await requestJson(`http://127.0.0.1:4100/api/job-drafts/${draftId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deposit_status: 'Deposit received',
      notes: 'Approved and deposit received.',
      updated_at: draftResponse.body.draft.updated_at
    }),
    cookieJar
  });

  assert.equal(readyResponse.status, 200);
  assert.equal(readyResponse.body.draft.deposit_status, 'Deposit received');

  const supplierOrder = await requestJson('http://127.0.0.1:4100/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_name: draftName,
      housecall_job_number: 'HC-DRAFT-1001',
      job_draft_id: draftId,
      supplier: 'Northline Glass',
      category: 'Windows',
      date_ordered: '2026-10-18',
      ordered_by: 'Admin User'
    }),
    cookieJar
  });

  assert.equal(supplierOrder.status, 201);
  assert.equal(supplierOrder.body.order.job_draft_id, draftId);

  const completeResponse = await requestJson(`http://127.0.0.1:4100/api/job-drafts/${draftId}/complete`, {
    method: 'POST',
    cookieJar
  });

  assert.equal(completeResponse.status, 200);
  assert.equal(completeResponse.body.draft.status, 'Completed');

  const reopenedResponse = await requestJson(`http://127.0.0.1:4100/api/job-drafts/${draftId}/reopen`, {
    method: 'POST',
    cookieJar
  });

  assert.equal(reopenedResponse.status, 200);
  assert.equal(reopenedResponse.body.draft.status, 'Open');

  child.kill('SIGTERM');
});

test('draft queue keeps separate supplier orders out of overdue and delivery counts', async () => {
  const child = startServer();
  await delay(1500);

  const cookieJar = createCookieJar();
  const login = await requestJson('http://127.0.0.1:4100/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'mary', password: 'staff123' }),
    cookieJar
  });

  assert.equal(login.status, 200);

  const draftResponse = await requestJson('http://127.0.0.1:4100/api/job-drafts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_name: `Draft Queue Only ${Date.now()}`,
      housecall_job_number: 'HC-DRAFT-1002',
      notes: 'Draft only; no materials ordered yet.',
      deposit_status: 'Deposit waived / not required',
      hcp_job_id: 'hcp-draft-1002'
    }),
    cookieJar
  });

  assert.equal(draftResponse.status, 201);
  const draftId = draftResponse.body.draft.id;

  const readyResponse = await requestJson(`http://127.0.0.1:4100/api/job-drafts/${draftId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deposit_status: 'Deposit waived / not required', updated_at: draftResponse.body.draft.updated_at }),
    cookieJar
  });

  assert.equal(readyResponse.status, 200);

  const createOrder = await requestJson('http://127.0.0.1:4100/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_name: readyResponse.body.draft.customer_name,
      housecall_job_number: readyResponse.body.draft.housecall_job_number,
      job_draft_id: draftId,
      supplier: 'Arrow Shower Door',
      category: 'Showers',
      date_ordered: '2026-10-20',
      ordered_by: 'Admin User'
    }),
    cookieJar
  });

  assert.equal(createOrder.status, 201);

  const queue = await requestJson('http://127.0.0.1:4100/api/job-drafts');
  assert.equal(queue.status, 200);
  assert.ok(queue.body.drafts.some((draft) => draft.id === draftId));
  assert.ok(createOrder.body.order.job_draft_id === draftId);

  child.kill('SIGTERM');
});

test('edits record who made them, can clear draft fields and lose cleanly to a newer save', async () => {
  const child = startServer();
  const cookieJar = createCookieJar();
  const base = 'http://127.0.0.1:4100';
  const api = (route, body, method = body ? 'POST' : 'GET') => requestJson(base + route, {
    method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), cookieJar
  });
  try {
    await delay(1500);
    assert.equal((await api('/api/login', { username: 'mary', password: 'staff123' })).status, 200);

    const created = await api('/api/job-drafts', { customer_name: 'Synthetic Clear Job', housecall_job_number: 'HC-CLEAR-1', housecall_job_link: 'https://example.com/jobs/clear', deposit_status: 'Deposit received' });
    assert.equal(created.status, 201);
    assert.equal(created.body.draft.created_by, 'mary');
    const draft = created.body.draft;

    // Blanking the job number and link must save as blank, not bring the old values back.
    const cleared = await api(`/api/job-drafts/${draft.id}`, { ...draft, housecall_job_number: '', housecall_job_link: '' }, 'PUT');
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.draft.housecall_job_number, '');
    assert.equal(cleared.body.draft.housecall_job_link, '');
    assert.equal(cleared.body.draft.updated_by, 'mary');
    assert.equal((await api(`/api/job-drafts/${draft.id}`, { notes: 'No version' }, 'PUT')).status, 400);
    const staleDraft = await api(`/api/job-drafts/${draft.id}`, { ...draft, notes: 'Stale' }, 'PUT');
    assert.equal(staleDraft.status, 409);
    assert.match(staleDraft.body.error, /Someone else changed this job/);

    const order = await api('/api/orders', { customer_name: 'Synthetic Clear Job', job_draft_id: draft.id, supplier: 'Northline Glass', category: 'Windows', date_ordered: '2026-10-18', ordered_by: 'Admin User' });
    assert.equal(order.status, 201);
    assert.equal(order.body.order.created_by, 'mary');
    const first = await api(`/api/orders/${order.body.order.id}`, { ...order.body.order, notes: 'First save' }, 'PUT');
    assert.equal(first.status, 200);
    const second = await api(`/api/orders/${order.body.order.id}`, { ...order.body.order, notes: 'Second save from an old screen' }, 'PUT');
    assert.equal(second.status, 409);
    assert.match(second.body.error, /Someone else changed this order/);
    assert.equal((await api(`/api/orders/${order.body.order.id}`, { ...order.body.order, updated_at: '' }, 'PUT')).status, 400);
    const saved = (await api('/api/orders?status=All')).body.orders.find(row => row.id === order.body.order.id);
    assert.equal(saved.notes, 'First save');

    const received = await api(`/api/orders/${order.body.order.id}/mark-received`, { updated_at: order.body.order.updated_at });
    assert.equal(received.status, 409);
    const receivedNow = await api(`/api/orders/${order.body.order.id}/mark-received`, { updated_at: first.body.order.updated_at });
    assert.equal(receivedNow.status, 200);
    assert.equal(receivedNow.body.order.updated_by, 'mary');

    const failed = await api('/api/orders', { customer_name: 'Synthetic Missing Job', job_draft_id: 'draft-that-does-not-exist', supplier: 'Northline Glass', category: 'Windows', ordered_by: 'Admin User' });
    assert.equal(failed.status, 404);
    assert.equal(failed.body.details, undefined);
  } finally {
    child.kill('SIGTERM');
  }
});

test('deleting a job removes it and its orders; undo brings back only what that delete removed', async () => {
  const child = startServer();
  await delay(1500);

  const cookieJar = createCookieJar();
  const login = await requestJson('http://127.0.0.1:4100/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'mary', password: 'staff123' }),
    cookieJar
  });

  assert.equal(login.status, 200);

  const sharedCustomer = `Archive Customer ${Date.now()}`;

  const firstDraft = await requestJson('http://127.0.0.1:4100/api/job-drafts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_name: sharedCustomer,
      housecall_job_number: `HC-ARCH-1-${Date.now()}`,
      hcp_job_id: `hcp-arch-1-${Date.now()}`,
      notes: 'First job kept for archive testing.',
      deposit_status: 'Deposit received'
    }),
    cookieJar
  });

  const secondDraft = await requestJson('http://127.0.0.1:4100/api/job-drafts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_name: sharedCustomer,
      housecall_job_number: `HC-ARCH-2-${Date.now()}`,
      hcp_job_id: `hcp-arch-2-${Date.now()}`,
      notes: 'Second job for same customer should remain active.',
      deposit_status: 'Deposit received'
    }),
    cookieJar
  });

  assert.equal(firstDraft.status, 201);
  assert.equal(secondDraft.status, 201);

  const firstOrder = await requestJson('http://127.0.0.1:4100/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_name: sharedCustomer,
      housecall_job_number: firstDraft.body.draft.housecall_job_number,
      job_draft_id: firstDraft.body.draft.id,
      supplier: 'Northline Glass',
      category: 'Windows',
      date_ordered: '2026-10-18',
      ordered_by: 'Admin User'
    }),
    cookieJar
  });

  const secondOrder = await requestJson('http://127.0.0.1:4100/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_name: sharedCustomer,
      housecall_job_number: secondDraft.body.draft.housecall_job_number,
      job_draft_id: secondDraft.body.draft.id,
      supplier: 'Bayside Supply',
      category: 'Flat Glass',
      date_ordered: '2026-10-19',
      ordered_by: 'Admin User'
    }),
    cookieJar
  });

  assert.equal(firstOrder.status, 201);
  assert.equal(secondOrder.status, 201);

  // An order on the first job deleted on its own earlier must stay deleted after the job's undo.
  const separatelyDeleted = await requestJson('http://127.0.0.1:4100/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_name: sharedCustomer,
      job_draft_id: firstDraft.body.draft.id,
      supplier: 'Oldcastle',
      category: 'Windows',
      date_ordered: '2026-10-18',
      ordered_by: 'Admin User'
    }),
    cookieJar
  });
  assert.equal(separatelyDeleted.status, 201);
  const orderDelete = await requestJson(`http://127.0.0.1:4100/api/orders/${separatelyDeleted.body.order.id}/delete`, { method: 'POST', cookieJar });
  assert.equal(orderDelete.status, 200);
  assert.equal(orderDelete.body.deleted, true);

  // Jobs can be deleted before their orders arrive (cancelled jobs, mistakes).
  const archiveResponse = await requestJson(`http://127.0.0.1:4100/api/job-drafts/${firstDraft.body.draft.id}/delete`, {
    method: 'POST',
    cookieJar
  });

  assert.equal(archiveResponse.status, 200);
  assert.equal(archiveResponse.body.deleted, true);
  assert.deepEqual(archiveResponse.body.order_ids, [firstOrder.body.order.id]);

  const activeOrders = await requestJson('http://127.0.0.1:4100/api/orders?status=All Orders');
  const archivedOrders = await requestJson('http://127.0.0.1:4100/api/orders?status=Archived');
  const activeDrafts = await requestJson('http://127.0.0.1:4100/api/job-drafts');

  assert.equal(activeOrders.status, 200);
  assert.equal(archivedOrders.status, 200);
  assert.ok(activeOrders.body.orders.some((order) => order.id === secondOrder.body.order.id));
  assert.ok(archivedOrders.body.orders.some((order) => order.id === firstOrder.body.order.id));
  assert.ok(!activeOrders.body.orders.some((order) => order.id === firstOrder.body.order.id));
  assert.ok(activeDrafts.body.drafts.some((draft) => draft.id === secondDraft.body.draft.id));
  assert.ok(!activeDrafts.body.drafts.some((draft) => draft.id === firstDraft.body.draft.id));

  const restoreResponse = await requestJson(`http://127.0.0.1:4100/api/job-drafts/${firstDraft.body.draft.id}/restore`, {
    method: 'POST',
    cookieJar
  });

  assert.equal(restoreResponse.status, 200);
  assert.equal(restoreResponse.body.restored, true);

  assert.deepEqual(restoreResponse.body.order_ids, [firstOrder.body.order.id]);
  const restoredOrders = await requestJson('http://127.0.0.1:4100/api/orders?status=Archived');
  assert.equal(restoredOrders.status, 200);
  assert.ok(!restoredOrders.body.orders.some((order) => order.id === firstOrder.body.order.id));
  assert.ok(restoredOrders.body.orders.some((order) => order.id === separatelyDeleted.body.order.id));
  assert.ok((await requestJson('http://127.0.0.1:4100/api/job-drafts')).body.drafts.some((draft) => draft.id === firstDraft.body.draft.id));

  const orderRestore = await requestJson(`http://127.0.0.1:4100/api/orders/${separatelyDeleted.body.order.id}/restore`, { method: 'POST', cookieJar });
  assert.equal(orderRestore.status, 200);
  assert.ok((await requestJson('http://127.0.0.1:4100/api/orders?status=All Orders')).body.orders.some((order) => order.id === separatelyDeleted.body.order.id));

  child.kill('SIGTERM');
});

test('master-list IDs survive renaming and deactivation; confirmed cleanup preserves drafts and other suppliers', async () => {
  const child = startServer();
  const cookieJar = createCookieJar();
  const base = 'http://127.0.0.1:4100';
  const api = (route, body, method = body ? 'POST' : 'GET', authorized = true) => requestJson(base + route, {
    method, headers: { 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), ...(authorized ? { cookieJar } : {})
  });
  try {
    await delay(1500);
    assert.equal((await api('/api/admin/inactive-suppliers/preview', null, 'GET', false)).status, 401);
    assert.equal((await api('/api/admin/inactive-suppliers/delete', {}, 'POST', false)).status, 401);
    assert.equal((await api('/api/admin/login', { username: 'admin', password: 'admin123' })).status, 200);
    const staff = await api('/api/master-lists/ordered-by', { items: [{ name: 'Original Staff', active: true }] });
    const staffId = staff.body.staff_names.find(row => row.name === 'Original Staff').id;
    const suppliers = await api('/api/master-lists/suppliers', { items: [{ name: 'Original Supplier', active: true }, { name: 'Keep Supplier', active: true }] });
    const removeId = suppliers.body.suppliers.find(row => row.name === 'Original Supplier').id;
    const keepId = suppliers.body.suppliers.find(row => row.name === 'Keep Supplier').id;
    const draft = await api('/api/job-drafts', { customer_name: 'Cleanup shared draft', deposit_status: 'Deposit waived / not required' });
    assert.equal(draft.status, 201);
    const create = supplier => api('/api/orders', { customer_name: 'Cleanup test', supplier, ordered_by: 'Original Staff', ordered_by_id: staffId, category: 'Windows', date_ordered: '2026-10-11', date_received: '2026-10-11', job_draft_id: draft.body.draft.id });
    const removedOrder = await create('Original Supplier');
    const keptOrder = await create('Keep Supplier');
    assert.equal(removedOrder.status, 201); assert.equal(keptOrder.status, 201);
    await api('/api/master-lists/suppliers', { items: [{ id: removeId, name: 'Renamed Supplier', active: false }] });
    await api('/api/master-lists/ordered-by', { items: [{ id: staffId, name: 'Renamed Staff', active: false }] });
    let filtered = await api(`/api/orders?status=All&supplier=${removeId}&ordered_by=${staffId}`);
    assert.equal(filtered.body.orders.length, 1);
    assert.equal(filtered.body.orders[0].supplier, 'Renamed Supplier');
    assert.equal(filtered.body.orders[0].ordered_by, 'Renamed Staff');
    assert.equal((await api('/api/orders?status=All&supplier=renamed%20supplier&ordered_by=renamed%20staff')).body.orders.length, 1);
    const lists = await api('/api/master-lists');
    assert.deepEqual(lists.body.ordered_by_options, lists.body.staff_names.map(row => row.name));
    assert.ok(lists.body.supplier_filter_options.some(row => row.id === removeId && row.active === false));
    assert.equal((await api('/api/suppliers')).body.suppliers.includes('Renamed Supplier'), false);
    assert.equal((await api(`/api/orders/${removedOrder.body.order.id}/delete`, {})).status, 200);
    filtered = await api(`/api/orders?status=Archived&supplier=${removeId}&ordered_by=${staffId}`);
    assert.equal(filtered.body.orders.length, 1);
    let preview = await api('/api/admin/inactive-suppliers/preview');
    assert.equal(preview.body.supplier_count, 1); assert.equal(preview.body.order_count, 1);
    const confirm = data => api('/api/admin/inactive-suppliers/delete', { confirmation_token: data.confirmation_token, confirmation: 'DELETE' });
    assert.equal((await api('/api/admin/inactive-suppliers/delete', { confirmation_token: 'forged', confirmation: 'DELETE' })).status, 409);
    await api('/api/master-lists/suppliers', { items: [{ id: removeId, name: 'Renamed Supplier', active: true }] });
    assert.equal((await confirm(preview.body)).status, 409);
    assert.equal((await api(`/api/orders?status=Archived&supplier=${removeId}`)).body.orders.length, 1);
    await api('/api/master-lists/suppliers', { items: [{ id: removeId, name: 'Renamed Supplier', active: false }] });
    preview = await api('/api/admin/inactive-suppliers/preview');
    const result = await confirm(preview.body);
    assert.equal(result.status, 200); assert.deepEqual(result.body, { deleted_suppliers: 1, deleted_orders: 1 });
    assert.equal((await confirm(preview.body)).status, 409);
    const finalLists = await api('/api/master-lists');
    assert.equal(finalLists.body.suppliers.some(row => row.id === removeId), false);
    assert.ok(finalLists.body.suppliers.some(row => row.id === keepId));
    const remaining = await api(`/api/orders?status=All&supplier=${keepId}`);
    assert.equal(remaining.body.orders.length, 1); assert.equal(remaining.body.orders[0].id, keptOrder.body.order.id);
    const allDrafts = [...(await api('/api/job-drafts')).body.drafts, ...(await api('/api/job-drafts?status=Archived')).body.drafts];
    assert.ok(allDrafts.some(row => row.id === draft.body.draft.id));
    const fixture = new Database(path.join(child.testDataDir, 'boulevard_orders.db'));
    try {
      for (const name of ['North Valley Glass', 'Synthetic Pacific Hardware']) {
        fixture.prepare('INSERT INTO orders (id, customer_name, supplier, date_ordered, job_draft_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(`history-${name}`, 'Synthetic history', name, '2026-10-11', draft.body.draft.id, '2026-10-11', '2026-10-11');
      }
    } finally { fixture.close(); }
    const historicalLists = (await api('/api/master-lists')).body;
    assert.ok(historicalLists.historical_suppliers.some(row => row.name === 'North Valley Glass' && row.order_count === 1));
    assert.ok(historicalLists.supplier_filter_options.some(row => row.name === 'Synthetic Pacific Hardware' && row.historical === true && row.active !== false));
    assert.equal((await api('/api/admin/inactive-suppliers/preview')).body.order_count, 0);
    preview = await api('/api/admin/inactive-suppliers/preview?include_historical=true');
    assert.equal(preview.body.historical_supplier_count, 2);
    assert.equal(preview.body.order_count, 2);
    assert.deepEqual((await confirm(preview.body)).body, { deleted_suppliers: 0, deleted_orders: 2 });
    assert.equal((await api(`/api/orders?status=All&supplier=${keepId}`)).body.orders.length, 1);
    const preservedDrafts = [...(await api('/api/job-drafts')).body.drafts, ...(await api('/api/job-drafts?status=Archived')).body.drafts];
    assert.ok(preservedDrafts.some(row => row.id === draft.body.draft.id));
  } finally { child.kill('SIGTERM'); }
});

test('order saves require existing active suppliers and never create or reactivate master entries', async () => {
  const child = startServer();
  const cookieJar = createCookieJar();
  const api = (route, body, method = body ? 'POST' : 'GET') => requestJson('http://127.0.0.1:4100' + route, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), cookieJar });
  try {
    await delay(1500);
    await api('/api/admin/login', { username: 'admin', password: 'admin123' });
    const lists = await api('/api/master-lists');
    const supplier = lists.body.suppliers.find(row => row.name === 'Northline Glass');
    const payload = { customer_name: 'Supplier validation test', supplier: 'Unknown Supplier', ordered_by: 'Test Staff', category: 'Windows', date_ordered: '2026-10-11' };
    assert.equal((await api('/api/orders', payload)).status, 400);
    assert.equal((await api('/api/master-lists')).body.suppliers.length, lists.body.suppliers.length);
    assert.equal((await api('/api/orders', { ...payload, supplier_id: 'unknown-id', supplier: supplier.name })).status, 400);
    const created = await api('/api/orders', { ...payload, supplier_id: supplier.id, supplier: 'Spoofed label' });
    assert.equal(created.status, 201); assert.equal(created.body.order.supplier, supplier.name);
    await api('/api/master-lists/suppliers', { items: [{ id: supplier.id, name: supplier.name, active: false }] });
    assert.equal((await api('/api/orders', { ...payload, supplier: supplier.name, supplier_id: supplier.id })).status, 400);
    const edited = await api(`/api/orders/${created.body.order.id}`, { ...created.body.order, notes: 'Historical edit' }, 'PUT');
    assert.equal(edited.status, 200);
    assert.equal((await api('/api/master-lists')).body.suppliers.find(row => row.id === supplier.id).active, false);
    assert.equal((await api(`/api/orders/${created.body.order.id}`, { ...edited.body.order, supplier: 'Unknown Supplier', supplier_id: '' }, 'PUT')).status, 400);
    assert.equal((await api('/api/master-lists')).body.suppliers.length, lists.body.suppliers.length);
  } finally { child.kill('SIGTERM'); }
});

test('scheduled, complete and invoiced are saved for the whole job, feed the labor-meeting views and undo exactly', async () => {
  const child = startServer();
  const cookieJar = createCookieJar();
  const api = (route, body, method = body ? 'POST' : 'GET') => requestJson('http://127.0.0.1:4100' + route, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), cookieJar });
  const view = async (status) => (await api(`/api/orders?status=${encodeURIComponent(status)}&search=synthetic%20job`)).body.orders;
  const find = async (id) => (await api('/api/orders?status=All%20Orders')).body.orders.find(row => row.id === id);
  try {
    await delay(1500);
    assert.equal((await api('/api/login', { username: 'mary', password: 'staff123' })).status, 200);
    const create = (number, supplier, extra = {}) => api('/api/orders', { customer_name: `Synthetic Job ${number}`, housecall_job_number: number, supplier, category: 'Windows', date_ordered: '2026-10-01', ordered_by: 'Admin User', ...extra });
    const first = (await create('HC-77', 'Northline Glass', { shop_location: ' H ' })).body.order;
    const second = (await create('hc-77', 'Oldcastle')).body.order;
    const other = (await create('HC-78', 'Bayside Supply')).body.order;
    assert.equal(first.shop_location, 'H');

    assert.equal((await api(`/api/orders/${first.id}/mark-received`, {})).status, 200);
    let row = await find(first.id);
    assert.equal(row.job_order_count, 2);
    assert.equal(row.job_received_count, 1);
    assert.equal(row.job_ready, false);
    assert.equal(row.stage, 'received');
    assert.equal(row.job_group, (await find(second.id)).job_group);
    assert.notEqual(row.job_group, (await find(other.id)).job_group);
    // Half the material is here, so the job is not ready for the labor meeting.
    assert.equal((await view('To Schedule')).length, 0);

    assert.equal((await api(`/api/orders/${second.id}/mark-received`, {})).status, 200);
    assert.deepEqual((await view('To Schedule')).map(order => order.id).sort(), [first.id, second.id].sort());

    row = await find(first.id);
    const stale = row.updated_at;
    const saved = await api(`/api/orders/${first.id}/progress`, { job_scheduled: 1, scheduled_date: '2026-11-03', schedule_note: 'Two-man job', shop_location: 'G', updated_at: row.updated_at }, 'PUT');
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.order_ids.sort(), [first.id, second.id].sort());
    assert.deepEqual(saved.body.previous.find(item => item.id === first.id), { id: first.id, shop_location: 'H', job_scheduled: 0, scheduled_date: '', schedule_note: '', job_completed: 0, completed_date: '', invoiced: 0, invoice_reference: '' });
    const firstAfter = await find(first.id);
    const secondAfter = await find(second.id);
    assert.equal(firstAfter.shop_location, 'G');
    assert.equal(secondAfter.shop_location, '');
    for (const order of [firstAfter, secondAfter]) {
      assert.equal(order.job_scheduled, 1);
      assert.equal(order.scheduled_date, '2026-11-03');
      assert.equal(order.schedule_note, 'Two-man job');
      assert.equal(order.stage, 'scheduled');
      assert.equal(order.updated_by, 'mary');
    }
    assert.equal((await find(other.id)).job_scheduled, 0);
    assert.equal((await view('To Schedule')).length, 0);
    assert.equal((await view('Scheduled')).length, 2);
    assert.equal((await api('/api/orders?status=All%20Orders&search=two-man')).body.orders.length, 2);
    assert.equal((await api('/api/orders?status=All%20Orders&sort=scheduled_date&search=synthetic%20job')).body.orders.at(-1).id, other.id);

    // An old screen cannot overwrite the newer save, and nothing is half-written.
    const conflict = await api(`/api/orders/${first.id}/progress`, { job_scheduled: 0, updated_at: stale }, 'PUT');
    assert.equal(conflict.status, 409);
    assert.equal((await find(second.id)).job_scheduled, 1);
    assert.equal((await api(`/api/orders/${first.id}/progress`, { job_scheduled: 0 }, 'PUT')).status, 400);

    const undo = await api('/api/order-progress/restore', { updated_at: saved.body.updated_at, items: saved.body.previous });
    assert.equal(undo.status, 200);
    const restored = await find(first.id);
    assert.equal(restored.shop_location, 'H');
    assert.equal(restored.job_scheduled, 0);
    assert.equal(restored.scheduled_date, '');
    assert.equal((await find(second.id)).job_scheduled, 0);
    assert.equal((await api('/api/order-progress/restore', { updated_at: saved.body.updated_at, items: saved.body.previous })).status, 409);

    const complete = await api(`/api/orders/${second.id}/progress`, { job_scheduled: 1, job_completed: 1, updated_at: (await find(second.id)).updated_at }, 'PUT');
    assert.equal(complete.status, 200);
    const needInvoice = await view('Need Invoice');
    assert.deepEqual(needInvoice.map(order => order.id).sort(), [first.id, second.id].sort());
    assert.match(needInvoice[0].completed_date, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(needInvoice[0].stage, 'complete');
    const invoiced = await api(`/api/orders/${first.id}/progress`, { ...needInvoice.find(order => order.id === first.id), invoiced: 1, invoice_reference: '10239422', updated_at: (await find(first.id)).updated_at }, 'PUT');
    assert.equal(invoiced.status, 200);
    assert.equal((await view('Need Invoice')).length, 0);
    assert.equal((await find(second.id)).stage, 'invoiced');
    assert.equal((await find(second.id)).invoice_reference, '10239422');

    // Deleted orders are not part of the job any more.
    assert.equal((await api(`/api/orders/${second.id}/delete`, {})).status, 200);
    assert.equal((await find(first.id)).job_order_count, 1);
    assert.equal((await api(`/api/orders/${second.id}/progress`, { updated_at: 'x' }, 'PUT')).status, 404);
  } finally {
    child.kill('SIGTERM');
  }
});

test('admins can preview and import the Google Sheet, adding or replacing what is there', async () => {
  const child = startServer();
  const cookieJar = createCookieJar();
  const base = 'http://127.0.0.1:4100';
  const api = (route, body, method = body ? 'POST' : 'GET') => requestJson(base + route, { method, headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), cookieJar });
  const preview = file => requestJson(`${base}/api/admin/sheet-import/preview`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file, cookieJar });
  try {
    await delay(1500);
    const sheet = await syntheticOrderSheet();
    assert.equal((await preview(sheet)).status, 401);
    assert.equal((await api('/api/admin/login', { username: 'admin', password: 'admin123' })).status, 200);
    assert.equal((await preview(Buffer.from('not a spreadsheet'))).status, 400);

    const before = (await api('/api/orders?status=All%20Orders')).body.orders.length;
    let plan = await preview(sheet);
    assert.equal(plan.status, 200);
    assert.equal(plan.body.orders.length, 7);
    assert.equal(plan.body.skipped.length, 2);
    assert.equal(plan.body.current.orders >= before, true);
    assert.ok(plan.body.suppliers.some(row => row.name === 'Jeld-Wen' && !row.existing));
    assert.ok(plan.body.suppliers.some(row => row.name === 'Oldcastle' && row.existing));

    assert.equal((await api('/api/admin/sheet-import/apply', { token: plan.body.token, mode: 'add', confirmation: 'REPLACE' })).status, 400);
    assert.equal((await api('/api/admin/sheet-import/apply', { token: 'forged', mode: 'add', confirmation: 'IMPORT' })).status, 409);
    const added = await api('/api/admin/sheet-import/apply', { token: plan.body.token, mode: 'add', confirmation: 'IMPORT' });
    assert.equal(added.status, 200);
    assert.equal(added.body.orders, 7);
    assert.equal(added.body.jobs, 1);
    assert.equal((await api('/api/admin/sheet-import/apply', { token: plan.body.token, mode: 'add', confirmation: 'IMPORT' })).status, 409);

    let orders = (await api('/api/orders?status=All%20Orders')).body.orders;
    assert.equal(orders.length, before + 7);
    const alpha = orders.filter(order => order.customer_name.toLowerCase() === 'synthetic alpha');
    assert.equal(alpha.length, 2);
    assert.equal(alpha[0].job_group, alpha[1].job_group);
    assert.equal(alpha[0].job_order_count, 2);
    assert.equal(alpha[0].created_by, 'admin');
    const bravo = orders.find(order => order.customer_name === 'Synthetic Bravo');
    assert.equal(bravo.supplier, 'Andersen');
    assert.equal(bravo.stage, 'complete');
    assert.equal(bravo.housecall_job_number, '10238822');
    assert.ok((await api('/api/orders?status=Need%20Invoice')).body.orders.some(order => order.id === bravo.id));
    assert.ok((await api('/api/orders?status=To%20Schedule')).body.orders.some(order => order.customer_name === 'Synthetic Glass'));
    // Imported jobs already have their materials ordered.
    assert.ok((await api('/api/job-drafts')).body.drafts.some(draft => draft.customer_name === 'Synthetic Alpha' && draft.status === 'Completed'));

    plan = await preview(sheet);
    const again = await api('/api/admin/sheet-import/apply', { token: plan.body.token, mode: 'add', confirmation: 'IMPORT' });
    assert.equal(again.body.orders, 0);
    assert.equal(again.body.duplicates, 7);

    plan = await preview(sheet);
    const replaced = await api('/api/admin/sheet-import/apply', { token: plan.body.token, mode: 'replace', confirmation: 'REPLACE' });
    assert.equal(replaced.status, 200);
    orders = (await api('/api/orders?status=All%20Orders')).body.orders;
    assert.equal(orders.length, 7);
    const lists = (await api('/api/master-lists')).body;
    assert.deepEqual(lists.suppliers.map(row => row.name).sort(), ['Andersen', 'Arcadia', 'CW', 'Jeld-Wen', 'Oldcastle', 'Unknown supplier (from sheet)']);
    assert.deepEqual(lists.staff_names.map(row => row.name).sort(), ['AD', 'KL', 'RD', 'SD', 'Unknown']);
    assert.equal((await api('/api/job-drafts')).body.drafts.length, 1);
    // Logins survive a replace.
    assert.equal((await api('/api/login', { username: 'mary', password: 'staff123' })).status, 200);
  } finally {
    child.kill('SIGTERM');
  }
});
