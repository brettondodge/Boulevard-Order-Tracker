import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { partKey, scheduleMatches, unscannedGlass } from '../public/autoglass-match.js';

const jobs = [
  { number: '501', scheduledDate: '2026-11-04', vehicle: '2019 Toyota Camry', parts: ['DW02842GTYN', 'GGS 901 GEL', 'LABOR'] },
  { number: '505', scheduledDate: '2026-11-03', vehicle: '2017 Ford F-150', parts: ['FW04567GBY', 'HAH000448'] }
];

test('a scan matches scheduled parts exactly, inside a longer barcode, or as the same glass in another version', () => {
  assert.equal(partKey(' dw02842-gtyn '), 'DW02842GTYN');
  const numbers = result => [result.exact.map(job => [job.number, job.part]), result.close.map(job => [job.number, job.part])];
  assert.deepEqual(numbers(scheduleMatches('dw02842 gtyn', jobs)), [[['501', 'DW02842GTYN']], []]);
  assert.deepEqual(numbers(scheduleMatches('0DW02842GTYN17', jobs)), [[['501', 'DW02842GTYN']], []], 'barcode with extra characters');
  assert.deepEqual(numbers(scheduleMatches('DW02842GBY', jobs)), [[], [['501', 'DW02842GTYN']]], 'same glass, other version');
  assert.deepEqual(numbers(scheduleMatches('HAH000448', jobs)), [[['505', 'HAH000448']], []], 'mouldings and other parts match too');
  assert.deepEqual(numbers(scheduleMatches('DB00123', jobs)), [[], []]);
  assert.deepEqual(numbers(scheduleMatches('LAB', jobs)), [[], []], 'short SKUs only match exactly');
  assert.deepEqual(numbers(scheduleMatches('', jobs)), [[], []]);
});

test('glass on the schedule that nothing scanned matches is listed; other parts are not', () => {
  assert.deepEqual(unscannedGlass(jobs, []).map(job => [job.number, job.part]), [['501', 'DW02842GTYN'], ['505', 'FW04567GBY']]);
  assert.deepEqual(unscannedGlass(jobs, ['x FW04567GBY x', 'DW02842GBY']).map(job => job.part), ['DW02842GTYN'], 'another version is not the scheduled part');
});

// ---------- API ----------

const PORT = 4140;
const OMEGA_PORT = 4141;
const BASE = `http://127.0.0.1:${PORT}`;
const running = new Set();

afterEach(async () => {
  await Promise.all([...running].map(stop => stop()));
  running.clear();
});

async function startServer(extraEnv = {}) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env, NODE_ENV: 'test', RENDER: 'false', SESSION_SECRET: 'test-secret', APP_PORT: String(PORT),
      PREVIEW_MODE: 'false', SQLITE_DATA_DIR: mkdtempSync(path.join(tmpdir(), 'boulevard-autoglass-')),
      DEMO_STAFF_PASSWORD: 'staff-test', ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'admin-test',
      // Never the real Omega or Housecall Pro, even with keys in the local .env.
      OMEGA_API_KEY: '', OMEGA_API_BASE: 'http://127.0.0.1:9/api/2.0', HCP_API_KEY: '', HCP_WEBHOOK_SECRET: '', ...extraEnv
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  running.add(async () => {
    if (child.exitCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  });
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Server exited: ${errors}`);
    try { if ((await fetch(`${BASE}/healthz`)).ok) return; } catch {}
    await delay(100);
  }
  throw new Error('Server start timed out');
}

// Like the real API: date1/date2 filter on the day a job was written up.
async function startFakeOmega(omegaJobs) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://omega.test');
    const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.headers.api_key !== 'test-omega-key') return send(401, { error: 'bad key' });
    if (url.pathname !== '/api/2.0/Invoices') return send(404, { error: 'not found' });
    const [from, to] = [url.searchParams.get('date1'), url.searchParams.get('date2')];
    const found = omegaJobs.filter(job => job.document_date >= from && job.document_date <= to);
    return send(200, url.searchParams.get('page') === '1' ? found : []);
  });
  await new Promise(resolve => server.listen(OMEGA_PORT, '127.0.0.1', resolve));
  running.add(() => new Promise(resolve => server.close(resolve)));
}

function client() {
  let cookie = '';
  return async (route, { method = 'GET', body } = {}) => {
    const response = await fetch(`${BASE}${route}`, {
      method,
      redirect: 'manual',
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: response.status, body: json, text, location: response.headers.get('location') };
  };
}

test('scans save in order; Need and Return are one or neither; remove and Clear list', { timeout: 60000 }, async () => {
  await startServer();
  const request = client();
  assert.equal((await request('/api/autoglass/scans')).status, 401);
  assert.equal((await request('/autoglass')).location, '/login?next=%2Fautoglass');
  assert.equal((await request('/api/login', { method: 'POST', body: { username: 'mary', password: 'staff-test' } })).status, 200);
  assert.match((await request('/autoglass')).text, /Autoglass Scanning/);
  assert.ok((await request('/api/tools')).body.some(tool => tool.path === '/autoglass' && !tool.desktopOnly));

  assert.equal((await request('/api/autoglass/scans', { method: 'POST', body: { part_number: '   ' } })).status, 400);
  assert.equal((await request('/api/autoglass/scans', { method: 'POST', body: { part_number: 'X'.repeat(81) } })).status, 400);
  const first = (await request('/api/autoglass/scans', { method: 'POST', body: { part_number: '  DW02842   GTYN ' } })).body.scan;
  const second = (await request('/api/autoglass/scans', { method: 'POST', body: { part_number: 'FW04567GBY' } })).body.scan;
  assert.equal(first.part_number, 'DW02842 GTYN');
  assert.equal(first.scanned_by, 'mary');
  assert.deepEqual([first.need, first.to_return], [false, false]);

  const markScan = (scan, body) => request(`/api/autoglass/scans/${scan.id}`, { method: 'PUT', body });
  assert.equal((await markScan(first, { need: true })).body.scan.need, true);
  assert.equal((await markScan(first, { need: true, to_return: true })).status, 400);
  const switched = (await markScan(first, { need: false, to_return: true })).body.scan;
  assert.deepEqual([switched.need, switched.to_return], [false, true]);
  assert.equal((await markScan({ id: 'missing' }, { need: true })).status, 404);

  let list = (await request('/api/autoglass/scans')).body;
  assert.equal(list.omegaConnected, false);
  assert.deepEqual(list.scans.map(scan => [scan.part_number, scan.need, scan.to_return]), [['DW02842 GTYN', false, true], ['FW04567GBY', false, false]]);

  assert.equal((await request(`/api/autoglass/scans/${second.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await request(`/api/autoglass/scans/${second.id}`, { method: 'DELETE' })).status, 404);
  assert.deepEqual((await request('/api/autoglass/clear', { method: 'POST' })).body, { cleared: 1 });
  list = (await request('/api/autoglass/scans')).body;
  assert.deepEqual(list.scans, []);
  assert.equal((await markScan(first, { need: true })).status, 404, 'a cleared scan is off the list');
  assert.deepEqual((await request('/api/autoglass/schedule?from=2026-11-03&to=2026-11-10')).body, { connected: false });
});

test('the Omega check lists work orders scheduled in the dates, with their parts', { timeout: 60000 }, async () => {
  const item = sku => ({ sku, purchase_order_item_id: 0 });
  await startFakeOmega([
    { id: '501', document_date: '2026-10-20', job_status: 'WO', appointment_scheduled_date: '2026-11-04', vehicle_year: '2019', vehicle_make: 'Toyota', vehicle_model: 'Camry', Items: [item('DW02842GTYN'), item('GGS 901 GEL'), item('DW02842GTYN')] },
    { id: '505', document_date: '2026-11-01', job_status: 'WO', appointment_scheduled_date: '2026-11-03', vehicle_year: '2017', vehicle_make: 'Ford', vehicle_model: 'F-150', Items: null, skus: 'FW04567GBY, HAH000448' },
    { id: '502', document_date: '2026-11-01', job_status: 'WO', appointment_scheduled_date: '2026-11-20', Items: [item('DB00123')] },
    { id: '503', document_date: '2026-11-01', job_status: 'IN', appointment_scheduled_date: '2026-11-05', Items: [item('DD11111')] },
    { id: '504', document_date: '2026-11-02', job_status: 'WO', appointment_scheduled_date: '0000-00-00', Items: [item('DQ22222')] }
  ]);
  await startServer({ OMEGA_API_KEY: 'test-omega-key', OMEGA_API_BASE: `http://127.0.0.1:${OMEGA_PORT}/api/2.0` });
  const request = client();
  await request('/api/login', { method: 'POST', body: { username: 'mary', password: 'staff-test' } });
  assert.equal((await request('/api/autoglass/scans')).body.omegaConnected, true);

  const schedule = (await request('/api/autoglass/schedule?from=2026-11-03&to=2026-11-10')).body;
  assert.equal(schedule.searchedFrom, '2026-09-04');
  assert.deepEqual(schedule.jobs, [
    { number: '505', scheduledDate: '2026-11-03', vehicle: '2017 Ford F-150', parts: ['FW04567GBY', 'HAH000448'] },
    { number: '501', scheduledDate: '2026-11-04', vehicle: '2019 Toyota Camry', parts: ['DW02842GTYN', 'GGS 901 GEL'] }
  ]);
  assert.equal((await request('/api/autoglass/schedule?from=2026-11-10&to=2026-11-03')).status, 400);
  assert.equal((await request('/api/autoglass/schedule?from=2026-11-01&to=2026-12-15')).status, 400);
  assert.equal((await request('/api/autoglass/schedule')).status, 400);
});
