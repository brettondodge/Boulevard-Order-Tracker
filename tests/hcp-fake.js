import http from 'node:http';
import { createHmac } from 'node:crypto';

// A stand-in for the Housecall Pro API so tests never reach the real service.
// It answers the endpoints the tracker uses (jobs, job types, tags, job tags,
// job notes, job invoices, Pipeline statuses) in the shapes of HCP's
// published spec.
// Synthetic records only.
export async function startFakeHcp({ apiKey = 'synthetic-hcp-key' } = {}) {
  const jobs = new Map();
  const jobTypes = [];
  const tags = [];
  // Jobs board columns, in board order.
  const pipeline = [];
  const requests = [];
  const failing = new Map();
  let rateLimitNext = 0;
  let rateLimitHeaders = null;
  let readOnly = false;
  let active = 0;
  let nextId = 1;
  const state = { maxConcurrent: 0 };

  const page = (items, url, key) => {
    const number = Number(url.searchParams.get('page') || 1);
    const size = Number(url.searchParams.get('page_size') || 10);
    return { [key]: items.slice((number - 1) * size, number * size), page: number, page_size: size, total_pages: Math.max(1, Math.ceil(items.length / size)), total_items: items.length };
  };

  const server = http.createServer(async (req, res) => {
    active += 1;
    state.maxConcurrent = Math.max(state.maxConcurrent, active);
    res.on('finish', () => { active -= 1; });
    let raw = '';
    for await (const chunk of req) raw += chunk;
    await new Promise(resolve => setTimeout(resolve, 5));
    const url = new URL(req.url, 'http://fake');
    const body = raw ? JSON.parse(raw) : null;
    requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization, body });
    const send = (status, payload, headers = {}) => { res.writeHead(status, { 'Content-Type': 'application/json', ...headers }); res.end(JSON.stringify(payload)); };
    if (req.headers.authorization !== `Token ${apiKey}`) return send(401, { error: 'unauthorized' });
    if (rateLimitNext > 0) { rateLimitNext -= 1; return send(429, {}, rateLimitHeaders || { 'RateLimit-Reset': String(Math.floor(Date.now() / 1000)) }); }
    if (readOnly && req.method !== 'GET') return send(403, { error: 'read only key' });
    const parts = url.pathname.split('/').filter(Boolean);

    if (url.pathname === '/job_fields/job_types' && req.method === 'GET') return send(200, page(jobTypes, url, 'job_types'));
    if (url.pathname === '/tags' && req.method === 'GET') return send(200, page(tags, url, 'tags'));
    if (url.pathname === '/tags' && req.method === 'POST') {
      const tag = { id: `tag_${nextId++}`, name: body.name };
      tags.push(tag);
      return send(201, tag);
    }
    if (url.pathname === '/pipeline/statuses' && req.method === 'GET') return send(200, page(url.searchParams.get('resource_type') === 'job' ? pipeline : [], url, 'statuses'));
    if (url.pathname === '/pipeline/statuses' && req.method === 'PUT') {
      const target = jobs.get(body.resource_type === 'job' ? body.resource_id : '');
      const column = pipeline.findIndex(status => status.id === body.status_id);
      if (!target || column < 0) return send(404, { error: 'Not found' });
      // As documented: only forward, to a column with an equal or higher order.
      if (column < pipeline.findIndex(status => status.id === target.pipeline_status_id)) return send(422, { error: 'Pipeline status can only move forward' });
      target.pipeline_status_id = body.status_id;
      return send(200, { status_id: body.status_id, resource_id: target.id, resource_type: 'job', name: pipeline[column].name });
    }
    if (parts[0] !== 'jobs') return send(404, {});
    if (parts.length === 1) {
      const all = [...jobs.values()].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      return send(200, page(all, url, 'jobs'));
    }
    if (parts[1] && failing.has(parts[1])) return send(failing.get(parts[1]), {});
    const job = jobs.get(parts[1]);
    if (!job) return send(404, {});
    const tagNames = () => (job.tags || []).map(name => tags.find(tag => tag.name === name) || { id: '', name });
    if (parts[2] === 'tags' && req.method === 'POST') {
      const tag = tags.find(entry => entry.id === body.tag_id);
      if (!tag) return send(404, {});
      job.tags = [...new Set([...(job.tags || []), tag.name])];
      return send(201, { tags: tagNames() });
    }
    if (parts[2] === 'tags' && parts[3] && req.method === 'DELETE') {
      const tag = tags.find(entry => entry.id === parts[3]);
      job.tags = (job.tags || []).filter(name => name !== tag?.name);
      return send(200, { tags: tagNames() });
    }
    if (parts[2] === 'invoices' && req.method === 'GET') return send(200, { invoices: job.invoices || [] });
    if (parts[2] === 'notes' && req.method === 'POST') {
      const note = { id: `note_${nextId++}`, content: body.content };
      job.notes = [...(job.notes || []), note];
      return send(201, note);
    }
    if (parts.length === 2 && req.method === 'GET') {
      // Attachments only come back when asked for, as in the HCP spec.
      const { attachments, ...rest } = job;
      return send(200, url.searchParams.getAll('expand[]').includes('attachments') ? { ...rest, attachments: attachments || [] } : rest);
    }
    return send(404, {});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    apiKey,
    jobs,
    jobTypes,
    tags,
    pipeline,
    requests,
    writes: () => requests.filter(request => request.method !== 'GET'),
    rateLimitOnce(count = 1, headers = null) { rateLimitNext = count; rateLimitHeaders = headers; },
    failJob(id, status) { failing.set(id, status); },
    setReadOnly(value) { readOnly = value; },
    get maxConcurrent() { return state.maxConcurrent; },
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
    notes: [],
    job_fields: { job_type: null, business_unit: null },
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
