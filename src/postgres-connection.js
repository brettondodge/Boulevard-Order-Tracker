export function postgresOptions(connectionString) {
  if (!/^postgres(ql)?:\/\//i.test(connectionString || '')) throw new Error('A Postgres connection URL is required');
  return { connectionString, connectionTimeoutMillis: 10000 };
}
