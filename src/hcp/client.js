// Housecall Pro public API client (https://docs.housecallpro.com).
// The company API key comes from the server environment (HCP_API_KEY) and
// never reaches the browser or the database. Only GET requests are made.
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

// Every HCP request in the app (sync, webhook re-reads, refreshes after an
// edit) waits its turn, so the tracker never sends HCP a burst.
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

export function createHcpClient({ apiKey = process.env.HCP_API_KEY, baseUrl = process.env.HCP_API_BASE || DEFAULT_BASE, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (!apiKey) throw new HcpError("Housecall Pro isn't connected. Add HCP_API_KEY to the server settings.", 503);

  const get = (path, query) => oneAtATime(() => request(path, query));

  async function request(path, query = {}) {
    const url = new URL(path, baseUrl);
    for (const [key, value] of Object.entries(query)) {
      for (const item of [].concat(value)) if (item !== undefined && item !== null && item !== '') url.searchParams.append(key, String(item));
    }
    for (let attempt = 0; ; attempt += 1) {
      let response;
      try {
        // A hung request must not stall the hourly sync.
        response = await fetch(url, { headers: { Authorization: `Token ${apiKey}`, Accept: 'application/json' }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      } catch {
        throw new HcpError('Could not reach Housecall Pro.');
      }
      // Over the limit: HCP sends RateLimit-Reset (epoch seconds). Wait, then retry a few times.
      if (response.status === 429 && attempt < 3) {
        await sleep(Math.min(Math.max(1000, rateLimitWait(response.headers)), MAX_RATE_LIMIT_WAIT_MS));
        continue;
      }
      if (response.status === 401 || response.status === 403) throw new HcpError('Housecall Pro rejected the API key. Check HCP_API_KEY.', response.status);
      if (response.status === 404) return null;
      if (!response.ok) throw new HcpError(`Housecall Pro answered ${response.status}.`, response.status);
      return response.json();
    }
  }

  return {
    getJob: id => get(`/jobs/${encodeURIComponent(id)}`),
    getJobInvoices: async id => (await get(`/jobs/${encodeURIComponent(id)}/invoices`))?.invoices || [],
    listJobs: ({ page = 1, pageSize = 100, sortBy = 'created_at', sortDirection = 'desc' } = {}) => get('/jobs', { page, page_size: pageSize, sort_by: sortBy, sort_direction: sortDirection })
  };
}
