import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { glassNumber, matchesSearch, partKey, scheduleMatches, unscannedGlass } from '../public/autoglass-match.js';

const jobs = [
  { number: '501', scheduledDate: '2026-11-04', vehicle: '2019 Toyota Camry', parts: ['DW02842GTYN', 'GGS 901 GEL', 'LABOR'] },
  { number: '505', scheduledDate: '2026-11-03', vehicle: '2017 Ford F-150', parts: ['FW04567GBY', 'HAH000448'] }
];

test('glass matches on its NAGS number (DW02842), whatever the version letters; other parts on the whole number', () => {
  assert.equal(partKey(' dw02842-gtyn '), 'DW02842GTYN');
  assert.equal(glassNumber('0dw02842gtyn17'), 'DW02842');
  assert.equal(glassNumber('HAH000448'), '', 'mouldings are not glass');
  const found = scan => scheduleMatches(scan, jobs).map(job => [job.number, job.part]);
  for (const scan of ['DW02842GTYN', 'dw02842 gtyn', 'DW02842', 'DW02842GBY', '0DW02842GTYN17']) assert.deepEqual(found(scan), [['501', 'DW02842GTYN']], scan);
  assert.deepEqual(found('X0FW04567'), [['505', 'FW04567GBY']], 'barcode with extra characters');
  assert.deepEqual(found('DW02843GTYN'), [], 'a different glass number');
  assert.deepEqual(found('HAH000448'), [['505', 'HAH000448']]);
  assert.deepEqual(found('HAH00044'), [], 'other parts need the whole number');
  assert.deepEqual(found('LAB'), [], 'short SKUs only match exactly');
  assert.deepEqual(found(''), []);
});

test('glass on the schedule with no scan of its NAGS number is listed; other parts are not', () => {
  assert.deepEqual(unscannedGlass(jobs, []).map(job => [job.number, job.glass]), [['501', 'DW02842'], ['505', 'FW04567']]);
  assert.deepEqual(unscannedGlass(jobs, ['x FW04567GBY x', 'DW02842GBY']), [], 'any version counts as scanned');
  assert.deepEqual(unscannedGlass(jobs, ['DW02843']).map(job => job.glass), ['DW02842', 'FW04567']);
});

test('search finds every word typed, as text or as a part number without spaces and dashes', () => {
  const line = ['DW02842 GTYN', 'need', 'WO #501', '2019 Toyota Camry', 'DW02842GTYN'];
  for (const query of ['', '  ', 'dw02842', 'DW02842-G', '02842gt', 'camry', 'Camry 501', 'need', '#501']) assert.equal(matchesSearch(query, line), true, query);
  for (const query of ['return', 'FW04567', 'camry 505', 'DW02843']) assert.equal(matchesSearch(query, line), false, query);
  assert.equal(matchesSearch('h', ['HAH000448', '']), true);
  assert.equal(matchesSearch('-', ['HAH000448', null]), false);
});

// ---------- API ----------

const PORT = 4140;
const OMEGA_PORT = 4141;
const EMAIL_PORT = 4142;
const BASE = `http://127.0.0.1:${PORT}`;
const running = new Set();

afterEach(async () => {
  await Promise.all([...running].map(stop => stop()));
  running.clear();
});

async function startServer(extraEnv = {}, dataDir = mkdtempSync(path.join(tmpdir(), 'boulevard-autoglass-'))) {
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: process.cwd(),
    env: {
      ...process.env, NODE_ENV: 'test', RENDER: 'false', SESSION_SECRET: 'test-secret', APP_PORT: String(PORT),
      PREVIEW_MODE: 'false', SQLITE_DATA_DIR: dataDir,
      DEMO_STAFF_PASSWORD: 'staff-test', ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'admin-test',
      // Never the real Omega, email service or Housecall Pro, even with keys in the local .env.
      OMEGA_API_KEY: '', OMEGA_API_BASE: 'http://127.0.0.1:9/api/2.0', HCP_API_KEY: '', HCP_WEBHOOK_SECRET: '',
      RESEND_API_KEY: '', RESEND_API_BASE: 'http://127.0.0.1:9', INVENTORY_ALERT_EMAIL: '', AUTOGLASS_CHECK_HOUR: '24', ...extraEnv
    },
    stdio: ['ignore', 'ignore', 'pipe']
  });
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  };
  running.add(stop);
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`Server exited: ${errors}`);
    try { if ((await fetch(`${BASE}/healthz`)).ok) return stop; } catch {}
    await delay(100);
  }
  throw new Error('Server start timed out');
}

// Stands in for Resend: keeps every email it's asked to send.
async function startFakeEmail() {
  const sent = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    sent.push({ path: req.url, authorization: req.headers.authorization, ...JSON.parse(body || '{}') });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: `email-${sent.length}` }));
  });
  await new Promise(resolve => server.listen(EMAIL_PORT, '127.0.0.1', resolve));
  running.add(() => new Promise(resolve => server.close(resolve)));
  return sent;
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

test('scans save in order on the PLK or PGW list; Need and Return are one or neither; remove and Clear list', { timeout: 60000 }, async () => {
  await startServer();
  const request = client();
  assert.equal((await request('/api/autoglass/scans')).status, 401);
  assert.equal((await request('/autoglass')).location, '/login?next=%2Fautoglass');
  assert.equal((await request('/api/login', { method: 'POST', body: { username: 'mary', password: 'staff-test' } })).status, 200);
  assert.match((await request('/autoglass')).text, /Autoglass Scanning/);
  assert.ok((await request('/api/tools')).body.some(tool => tool.path === '/autoglass' && !tool.desktopOnly));

  const scan = (supplier, part) => request('/api/autoglass/scans', { method: 'POST', body: { supplier, part_number: part } });
  assert.equal((await scan(undefined, 'DW02842')).status, 400, 'every scan goes on the PLK or PGW list');
  assert.equal((await scan('xyz', 'DW02842')).status, 400);
  assert.equal((await scan('plk', '   ')).status, 400);
  assert.equal((await scan('plk', 'X'.repeat(81))).status, 400);
  const first = (await scan('plk', '  DW02842   GTYN ')).body.scan;
  const second = (await scan('plk', 'FW04567GBY')).body.scan;
  await scan('pgw', 'FW04567GBY');
  assert.equal(first.part_number, 'DW02842 GTYN');
  assert.equal(first.supplier, 'plk');
  assert.equal(first.scanned_by, 'mary');
  assert.deepEqual([first.need, first.to_return], [false, false]);

  const markScan = (scan, body) => request(`/api/autoglass/scans/${scan.id}`, { method: 'PUT', body });
  assert.equal((await markScan(first, { need: true })).body.scan.need, true);
  assert.equal((await markScan(first, { need: true, to_return: true })).status, 400);
  const switched = (await markScan(first, { need: false, to_return: true })).body.scan;
  assert.deepEqual([switched.need, switched.to_return], [false, true]);
  // Editing the part number or the list keeps Need / Return.
  const edited = (await markScan(first, { part_number: ' DW02824  GTYN ', supplier: 'pgw' })).body.scan;
  assert.deepEqual([edited.part_number, edited.supplier, edited.need, edited.to_return], ['DW02824 GTYN', 'pgw', false, true]);
  assert.equal((await markScan(first, { supplier: 'abc' })).status, 400);
  assert.equal((await markScan(first, { part_number: ' -- ' })).status, 400, 'a part number needs letters or digits');
  assert.equal((await markScan(first, { part_number: 'DW02842 GTYN', supplier: 'plk' })).status, 200);
  assert.equal((await markScan({ id: 'missing' }, { need: true })).status, 404);

  let list = (await request('/api/autoglass/scans')).body;
  assert.equal(list.omegaConnected, false);
  const lines = () => list.scans.map(entry => [entry.part_number, entry.supplier, entry.need, entry.to_return]);
  assert.deepEqual(lines(), [['DW02842 GTYN', 'plk', false, true], ['FW04567GBY', 'plk', false, false], ['FW04567GBY', 'pgw', false, false]]);

  assert.equal((await request(`/api/autoglass/scans/${second.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await request(`/api/autoglass/scans/${second.id}`, { method: 'DELETE' })).status, 404);
  const clear = supplier => request('/api/autoglass/clear', { method: 'POST', body: { supplier } });
  assert.equal((await clear(undefined)).status, 400);
  assert.deepEqual((await clear('plk')).body, { cleared: 1 });
  list = (await request('/api/autoglass/scans')).body;
  assert.deepEqual(lines(), [['FW04567GBY', 'pgw', false, false]], 'clearing PLK leaves the PGW list');
  assert.deepEqual((await clear('pgw')).body, { cleared: 1 });
  list = (await request('/api/autoglass/scans')).body;
  assert.deepEqual(list.scans, []);
  assert.equal((await markScan(first, { need: true })).status, 404, 'a cleared scan is off the list');
  assert.deepEqual((await request('/api/autoglass/schedule?from=2026-11-03&to=2026-11-10')).body, { connected: false });
  assert.equal((await request('/api/autoglass/inventory/check', { method: 'POST' })).status, 503);
  assert.deepEqual((await request('/api/autoglass/inventory')).body.check, { omegaConnected: false, emailConfigured: false, checkHour: 24, last: null });
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
    { number: '505', status: 'Work order', writtenUp: '2026-11-01', scheduledDate: '2026-11-03', vehicle: '2017 Ford F-150', parts: ['FW04567GBY', 'HAH000448'] },
    { number: '501', status: 'Work order', writtenUp: '2026-10-20', scheduledDate: '2026-11-04', vehicle: '2019 Toyota Camry', parts: ['DW02842GTYN', 'GGS 901 GEL'] }
  ]);
  assert.equal((await request('/api/autoglass/schedule?from=2026-11-10&to=2026-11-03')).status, 400);
  assert.equal((await request('/api/autoglass/schedule?from=2026-11-01&to=2026-12-15')).status, 400);
  assert.equal((await request('/api/autoglass/schedule')).status, 400);
});

test('stock and old inventory count scans; the check finds open Omega jobs that need them and emails old-inventory matches once', { timeout: 90000 }, async () => {
  const day = offset => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix' }).format(new Date(Date.now() + offset * 86400000));
  const item = sku => ({ sku });
  const omegaJobs = [
    { id: '701', document_date: day(-3), job_status: 'QO', appointment_scheduled_date: '0000-00-00', vehicle_year: '2019', vehicle_make: 'Toyota', vehicle_model: 'Camry', Items: [item('DW02842GTYN'), item('LABOR')] },
    { id: '702', document_date: day(-10), job_status: 'WO', appointment_scheduled_date: day(2), vehicle_year: '2017', vehicle_make: 'Ford', vehicle_model: 'F-150', Items: [item('FW04567GBY'), item('GGS 901 GEL')] },
    { id: '703', document_date: day(-5), job_status: 'IN', Items: [item('DW02842GTYN')] },
    { id: '704', document_date: day(-90), job_status: 'WO', Items: [item('DW02842GTYN')] }
  ];
  await startFakeOmega(omegaJobs);
  const sent = await startFakeEmail();
  const dataDir = mkdtempSync(path.join(tmpdir(), 'boulevard-autoglass-'));
  const connected = {
    OMEGA_API_KEY: 'test-omega-key', OMEGA_API_BASE: `http://127.0.0.1:${OMEGA_PORT}/api/2.0`,
    RESEND_API_KEY: 'test-resend-key', RESEND_API_BASE: `http://127.0.0.1:${EMAIL_PORT}`, INVENTORY_ALERT_EMAIL: 'office@example.test'
  };
  let stop = await startServer(connected, dataDir);
  let request = client();
  await request('/api/login', { method: 'POST', body: { username: 'mary', password: 'staff-test' } });
  const add = (section, part) => request('/api/autoglass/inventory', { method: 'POST', body: { section, part_number: part } });
  const inventory = async () => (await request('/api/autoglass/inventory')).body;

  assert.equal((await add('shelf', 'DW02842GBY')).status, 400);
  assert.equal((await add('old', ' ')).status, 400);
  const glass = await add('old', 'DW02842GBY');
  assert.equal(glass.status, 201);
  const again = await add('old', 'dw02842-gby');
  assert.equal(again.status, 200, 'the same part adds one more');
  assert.deepEqual([again.body.item.id, again.body.item.quantity, again.body.item.added], [glass.body.item.id, 2, false]);
  const moulding = (await add('old', 'HAH000448')).body.item;
  const stock = (await add('stock', 'DW02842GBY')).body.item;
  assert.notEqual(stock.id, glass.body.item.id, 'Stock and Old inventory are counted apart');
  const fw = await add('stock', 'FW04567GBY');
  assert.equal(fw.status, 201);
  const save = (id, body) => request(`/api/autoglass/inventory/${id}`, { method: 'PUT', body });
  assert.equal((await save(glass.body.item.id, { quantity: 0, shelf: '' })).status, 400);
  assert.equal((await save(glass.body.item.id, { quantity: 2, shelf: ' H ' })).status, 200);
  assert.equal((await save('missing', { quantity: 1, shelf: '' })).status, 404);

  // The check: open quotes and work orders from the last 60 days only.
  const check = await request('/api/autoglass/inventory/check', { method: 'POST' });
  assert.equal(check.status, 200);
  assert.deepEqual({ ...check.body.result, checkedAt: undefined }, { checkedAt: undefined, jobs: 2, matches: 3, waiting: 0, emailed: 1, emailError: '', error: '' });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].path, '/emails');
  assert.equal(sent[0].authorization, 'Bearer test-resend-key');
  assert.deepEqual(sent[0].to, ['office@example.test']);
  assert.equal(sent[0].subject, 'Old inventory match: DW02842 for Quote #701');
  assert.match(sent[0].text, /- DW02842GBY \(shelf H, 2 on hand\) fits Quote #701 · 2019 Toyota Camry · written up \w+ \d+\n  Omega lists DW02842GTYN/);
  assert.match(sent[0].text, /https:\/\/tools\.blvdglass\.com\/autoglass#old/);

  let items = (await inventory()).items;
  const matchesOf = id => items.find(entry => entry.id === id).matches.map(match => [match.job_number, match.status, match.emailed]);
  assert.deepEqual(matchesOf(glass.body.item.id), [['701', 'Quote', true]]);
  assert.deepEqual(matchesOf(stock.id), [['701', 'Quote', false]], 'stock matches show but are not emailed');
  assert.deepEqual(matchesOf(moulding.id), []);

  // A second check sends nothing new; a job that's invoiced drops off.
  assert.equal((await request('/api/autoglass/inventory/check', { method: 'POST' })).body.result.emailed, 0);
  assert.equal(sent.length, 1);
  omegaJobs[0].job_status = 'IN';
  await request('/api/autoglass/inventory/check', { method: 'POST' });
  items = (await inventory()).items;
  assert.deepEqual(matchesOf(glass.body.item.id), []);

  const csv = await request('/api/autoglass/inventory.csv?section=stock');
  assert.equal(csv.status, 200);
  assert.equal(csv.text, 'Part number,NAGS number,Quantity,Shelf,Open Omega jobs that need it\r\nDW02842GBY,DW02842,1,,\r\nFW04567GBY,FW04567,1,,Work order #702\r\n');
  assert.equal((await request('/api/autoglass/inventory.csv?section=other')).status, 400);

  // Editing a part number: written another way keeps its matches; a different
  // part drops them until the next check; one already on the list combines.
  const edit = (id, body) => save(id, { quantity: 1, shelf: '', ...body });
  assert.equal((await edit(fw.body.item.id, { part_number: 'fw04567-gby' })).status, 200);
  items = (await inventory()).items;
  assert.deepEqual(matchesOf(fw.body.item.id), [['702', 'Work order', false]]);
  assert.equal((await edit(fw.body.item.id, { part_number: '--' })).status, 400);
  assert.deepEqual((await edit(fw.body.item.id, { part_number: 'FW04567GTN', shelf: 'B2' })).body, { updated: true });
  items = (await inventory()).items;
  assert.deepEqual(items.filter(entry => entry.id === fw.body.item.id).map(entry => [entry.part_number, entry.shelf]), [['FW04567GTN', 'B2']]);
  assert.deepEqual(matchesOf(fw.body.item.id), []);
  const taken = await edit(fw.body.item.id, { part_number: 'dw02842 gby', shelf: 'B2' });
  assert.equal(taken.status, 409);
  assert.deepEqual(taken.body.existing, { id: stock.id, part_number: 'DW02842GBY', quantity: 1 });
  assert.deepEqual((await edit(fw.body.item.id, { part_number: 'dw02842 gby', shelf: 'B2', combine: true })).body, { combined: stock.id });
  items = (await inventory()).items;
  assert.deepEqual(items.filter(entry => entry.section === 'stock').map(entry => [entry.part_number, entry.quantity, entry.shelf]), [['DW02842GBY', 2, 'B2']]);
  assert.equal((await edit(fw.body.item.id, { part_number: 'FW04567GBY' })).status, 404);
  assert.equal((await request(`/api/autoglass/inventory/${stock.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await request(`/api/autoglass/inventory/${stock.id}`, { method: 'DELETE' })).status, 404);
  await stop();

  // The daily check runs on its own once the hour has come, once a day.
  omegaJobs.push({ id: '705', document_date: day(-1), job_status: 'QO', Items: [item('HAH000448')] });
  stop = await startServer({ ...connected, AUTOGLASS_CHECK_HOUR: '0', AUTOGLASS_CHECK_SECONDS: '1' }, dataDir);
  for (let i = 0; i < 50 && sent.length < 2; i++) await delay(100);
  assert.equal(sent.length, 2);
  assert.equal(sent[1].subject, 'Old inventory match: HAH000448 for Quote #705');
  await delay(2500);
  assert.equal(sent.length, 2, 'not again the same day');
  request = client();
  await request('/api/login', { method: 'POST', body: { username: 'mary', password: 'staff-test' } });
  const status = (await inventory()).check;
  assert.equal(status.checkHour, 0);
  assert.equal(status.last.emailed, 1);
});
