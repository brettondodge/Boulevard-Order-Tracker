import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { postgresOptions } from '../src/postgres-connection.js';

const internal = 'postgresql://testuser:test-password@dpg-synthetic-a/test';
test('private Render transport requires TLS and URL options cannot disable it', () => {
  for (const suffix of ['', '?sslmode=disable', '?sslmode=require', '?ssl=false']) {
    const client = new pg.Client(postgresOptions(internal + suffix, { RENDER: 'true' }));
    assert.deepEqual(client.connectionParameters.ssl, { rejectUnauthorized: false });
    assert.equal(client.connectionParameters.host, 'dpg-synthetic-a');
  }
  assert.throws(() => postgresOptions(internal + '?host=external.example', { RENDER: 'true' }), /overrides/);
});

test('certificate exception is limited to private Render hostnames on Render', () => {
  for (const url of [internal.replace('dpg-synthetic-a', 'dpg-synthetic-a.oregon-postgres.render.com'), internal.replace('dpg-synthetic-a', 'external.example'), internal.replace('dpg-synthetic-a', '127.0.0.1')]) {
    for (const suffix of ['', '?sslmode=no-verify', '?sslmode=disable', '?ssl=false']) {
      assert.deepEqual(new pg.Client(postgresOptions(url + suffix, { RENDER: 'true' })).connectionParameters.ssl, { rejectUnauthorized: true });
    }
  }
  assert.deepEqual(postgresOptions(internal, { RENDER: 'false' }).ssl, { rejectUnauthorized: true });
});

test('local isolated databases support plaintext only outside Render', () => {
  const local = internal.replace('dpg-synthetic-a', '127.0.0.1');
  assert.equal(postgresOptions(local, { RENDER: 'false' }).ssl, false);
  assert.deepEqual(postgresOptions(local, { RENDER: 'false', PGSSLMODE: 'verify-full' }).ssl, { rejectUnauthorized: true });
});

test('self-signed Postgres accepts encrypted private policy and rejects external policy', { timeout: 60000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'boulevard-pg-tls-'));
  const key = path.join(directory, 'server.key');
  const cert = path.join(directory, 'server.crt');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
  await chmod(key, 0o600);
  const cluster = new EmbeddedPostgres({ databaseDir: path.join(directory, 'cluster'), port: 55440, user: 'testuser', password: 'test-password', persistent: false, postgresFlags: ['-c', 'ssl=on', '-c', `ssl_cert_file=${cert}`, '-c', `ssl_key_file=${key}`], onLog: () => {}, onError: () => {} });
  let client;
  let strict;
  try {
    await cluster.initialise(); await cluster.start();
    const localConnection = 'postgresql://testuser:test-password@127.0.0.1:55440/postgres';
    const options = postgresOptions(internal, { RENDER: 'true' });
    // Route the same private TLS policy to an isolated test server, never Render.
    client = new pg.Client({ ...options, connectionString: localConnection });
    await client.connect();
    assert.equal((await client.query('SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()')).rows[0].ssl, true);
    strict = new pg.Client(postgresOptions(localConnection, { RENDER: 'true' }));
    await assert.rejects(strict.connect(), /self.signed certificate/i);
  } finally {
    await client?.end(); await strict?.end(); await cluster.stop();
    await rm(directory, { recursive: true, force: true });
  }
});
