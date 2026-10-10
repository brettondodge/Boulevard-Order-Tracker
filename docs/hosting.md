# Boulevard Tools hosting and recovery

This continues the existing tracker. Nothing in this document establishes that a provider service is configured or tested. Reuse **boulevard-tools-db**, Oregon. Staff address: **tools.blvdglass.com**. Leave the main website and email working at their current providers.

## Current evidence

The Mac SQLite database was backed up with the supported online backup API. A restored copy opened and passed integrity_check. Verification evidence and SHA-256 are saved under the ignored data/backups/codex-handoff-* directory. At this snapshot there were 286 orders, 65 drafts, 95 suppliers, 3 staff names and 2 users. The snapshot is local only, not an independent cloud backup.

Eighteen checks passed across the local suite, the Postgres integration test, and production configuration tests. Tests use temporary SQLite databases and a temporary real Postgres cluster. The Postgres test substitutes synthetic Cloudflare signing keys inside the test child process; it does not establish a working Cloudflare account, DNS, live Access login, Render deployment, S3 upload or hosted restore.

## Step 1: Preserve DNS and prepare Cloudflare

1. In FatCow save/export every existing DNS record. Include A, AAAA, CNAME, MX and TXT records (SPF, DKIM and DMARC). Save their names, values and priorities privately.
2. In Cloudflare add blvdglass.com as an existing domain. Compare its imported DNS records with FatCow's full list. Automatic scanning can miss records.
3. Keep existing website and email records initially DNS-only. Do not change nameservers until the records have been compared. Do not replace the root domain or www with Render records.
4. Once records match, change the domain's authoritative nameservers at its registrar to the two Cloudflare provides. Verify the business website and sending/receiving email, and wait for Cloudflare Active.
5. Create a Cloudflare Zero Trust organization. Add a self-hosted Access application for tools.blvdglass.com, covering all paths. Set a seven-day application and policy session duration (or the office's preferred limit). Use an Allow policy with explicit approved staff email addresses and email one-time PIN or the chosen identity provider. Do not add Everyone, Bypass, or public API exclusions.
6. Copy the team hostname (for example company.cloudflareaccess.com) and the application's AUD tag into Render's CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD fields. These are identifiers; keep credentials in provider settings.

## Step 2: Prepare Render without creating another database

First check for an existing tracker web service. Reuse it if present. If none exists, create one web service with these fields when ready to deploy:

| Field | Value |
| --- | --- |
| Repository | brettondodge/Boulevard-Order-Tracker |
| Branch | codex/production-preparation |
| Service name | boulevard-order-tracker |
| Runtime | Node |
| Region | Oregon |
| Instance | Paid 0.5 CPU / 512 MB (0.5c-512mb) |
| Build command | npm ci |
| Pre-deploy command | npm run migrate:postgres |
| Start command | npm start |
| Health check | /healthz |
| Auto-deploy | Off during preparation and cutover |
| NODE_ENV | production |
| PREVIEW_MODE | false |
| DATABASE_URL | Existing boulevard-tools-db **Internal Database URL**, entered as a secret |
| SESSION_SECRET | Random secret, at least 32 characters, entered directly |
| ADMIN_USERNAME | Chosen separate Master Lists admin name |
| ADMIN_PASSWORD | Strong separate Master Lists password, entered directly |
| CF_ACCESS_TEAM_DOMAIN | Zero Trust team hostname, no https:// or trailing slash |
| CF_ACCESS_AUD | Exact Access application AUD tag |

render.yaml has one web service and one scheduled backup job; it has no database provisioning block. Do not apply a Blueprint if that would duplicate an existing web service. Production startup fails without database, Access and session/admin configuration. It creates no sample staff account or demo orders. Import before first startup if the database must remain empty for import. The migration command only creates the schema.

Add tools.blvdglass.com under Render Custom Domains. Copy Render's exact DNS target and any verification records into Cloudflare. Create a DNS-only CNAME named tools pointing at that target first, so Render can verify the domain and issue its certificate. After Render confirms the certificate is valid, enable proxying for tools and use Full (strict) TLS. Until proxying is enabled, the app rejects requests without an Access token. Do not change zone-wide TLS settings for the existing website unless its certificate has been checked. No website or mail record should be replaced. The Blueprint also disables the default Render subdomain after assigning the custom domain; set that field in the dashboard too if configuring manually.

## Step 3: Final SQLite import

1. Rehearse against a separate empty test database first. Never use the live database for automated tests.
2. Stop local staff writes for the final snapshot. Run npm run backup:sqlite and use the verified snapshot, not a raw copy of a live SQLite file.
3. In a private terminal environment set IMPORT_DATABASE_URL to the target connection URL and CONFIRM_EMPTY_IMPORT=yes. Do not put URLs/passwords in chat, scripts, Git or screenshots.
4. Run npm run import:sqlite -- /absolute/path/to/snapshot.db. From your Mac use the external database URL with provider-required TLS; from Render use the internal URL.
5. The import transaction refuses any nonempty business table and compares every imported field, including stable IDs, dates, hashes and relationships. Rerunning against populated tables fails without replacing records. Schema migrations may already have been recorded even when a record import is rejected.
6. If the target is populated, stop and inspect it; do not truncate it to make import work. Preserve the old data and use an approved empty target or reviewed reconciliation.
7. Start the app after import. Existing staff logins are preserved as data, but production staff identity comes from validated Cloudflare Access. The separate admin gate remains.

## Step 4: Independent daily backups

Repository code and schedule are prepared, but S3, alerts and the backup container require provider configuration and an actual successful run. Docker, pg_dump and pg_restore are unavailable on this Mac; the container build, backup/upload and restore have not been tested here.

Create one private S3 bucket with Block Public Access enabled, default SSE-S3 encryption, and a lifecycle rule limited to boulevard-tools/daily/ expiring objects after 30 days. Daily keys overwrite the same day's backup on retries. If versioning is enabled, configure noncurrent version expiry too; otherwise old versions can survive the 30-day retention period.

Use s3-backup-iam.example.json (replace the bucket placeholder) and s3-lifecycle.example.json as the provider policy templates. Create backup credentials limited to s3:PutObject and s3:GetObject on arn:aws:s3:::YOUR_BUCKET/boulevard-tools/daily/*.dump. The backup worker requires no bucket-wide read, delete or admin permission. Use a separate administrator/recovery identity for listing and restores. Set a bucket policy requiring TLS. The worker exports a consistent Postgres snapshot, records counts and hashes of all business fields in S3 object metadata, and passes that same snapshot to pg_dump. It explicitly requests AES256 encryption, supplies SHA-256, downloads the uploaded object and checks its bytes before reporting success.

The paid Render cron service boulevard-tools-daily-backup runs Dockerfile.backup at 0 9 * * * UTC (2 a.m. Arizona). It uses PostgreSQL 18 pg_dump; confirm this supports the existing server version. Set AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, S3_BACKUP_BUCKET, S3_BACKUP_PREFIX=boulevard-tools/daily, and BACKUP_HEARTBEAT_URL privately. Enter the same existing database Internal URL into this job's DATABASE_URL secret. The job runs on Render while the laptop is off.

Configure a Healthchecks-compatible heartbeat monitor with a 24-hour period, a reasonable grace period (for example 2 hours), and email alerts to the responsible office owner. Enter its private HTTPS ping URL into BACKUP_HEARTBEAT_URL. Successful checksum verification sends a success ping; failure sends /fail. Missing runs are detected by the monitor. Enable Render cron failure notifications too. Test successful, failing and deliberately missed runs before relying on it. Missing configuration fails startup and must be covered by Render failure notifications.

## Step 5: Restore an uploaded backup

1. Create/use a separate empty recovery database; never test restore against boulevard-tools-db.
2. Use a recovery identity with private S3 credentials. Run node scripts/download-backup.js boulevard-tools/daily/YYYY-MM-DD.dump /private/path/backup.dump. This downloads and verifies SHA-256 before saving the dump and its .verification.json file. Do not treat S3 ETag as a SHA-256 checksum.
3. Set PGHOST, PGPORT, PGDATABASE, PGUSER and PGPASSWORD privately for the recovery database. Confirm the target database name and emptiness.
4. Run pg_restore --exit-on-error --single-transaction --no-owner --no-acl --dbname="$PGDATABASE" /private/path/backup.dump. Do not use --clean against a populated database.
5. Set RESTORE_TEST_DATABASE_URL privately to the recovery database and run node scripts/verify-restored-postgres.js /private/path/backup.dump.verification.json. This compares counts and hashes of all fields/IDs with the exact exported backup snapshot. Then inspect linked draft/orders and archived history, and run a separate test instance against the restored database. Verify staff protection, Master Lists gate, order creation and editing, and restart persistence.
6. Record backup object key, checksum, timestamp, server version, restore command, comparisons and app checks privately. This recovery remains **unverified** until an uploaded backup passes these checks.

## Step 6: Cutover acceptance

Do not switch staff until the final import passes, the hosted app is Access-protected, and an uploaded backup has been restored successfully. Verify missing/forged/expired/wrong-audience Access tokens fail, and direct onrender.com access cannot reach customer records. /healthz exposes only readiness, no business data. Verify seven-day remembered Access sessions on a phone, separate admin protection, live changes between two browsers, archives/restores and order/session persistence across restarts and redeployments. Keep the verified local snapshot for recovery; do not resume local writes after cutover.

Housecall Pro integration and future tools are outside this hosting preparation.

## Provider references

- [Render Cloudflare DNS and certificate sequence](https://render.com/docs/configure-cloudflare-dns)
- [Render Blueprint fields](https://render.com/docs/blueprint-spec)
- [Render scheduled jobs](https://render.com/docs/cronjobs)
- [Cloudflare Access JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)
- [S3 encryption](https://docs.aws.amazon.com/AmazonS3/latest/userguide/UsingServerSideEncryption.html)
- [Healthchecks missed-run monitoring](https://healthchecks.io/docs/)
