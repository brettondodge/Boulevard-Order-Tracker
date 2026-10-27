// Housecall Pro public API client (https://docs.housecallpro.com).
// The company API key comes from the server environment (HCP_API_KEY) and
// never reaches the browser or the database. Only GET requests are made.
const DEFAULT_BASE = 'https://api.housecallpro.com';
const MAX_RATE_LIMIT_WAIT_MS = 30000;

export class HcpError extends Error {
  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

export const hcpApiConfigured = () => Boolean(process.env.HCP_API_KEY);

export function createHcpClient({ apiKey = process.env.HCP_API_KEY, baseUrl = process.env.HCP_API_BASE || DEFAULT_BASE, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (!apiKey) throw new HcpError("Housecall Pro isn't connected. Add HCP_API_KEY to the server settings.", 503);

  async function get(path, query = {}) {
    const url = new URL(path, baseUrl);
    for (const [key, value] of Object.entries(query)) {
      for (const item of [].concat(value)) if (item !== undefined && item !== null && item !== '') url.searchParams.append(key, String(item));
    }
    for (let attempt = 0; ; attempt += 1) {
      let response;
      try {
        response = await fetch(url, { headers: { Authorization: `Token ${apiKey}`, Accept: 'application/json' } });
      } catch {
        throw new HcpError('Could not reach Housecall Pro.');
      }
      // Over the limit: HCP sends RateLimit-Reset (epoch seconds). Wait, then retry a few times.
      if (response.status === 429 && attempt < 3) {
        const reset = Number(response.headers.get('RateLimit-Reset'));
        const wait = Number.isFinite(reset) && reset > 0 ? Math.max(1000, reset * 1000 - Date.now()) : 5000;
        await sleep(Math.min(wait, MAX_RATE_LIMIT_WAIT_MS));
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
