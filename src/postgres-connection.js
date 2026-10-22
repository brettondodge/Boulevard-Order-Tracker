export function postgresOptions(connectionString, environment = process.env) {
  if (!/^postgres(ql)?:\/\//i.test(connectionString || '')) throw new Error('A Postgres connection URL is required');
  let url;
  try { url = new URL(connectionString); } catch { throw new Error('A valid Postgres connection URL is required'); }
  // Query parameters must not redirect a connection after classifying its host.
  for (const key of ['host', 'hostaddr', 'port', 'user', 'password', 'dbname']) {
    if (url.searchParams.has(key)) throw new Error('Postgres connection overrides are not supported');
  }
  const internalRender = environment.RENDER === 'true' && /^dpg-[a-z0-9]+-[a-z]$/.test(url.hostname);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  const requestedMode = url.searchParams.get('sslmode') || environment.PGSSLMODE;
  const localPlaintext = loopback && environment.RENDER !== 'true' && (!requestedMode || requestedMode === 'disable');
  // pg URL SSL parameters override the ssl object. Apply one transport policy,
  // including when an external URL requests disable or no-verify.
  for (const key of ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'uselibpqcompat']) url.searchParams.delete(key);
  return {
    connectionString: url.href,
    connectionTimeoutMillis: 10000,
    // Render private endpoints use self-signed certificates. Require TLS with
    // no plaintext fallback there; verify certificates on external endpoints.
    ssl: localPlaintext ? false : { rejectUnauthorized: !internalRender }
  };
}
