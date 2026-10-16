# Boulevard Glass Tools — Freeport first version

This extends the existing Express application and deployment. No hosting, DNS,
production migration or production record changes were executed during development.

## Local run

Use Node 22, then `npm ci`. Copy `.env.example` to `.env` if needed. Set
`SQLITE_DATA_DIR` to a **new private development directory**, `PREVIEW_MODE=false`,
and `APP_PORT=3000`; run `npm start`. Do not point development at a live database.
Open `http://localhost:3000/login`. The existing local demo staff sign-in applies;
production continues to use verified Cloudflare Access identity. The existing
separate Master Lists administrator gate also protects Freeport settings.

Routes:

- `/`: authenticated Tools dashboard.
- `/app`: existing Order Tracker, unchanged address, query strings, assets and APIs.
- `/freeport`: Freeport Billing; direct subpath refreshes render the module.
- `/api/freeport/*`: namespaced authenticated records, imports, files and exports.
- `/login?next=/freeport`: existing login returns to the requested tool.

The root intentionally changes from tracker entry to dashboard. No tracker deep
link was moved, so no broad compatibility redirects are needed. The old PWA
manifest still opens `/app`. Freeport month and package selections are saved in
the URL for refreshable links. Tracker behavior changes are limited to navigation.

## Office workflow

1. Open Administration, unlock the existing admin gate, and enter verified
   remittance information, account codes, approved catalog variants and aliases.
   The first-version administration editor uses structured JSON with save/error
   feedback. Catalog records include both item name and description. Zero defaults
   and incomplete descriptions remain explicitly marked for review.
2. Select a billing month. Import a selectable-text PDF containing one or more
   invoices; quotes stay distinguishable. Review every source document and its
   page grouping. The parser is conservative and never makes an import trusted.
3. Open each invoice. Supply mapping fields, source units, missing financial
   values, charge classification and export descriptions. Tab navigates the
   charge table. Identical technician rows stay separate. Alias suggestions match
   both name and description and do not alter billed prices. Unknown charges
   stay unmapped until a person reviews them. Account dropdown suggestions come
   from the editable verified accounts list.
4. Assign a billing month independently of invoice dates. Add work-order PDFs,
   before/after PNG/JPEG photos, timing source, completion time and notes. Time
   inputs explicitly use Phoenix. Missing actual/on-site durations remain missing
   in coverage, while billed hour-unit quantities are reported separately.
5. Create a monthly package, include selected invoices and save. Inspect source
   tax, monthly recomputation, selected tax, export-extension differences and
   payment-allocation difference. Record per-issue financial decisions and tax
   reasoning where required. One staff member can prepare and finalize.
6. Mark Ready for Review, save, then finalize. A changed invoice or settings
   version requires saving/reviewing again. Finalization freezes jobs, mappings,
   settings, dates, totals and a unique `FMI-YYYY-MM-XXXXXXXX` reference. The suffix
   is random, not an Omega invoice number. Its printed label is configurable.
7. Download Excel, consolidated INVOICE PDF, detailed landscape PDF, supporting
   included invoice pages and the internal allocation JSON. Each uses the saved
   snapshot. Supporting PDFs preserve page content and invoice page order; the
   original uploaded PDFs remain intact. Excluded invoice pages are not appended.
8. Mark Sent and record a manual check/payment reference separately. The UI and
   allocation report explicitly state that payment is not verified in Omega.
   Cancel/revise requires a reason, releases active claims transactionally and
   preserves prior snapshots/downloads. A revision receives a new reference.

This app does not create an accounting receivable or post to Omega/QuickBooks,
submit to Freeport, send email or run a payment processor.

## Persistence, isolation and security

`002-freeport.sql` is additive. Existing tracker and identity tables are unchanged.
Postgres uses the existing ordered migration runner; SQLite records the module
migration in `schema_migrations`. Freeport versioned jobs, packages, settings and
import conflicts use separate `freeport_records` documents. `freeport_files`,
`freeport_invoice_claims` and `freeport_audit` have dedicated tables. Stored source
extraction and correction history are separate from mappings. Meaningful changes
record the existing username, before/after evidence and timestamps.

The database is the attachment store: original bytes are private base64 data,
limited to 20 MB per upload and 200 PDF pages per import. Production Postgres is
already durable and privately configured through `DATABASE_URL`; no ephemeral
Render filesystem is used for attachments. Database dumps include files and
snapshots. This adds about one-third storage overhead for binary files. Consider
private object storage later if volume warrants it; do not place uploads under
`public/` or introduce public bucket URLs.

Every Freeport API/file/export checks the existing staff session. Cloudflare
verification still covers production requests before routing. Settings/audit also
require the existing administrator gate. New HTML pages live outside public static
assets. Cross-origin mutations are rejected. Concurrent saves require the last
record version. Finalization and invoice claims are atomic; a Postgres advisory
transaction lock serializes competing workers, with a database primary key as a
second guard. SQLite serializes module transactions on the same connection.

Money uses Decimal and explicit half-up rounding to cents. Catalog prices never
replace imported billed rates. Original invoice tax/total remain source evidence;
corrections require a reason and do not claim to change Omega. Export quantity/rate
extensions and their differences remain visible, including on internal allocation.
The monthly tax comparator is configurable (initially 9.1% of mapped parts), not a
claim about all future tax treatment.

## References inspected and limitations

The connected Google Drive plugin read the provided spreadsheet on October 16,
2026. Its flattened export contains ten sections: January–September plus template.
Independent Decimal aggregation verified September's 96 rows, 21 supplier
references, parts $7,998.02 and labor $14,082.50. The exact 15 export headings,
intentional blanks, Work Order type, company code, long Order Numbers and PO
values were inspected. Invoice 10239160 has two separate quantity-2 labor rows at
125, with source PO mapped to spreadsheet Order Number. The sheet also contains
inconsistent units (including some labor as `ea` and glass as `hr`); these must be
reviewed, not automatically corrected or treated as timing evidence.

The spreadsheet-derived private text is only under ignored `data/freeport-reference/`.
It is not a production import or a Git fixture. Automated financial tests use
synthetic/redacted examples and the user-provided verified amounts.

The individual/consolidated PDFs, native Omega sample and departmental-code photo
were **not attached**. Therefore the parser is tested on generated selectable-text
multi-page layouts, not verified against the actual Omega sample. Extraction may
need adjustment for its columns, totals or multiline descriptions. Missing values
stay review issues. The parser groups repeated invoice identifiers/continuations;
without identifiers a person must verify grouping and page arrays. Fully ambiguous
scans can be retained and manually entered; unidentified invoice numbers can be
replaced with reviewed identifiers, and manual invoices can receive an Original
invoice PDF attachment with editable page inclusion; local `tesseract`/Poppler tools were
not installed, and no external OCR service was added. Do not treat this as verified
September source-PDF reconstruction. The 727.81 source tax, 727.82 monthly tax and
one-cent difference are tested from supplied acceptance values, not independently
read from unavailable invoices. The visual consolidated layout cannot yet be
compared to the missing approved example. No account-code digits or department
names were invented from the missing photo. Enter verified codes in Administration.

Freeport acceptance of the package reference, remittance information, departmental
codes, units and sample-derived labor reference rates still need confirmation.
The supplied list's incomplete descriptions and zero-default treatment stay marked
for review. Catalog administration is functional but currently a JSON editor.
Automatic OCR and a ZIP bundle are not included; individual required downloads
are available. The detail PDF uses a large landscape page to keep all 15 columns
readable and repeats headers across pages.

## Checks and repeatable verification

- `npm test`: tracker regression tests, isolated SQLite lifecycle and real temporary
  Postgres/Cloudflare-signature tests; no production credentials/database required.
- `node scripts/check-freeport-browser.mjs`: full synthetic desktop/tablet browser
  workflow using installed Google Chrome on macOS. Prints the temporary artifact
  directory. Change the executable path if running on another OS.
- `git diff --check`: whitespace validation.

The final dependency install audit reported zero vulnerabilities. ExcelJS uses a
compatible patched UUID override; workbook generation remains covered by tests.

Tests cover exact XLSX order/types/blanks, duplicated labor rows, original billed
prices, variants, unmapped items, missing units, leap years/Phoenix dates, actual
versus on-site versus technician-hours, combined PDFs, reimport conflicts, protected
files, stale updates, frozen settings, revisions, concurrent finalization and
restart persistence. Browser checks exercise login, both cards, tracker/back
navigation, import, review/save, settings, finalization, all downloads and refresh.
Synthetic invoice/detail PDFs and desktop/tablet screenshots were visually inspected.

## Existing-service deployment preparation — not executed

The repo's Render configuration runs one Express server with `npm ci`,
`npm run migrate:postgres` before deploy, and `npm start`. Express owns page and API
routes. There is no separate frontend build, static-host fallback rewrite, new DNS
record or second service required for `/freeport`. Existing Cloudflare Access must
continue to cover **all paths** on tools.blvdglass.com. Keep auto-deploy off while
reviewing this feature branch; do not repoint the live branch or deploy as part of
local implementation. The public root website is unaffected.

Before an approved production update:

1. Obtain a fresh verified full Postgres backup using the existing worker, including
   the prior application commit identifier. Confirm a restore into an isolated
   recovery database. Preserve the current backup identity and monitor configuration.
2. Rehearse `002-freeport.sql` and app startup against an isolated restored database;
   compare tracker IDs, counts and field fingerprints before/after. Inspect the real
   source documents, remittance and department codes before office billing use.
3. On an approved deployment of the existing service, use its existing secret
   environment, build/start/pre-deploy commands and all-path Access policy. No new
   secret is needed for the module. Check authenticated `/`, `/app`, `/freeport`,
   original tracker APIs/deep links, and unauthenticated download denial.
4. Verify the next backup includes Freeport tables and private file bytes. Fingerprint
   support includes the new tables and preserves verification of older manifests.

Rollback: redeploy the prior known-good application commit while keeping the
additive Freeport tables and all snapshots/files. The old tracker ignores them.
Do **not** drop/truncate those tables to roll back code. If restoring the whole
pre-update database becomes necessary, first stop writes, preserve a fresh full
backup, and assess all tracker/Freeport changes since that snapshot; a restore can
lose newer work. Rehearse on a separate database before any approved live recovery.
Never test migrations, restores or automated tests against the live service.

## Adding a future tool

Edit `public/tools.json` to register a real title, description, label and local
path. The dashboard reads this registry on each request, without a frontend build.
Add the actual authenticated tool route/module separately. Do not add placeholder
cards or a plugin framework.
