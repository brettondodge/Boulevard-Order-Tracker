// Housecall Pro public API client (https://docs.housecallpro.com).
// The company API key comes from the server environment (HCP_API_KEY) and
// never reaches the browser or the database. The tracker reads jobs, job
// types and tags; its only writes are job tags and job notes, which need a
// key created with Full access.
const DEFAULT_BASE = 'https://api.housecallpro.com';
const MAX_RATE_LIMIT_WAIT_MS = 30000;
const REQUEST_TIMEOUT_MS = 20000;

export class HcpError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

export const hcpApiConfigured = () => Boolean(process.env.HCP_API_KEY);

// Every HCP request in the app (sync, webhook re-reads, lookups, tags and
// notes) waits its turn, so the tracker never sends HCP a burst.
let queue = Promise.resolve();
function oneAtATime(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

// How long HCP asks us to wait. RateLimit-Reset may be seconds to wait or an
// epoch time (HCP doesn't say); Retry-After is seconds.
function rateLimitWait(headers) {
  const retryAfter = Number(headers.get('Retry-After'));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  const reset = Number(headers.get('RateLimit-Reset'));
  if (!Number.isFinite(reset) || reset <= 0) return 5000;
  return reset < 1e9 ? reset * 1000 : reset * 1000 - Date.now();
}

// HCP's own explanation of a refused request, when it sends one.
async function problemText(response) {
  try {
    const data = JSON.parse(await response.text());
    const message = String(data?.error || data?.message || '').trim();
    return message ? `: ${message.slice(0, 200)}` : '';
  } catch {
    return '';
  }
}

export function createHcpClient({ apiKey = process.env.HCP_API_KEY, baseUrl = process.env.HCP_API_BASE || DEFAULT_BASE, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (!apiKey) throw new HcpError("Housecall Pro isn't connected. Add HCP_API_KEY to the server settings.", 503);

  const call = (method, path, options) => oneAtATime(() => request(method, path, options));

  async function request(method, path, { query = {}, body } = {}) {
    const url = new URL(path, baseUrl);
    for (const [key, value] of Object.entries(query)) {
      for (const item of [].concat(value)) if (item !== undefined && item !== null && item !== '') url.searchParams.append(key, String(item));
    }
    for (let attempt = 0; ; attempt += 1) {
      let response;
      try {
        // A hung request must not stall the hourly sync.
        response = await fetch(url, {
          method,
          headers: { Authorization: `Token ${apiKey}`, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
      } catch {
        throw new HcpError('Could not reach Housecall Pro.');
      }
      // Over the limit: wait as HCP asks, then retry a few times. Nothing was
      // changed on a 429, so retrying a write is safe.
      if (response.status === 429 && attempt < 3) {
        await sleep(Math.min(Math.max(1000, rateLimitWait(response.headers)), MAX_RATE_LIMIT_WAIT_MS));
        continue;
      }
      if (response.status === 401 || response.status === 403) {
        throw new HcpError(method === 'GET'
          ? 'Housecall Pro rejected the API key. Check HCP_API_KEY.'
          : "Housecall Pro didn't allow the change. The API key needs Full access to add tags, notes and Pipeline moves.", response.status);
      }
      if (response.status === 404) return null;
      if (!response.ok) throw new HcpError(`Housecall Pro answered ${response.status}${await problemText(response)}.`, response.status);
      const text = await response.text();
      return text ? JSON.parse(text) : {};
    }
  }

  async function allPages(path, key, query = {}) {
    const items = [];
    for (let page = 1; page <= 20; page += 1) {
      const result = await call('GET', path, { query: { ...query, page, page_size: 100 } });
      const batch = result?.[key] || [];
      items.push(...batch);
      if (!batch.length || page >= Number(result?.total_pages || page)) break;
    }
    return items;
  }

  const job = id => `/jobs/${encodeURIComponent(id)}`;
  return {
    getJob: (id, { expand = [] } = {}) => call('GET', job(id), { query: { 'expand[]': expand } }),
    listJobs: ({ page = 1, pageSize = 100, sortBy = 'created_at', sortDirection = 'desc' } = {}) => call('GET', '/jobs', { query: { page, page_size: pageSize, sort_by: sortBy, sort_direction: sortDirection } }),
    listJobTypes: () => allPages('/job_fields/job_types', 'job_types'),
    listTags: () => allPages('/tags', 'tags'),
    createTag: name => call('POST', '/tags', { body: { name } }),
    addJobTag: (jobId, tagId) => call('POST', `${job(jobId)}/tags`, { body: { tag_id: tagId } }),
    removeJobTag: (jobId, tagId) => call('DELETE', `${job(jobId)}/tags/${encodeURIComponent(tagId)}`),
    addJobNote: (jobId, content) => call('POST', `${job(jobId)}/notes`, { body: { content } }),
    listJobInvoices: jobId => call('GET', `${job(jobId)}/invoices`),
    // Pipeline add-on. HCP only moves a record forward on the board.
    listPipelineStatuses: resourceType => allPages('/pipeline/statuses', 'statuses', { resource_type: resourceType }),
    updatePipelineStatus: ({ resourceType, resourceId, statusId }) => call('PUT', '/pipeline/statuses', { body: { resource_type: resourceType, resource_id: resourceId, status_id: statusId } })
  };
}
