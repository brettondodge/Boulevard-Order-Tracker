import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import express from 'express';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import {
  createPostgresSessionStore,
  getSessionMiddlewareOptions,
  configureSessionMiddleware
} from '../src/session-config.js';

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
    APP_PORT: '4100'
  };

  const child = spawn('node', ['src/server.js'], {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

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
      assert.match(cookieHeader, /SameSite=None/i);
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
      notes: 'Approved and deposit received.'
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
    body: JSON.stringify({ deposit_status: 'Deposit waived / not required' }),
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

test('job archive is blocked until linked supplier orders are received', async () => {
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

  const customer = `Pending Archive Customer ${Date.now()}`;
  const draft = await requestJson('http://127.0.0.1:4100/api/job-drafts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_name: customer,
      housecall_job_number: `HC-RECEIVE-${Date.now()}`,
      hcp_job_id: `hcp-receive-${Date.now()}`,
      notes: 'Waiting for receipt before archiving.',
      deposit_status: 'Deposit received'
    }),
    cookieJar
  });

  const order = await requestJson('http://127.0.0.1:4100/api/orders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      customer_name: customer,
      housecall_job_number: draft.body.draft.housecall_job_number,
      job_draft_id: draft.body.draft.id,
      supplier: 'Northline Glass',
      category: 'Windows',
      date_ordered: '2026-10-18',
      ordered_by: 'Admin User'
    }),
    cookieJar
  });

  assert.equal(draft.status, 201);
  assert.equal(order.status, 201);

  const blocked = await requestJson(`http://127.0.0.1:4100/api/job-drafts/${draft.body.draft.id}/archive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true, reason: 'Should fail before receipt', source: 'manual' }),
    cookieJar
  });

  assert.equal(blocked.status, 409);
  assert.match(String(blocked.body.error || blocked.body.warning || ''), /received/i);

  const markReceived = await requestJson(`http://127.0.0.1:4100/api/orders/${order.body.order.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...order.body.order,
      status: 'Received',
      date_received: '2026-10-22',
      updated_at: order.body.order.updated_at
    }),
    cookieJar
  });

  assert.equal(markReceived.status, 200);

  const archiveResponse = await requestJson(`http://127.0.0.1:4100/api/job-drafts/${draft.body.draft.id}/archive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true, reason: 'Ready to archive', source: 'manual' }),
    cookieJar
  });

  assert.equal(archiveResponse.status, 200);
  assert.equal(archiveResponse.body.archived, true);

  child.kill('SIGTERM');
});

test('archive and restore keep linked supplier orders and other jobs separate', async () => {
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

  const markReceived = await requestJson(`http://127.0.0.1:4100/api/orders/${firstOrder.body.order.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...firstOrder.body.order,
      status: 'Received',
      date_received: '2026-10-20',
      updated_at: firstOrder.body.order.updated_at
    }),
    cookieJar
  });

  assert.equal(markReceived.status, 200);

  const archiveResponse = await requestJson(`http://127.0.0.1:4100/api/job-drafts/${firstDraft.body.draft.id}/archive`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'Test archive', source: 'manual' }),
    cookieJar
  });

  assert.equal(archiveResponse.status, 200);
  assert.equal(archiveResponse.body.archived, true);
  assert.equal(archiveResponse.body.order_ids.length, 1);

  const activeOrders = await requestJson('http://127.0.0.1:4100/api/orders?status=Outstanding');
  const archivedOrders = await requestJson('http://127.0.0.1:4100/api/orders?status=Archived');
  const activeDrafts = await requestJson('http://127.0.0.1:4100/api/job-drafts');

  assert.equal(activeOrders.status, 200);
  assert.equal(archivedOrders.status, 200);
  assert.ok(activeOrders.body.orders.some((order) => order.id === secondOrder.body.order.id));
  assert.ok(archivedOrders.body.orders.some((order) => order.id === firstOrder.body.order.id));
  assert.ok(activeDrafts.body.drafts.some((draft) => draft.id === secondDraft.body.draft.id));
  assert.ok(!activeDrafts.body.drafts.some((draft) => draft.id === firstDraft.body.draft.id));

  const restoreResponse = await requestJson(`http://127.0.0.1:4100/api/job-drafts/${firstDraft.body.draft.id}/restore`, {
    method: 'POST',
    cookieJar
  });

  assert.equal(restoreResponse.status, 200);
  assert.equal(restoreResponse.body.restored, true);

  const restoredOrders = await requestJson('http://127.0.0.1:4100/api/orders?status=Archived');
  assert.equal(restoredOrders.status, 200);
  assert.ok(!restoredOrders.body.orders.some((order) => order.id === firstOrder.body.order.id));

  child.kill('SIGTERM');
});
