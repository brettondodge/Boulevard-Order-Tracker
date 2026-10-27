import http from 'node:http';
import { createHmac } from 'node:crypto';

// A stand-in for the Housecall Pro API (GET /jobs, /jobs/:id, /jobs/:id/invoices)
// so tests never reach the real service. Synthetic records only.
export async function startFakeHcp({ apiKey = 'synthetic-hcp-key' } = {}) {
  const jobs = new Map();
  const invoices = new Map();
  const requests = [];
  let rateLimitNext = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fake');
    requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization });
    const send = (status, body, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
    if (req.headers.authorization !== `Token ${apiKey}`) return send(401, { error: 'unauthorized' });
    if (rateLimitNext > 0) { rateLimitNext -= 1; return send(429, {}, { 'RateLimit-Reset': String(Math.floor(Date.now() / 1000)) }); }
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts[0] !== 'jobs') return send(404, {});
    if (parts.length === 1) {
      const all = [...jobs.values()].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      const page = Number(url.searchParams.get('page') || 1);
      const size = Number(url.searchParams.get('page_size') || 10);
      return send(200, { jobs: all.slice((page - 1) * size, page * size), page, page_size: size, total_pages: Math.max(1, Math.ceil(all.length / size)), total_items: all.length });
    }
    const job = jobs.get(parts[1]);
    if (!job) return send(404, {});
    if (parts[2] === 'invoices') return send(200, { invoices: invoices.get(parts[1]) || [] });
    return send(200, job);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    apiKey,
    jobs,
    invoices,
    requests,
    rateLimitOnce(count = 1) { rateLimitNext = count; },
    close: () => new Promise(resolve => server.close(resolve))
  };
}

// A job shaped like the HCP Job model / job webhook payload.
export function syntheticHcpJob(overrides = {}) {
  return {
    id: 'job_00000000000000000000000000000001',
    invoice_number: '10239422',
    description: 'Synthetic window install',
    customer: { id: 'cus_1', first_name: 'Synthetic', last_name: 'Customer', company: '' },
    work_status: 'needs scheduling',
    work_timestamps: { on_my_way_at: null, started_at: null, completed_at: null },
    schedule: { scheduled_start: null, scheduled_end: null, arrival_window: 0, time_zone: null, scheduled_start_local: null, scheduled_end_local: null },
    total_amount: 125000,
    outstanding_balance: 125000,
    assigned_employees: [],
    tags: [],
    original_estimate_id: null,
    created_at: '2026-10-20T16:00:00Z',
    updated_at: '2026-10-20T16:00:00Z',
    canceled_at: null,
    deleted_at: null,
    ...overrides
  };
}

export function signWebhook(body, secret, timestamp = Math.floor(Date.now() / 1000)) {
  return { 'Api-Timestamp': String(timestamp), 'Api-Signature': createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex') };
}
