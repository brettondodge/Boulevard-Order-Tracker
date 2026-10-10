import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const root = process.cwd();

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

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {}
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        let body = data ? data.toString() : '';

        if (data) {
          try {
            body = JSON.parse(data.toString());
          } catch {
            body = data.toString();
          }
        }

        resolve({ status: res.statusCode, headers: res.headers, body });
      });
    });
    req.on('error', reject);
    if (options.body) {
      req.write(options.body);
    }
    req.end();
  });
}

function getCookieFromResponse(response) {
  const raw = response.headers['set-cookie'];
  if (!raw || !raw.length) {
    return '';
  }

  return raw[0].split(';')[0];
}

test('server starts and exposes login page', async () => {
  const child = startServer();
  await delay(1500);

  const response = await requestJson('http://127.0.0.1:4100/login');

  child.kill('SIGTERM');

  assert.equal(response.status, 200);
  assert.match(response.body.toString ? response.body.toString() : '', /Boulevard Glass Order Tracker/i);
});

test('authenticated API requires login for orders', async () => {
  const child = startServer();
  await delay(1500);

  const response = await requestJson('http://127.0.0.1:4100/api/orders');

  child.kill('SIGTERM');

  assert.equal(response.status, 401);
});

test('category and group filters work with supplier selection', async () => {
  const child = startServer();
  await delay(1500);

  const login = await requestJson('http://127.0.0.1:4100/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' })
  });

  assert.equal(login.status, 200);

  const cookie = getCookieFromResponse(login);
  assert.ok(cookie, 'login response should include a session cookie');

  const createWindows = await requestJson('http://127.0.0.1:4100/api/orders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie
    },
    body: JSON.stringify({
      customer_name: 'Category Test',
      supplier: 'Oldcastle',
      category: 'Windows',
      date_ordered: '2026-10-09'
    })
  });

  const createFlat = await requestJson('http://127.0.0.1:4100/api/orders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie
    },
    body: JSON.stringify({
      customer_name: 'Category Test 2',
      supplier: 'Oldcastle',
      category: 'Flat Glass',
      date_ordered: '2026-10-10'
    })
  });

  const createShowers = await requestJson('http://127.0.0.1:4100/api/orders', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: cookie
    },
    body: JSON.stringify({
      customer_name: 'Category Test 3',
      supplier: 'Oldcastle',
      category: 'Showers',
      date_ordered: '2026-10-11'
    })
  });

  assert.equal(createWindows.status, 201);
  assert.equal(createFlat.status, 201);
  assert.equal(createShowers.status, 201);

  const groupResponse = await requestJson('http://127.0.0.1:4100/api/orders?view=Windows%20%2F%20Flat%20Glass&supplier=Oldcastle', {
    headers: { Cookie: cookie }
  });
  const categoryResponse = await requestJson('http://127.0.0.1:4100/api/orders?category=Windows&supplier=Oldcastle', {
    headers: { Cookie: cookie }
  });

  child.kill('SIGTERM');

  assert.equal(groupResponse.status, 200);
  assert.equal(categoryResponse.status, 200);
  assert.ok(groupResponse.body.orders.some((order) => order.category === 'Windows'));
  assert.ok(groupResponse.body.orders.some((order) => order.category === 'Flat Glass'));
  assert.ok(categoryResponse.body.orders.every((order) => order.category === 'Windows'));
});
