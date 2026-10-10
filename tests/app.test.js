import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import bcrypt from 'bcryptjs';

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
      date_ordered: '2026-10-09'
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
      date_ordered: '2026-10-10'
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
      date_ordered: '2026-10-11'
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
