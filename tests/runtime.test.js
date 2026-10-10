import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

for (const [name, override, expected] of [
  ['missing database', { DATABASE_URL: '' }, /Production deployment requires DATABASE_URL/],
  ['invalid database', { DATABASE_URL: 'sqlite:invalid' }, /not a valid Postgres/],
  ['weak session secret', { SESSION_SECRET: 'short' }, /SESSION_SECRET of at least 32/],
  ['missing Access', { CF_ACCESS_AUD: '' }, /requires CF_ACCESS_TEAM_DOMAIN/],
  ['missing admin gate credentials', { ADMIN_PASSWORD: '', ADMIN_PASSWORD_HASH: '' }, /requires ADMIN_PASSWORD/]
]) {
  test(`production fails clearly for ${name}`, () => {
    const result = spawnSync(process.execPath, ['src/server.js'], {
      env: { ...process.env, NODE_ENV: 'production', RENDER: 'false', DATABASE_URL: 'postgresql://synthetic:synthetic@127.0.0.1:1/test', SESSION_SECRET: 'synthetic-secret-at-least-32-characters', ADMIN_PASSWORD: 'synthetic-password', ADMIN_PASSWORD_HASH: '', CF_ACCESS_TEAM_DOMAIN: 'test.cloudflareaccess.com', CF_ACCESS_AUD: 'synthetic-aud', ...override }, encoding: 'utf8', timeout: 5000
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
  });
}
