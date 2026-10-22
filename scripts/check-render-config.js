const required = [
  'DATABASE_URL',
  'SESSION_SECRET',
  'ADMIN_USERNAME',
  'ADMIN_PASSWORD',
  'PREVIEW_MODE',
  'NODE_ENV',
  'CF_ACCESS_TEAM_DOMAIN',
  'CF_ACCESS_AUD'
];

console.log('Render environment checklist');
console.log('==========================');

for (const name of required) {
  const value = process.env[name];
  if (value) {
    console.log(`${name}: configured`);
  } else {
    console.log(`${name}: missing`);
  }
}

console.log('');
console.log('DATABASE_URL source: Render > your Postgres database > Connections > Internal Database URL');
console.log('SESSION_SECRET source: Render > Environment > add secret value');
console.log('ADMIN_USERNAME source: your office admin login name');
console.log('ADMIN_PASSWORD source: your office admin password, stored as a Render secret');
console.log('PREVIEW_MODE source: set to false before production use');
console.log('NODE_ENV source: set to production in Render');
