import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { getDb, getPool, isProduction } from '../db.js';
import { isoNow } from '../utils.js';
import { defaultAccounts, defaultItems, defaultSettings, previewInvoices } from './defaults.js';
import { FreeportError } from './validate.js';
import { billingMonthFor, pinMatchedItems } from '../../public/freeport-billing.js';

const SETTINGS_ID = 'current';
const newId = prefix => `${prefix}-${randomUUID()}`;
const toPostgres = sql => { let index = 0; return sql.replace(/\?/g, () => `$${++index}`); };
const isUniqueViolation = error => error?.code === '23505' || error?.code === 'SQLITE_CONSTRAINT_UNIQUE' || error?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY';

// SQLite has one connection, so its transactions run one after another.
let sqliteQueue = Promise.resolve();

async function sqliteTransaction(work) {
  const db = getDb();
  const tx = {
    get: async (sql, params = []) => db.prepare(sql).get(...params) ?? null,
    all: async (sql, params = []) => db.prepare(sql).all(...params),
    run: async (sql, params = []) => db.prepare(sql).run(...params).changes
  };
  // better-sqlite3 is synchronous, so these awaits settle as microtasks and no
  // other request can run until COMMIT. `work` must not await real I/O.
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = await work(tx);
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.inTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

// Runs `work` in one database transaction with a small get/all/run helper.
async function transaction(work) {
  if (!isProduction) {
    const result = sqliteQueue.then(() => sqliteTransaction(work));
    sqliteQueue = result.catch(() => {});
    return result;
  }

  const client = await (await getPool()).connect();
  const tx = {
    get: async (sql, params = []) => (await client.query(toPostgres(sql), params)).rows[0] ?? null,
    all: async (sql, params = []) => (await client.query(toPostgres(sql), params)).rows,
    run: async (sql, params = []) => (await client.query(toPostgres(sql), params)).rowCount
  };
  try {
    await client.query('BEGIN');
    const result = await work(tx);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

// ---------- Setup ----------

export async function initializeFreeport({ includePreviewInvoices = false } = {}) {
  if (!isProduction) {
    // Postgres gets these tables from the migration runner.
    const db = getDb();
    db.exec(fs.readFileSync(new URL('../../migrations/002-freeport.sql', import.meta.url), 'utf8'));
    db.exec(fs.readFileSync(new URL('../../migrations/005-freeport-months.sql', import.meta.url), 'utf8'));
    // Local databases created before these columns existed.
    const hasColumn = (table, column) => db.prepare(`SELECT COUNT(*) AS count FROM pragma_table_info('${table}') WHERE name = ?`).get(column).count > 0;
    if (!hasColumn('freeport_items', 'custom_description')) db.exec('ALTER TABLE freeport_items ADD COLUMN custom_description INTEGER NOT NULL DEFAULT 0');
    if (!hasColumn('freeport_invoice_lines', 'description')) db.exec('ALTER TABLE freeport_invoice_lines ADD COLUMN description TEXT');
    if (!hasColumn('freeport_invoices', 'omega_snapshot')) db.exec('ALTER TABLE freeport_invoices ADD COLUMN omega_snapshot TEXT');
    if (!hasColumn('freeport_invoices', 'equipment_number')) db.exec('ALTER TABLE freeport_invoices ADD COLUMN equipment_number TEXT');
    if (!hasColumn('freeport_invoices', 'serial_number')) db.exec('ALTER TABLE freeport_invoices ADD COLUMN serial_number TEXT');
  }

  await transaction(async tx => {
    const now = isoNow();
    const created = await tx.run(
      'INSERT INTO freeport_settings (id, data, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING',
      [SETTINGS_ID, JSON.stringify(defaultSettings), now, 'setup']
    );
    if (!created) return;

    for (const [index, account] of defaultAccounts.entries()) {
      await tx.run(
        'INSERT INTO freeport_accounts (code, name, area_group, using_area_name, active, sort_order, updated_at, updated_by) VALUES (?, ?, ?, ?, 1, ?, ?, ?)',
        [account.code, account.name, account.group, account.usingAreaName, index, now, 'setup']
      );
    }
    const items = defaultItems.map(item => ({ ...item, id: newId('item') }));
    for (const [index, item] of items.entries()) {
      await tx.run(
        'INSERT INTO freeport_items (id, sku, description, unit, item_type, price_cents, custom_description, active, sort_order, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)',
        [item.id, item.sku, item.description, item.unit, item.type, item.priceCents, item.customDescription ? 1 : 0, index, now, 'setup']
      );
    }
    if (includePreviewInvoices) {
      for (const invoice of previewInvoices) {
        const lines = pinMatchedItems(invoice.lines.map(line => ({ itemId: '', ...line })), items);
        await insertInvoice(tx, { omegaTaxCents: null, monthOverride: '', driveLink: '', notes: '', ...invoice, lines, billingMonth: billingMonthFor(invoice) }, 'preview');
      }
    }
  });
}

// ---------- Configuration ----------

const accountFromRow = row => ({ code: row.code, name: row.name, group: row.area_group, usingAreaName: row.using_area_name, active: Boolean(row.active) });
const itemFromRow = row => ({ id: row.id, sku: row.sku, description: row.description, unit: row.unit, type: row.item_type, priceCents: Number(row.price_cents), customDescription: Boolean(row.custom_description), active: Boolean(row.active) });

const usedItemIds = async tx => new Set((await tx.all('SELECT DISTINCT item_id FROM freeport_invoice_lines WHERE item_id IS NOT NULL')).map(row => row.item_id));

async function readConfig(tx) {
  const settingsRow = await tx.get('SELECT data FROM freeport_settings WHERE id = ?', [SETTINGS_ID]);
  const used = await usedItemIds(tx);
  return {
    settings: { ...defaultSettings, ...(settingsRow ? JSON.parse(settingsRow.data) : {}) },
    accounts: (await tx.all('SELECT * FROM freeport_accounts ORDER BY sort_order, code')).map(accountFromRow),
    items: (await tx.all('SELECT * FROM freeport_items ORDER BY sort_order, sku')).map(row => ({ ...itemFromRow(row), inUse: used.has(row.id) }))
  };
}

export function getConfig() {
  return transaction(readConfig);
}

export function saveSettings(settings, actor) {
  return transaction(async tx => {
    await tx.run('UPDATE freeport_settings SET data = ?, updated_at = ?, updated_by = ? WHERE id = ?', [JSON.stringify(settings), isoNow(), actor, SETTINGS_ID]);
    return readConfig(tx);
  });
}

export function saveAccounts(accounts, actor) {
  return transaction(async tx => {
    const now = isoNow();
    for (const [index, account] of accounts.entries()) {
      const params = [account.name, account.group, account.usingAreaName, account.active ? 1 : 0, index, now, actor, account.code];
      const updated = await tx.run('UPDATE freeport_accounts SET name = ?, area_group = ?, using_area_name = ?, active = ?, sort_order = ?, updated_at = ?, updated_by = ? WHERE code = ?', params);
      if (!updated) {
        await tx.run('INSERT INTO freeport_accounts (name, area_group, using_area_name, active, sort_order, updated_at, updated_by, code) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', params);
      }
    }
    return readConfig(tx);
  });
}

export function saveItems(items, actor) {
  return transaction(async tx => {
    const now = isoNow();
    // Type and the per-line setting decide totals and spreadsheet text, so they
    // can't change under invoices already saved with the item.
    const used = await usedItemIds(tx);
    const current = new Map((await tx.all('SELECT id, item_type, custom_description FROM freeport_items')).map(row => [row.id, row]));
    for (const item of items.filter(candidate => candidate.id && used.has(candidate.id))) {
      const before = current.get(item.id);
      if (before && (before.item_type !== item.type || Boolean(before.custom_description) !== item.customDescription)) {
        throw new FreeportError(400, `"${item.description}" is already on saved invoices, so its type and per-line description setting can't change. Add a new item and make this one inactive.`);
      }
    }
    for (const [index, item] of items.entries()) {
      const params = [item.sku, item.description, item.unit, item.type, item.priceCents, item.customDescription ? 1 : 0, item.active ? 1 : 0, index, now, actor];
      const updated = item.id
        ? await tx.run('UPDATE freeport_items SET sku = ?, description = ?, unit = ?, item_type = ?, price_cents = ?, custom_description = ?, active = ?, sort_order = ?, updated_at = ?, updated_by = ? WHERE id = ?', [...params, item.id])
        : 0;
      if (!updated) {
        if (item.id) throw new FreeportError(409, 'An item was removed while you were editing. Reload and try again.');
        await tx.run('INSERT INTO freeport_items (sku, description, unit, item_type, price_cents, custom_description, active, sort_order, updated_at, updated_by, id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [...params, newId('item')]);
      }
    }
    return readConfig(tx);
  });
}

// ---------- Invoices ----------

function parseSnapshot(value) {
  try {
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function invoiceFromRow(row, lines) {
  const snapshot = parseSnapshot(row.omega_snapshot);
  return {
    id: row.id,
    number: row.invoice_number,
    omegaDate: row.omega_date || '',
    installDate: row.install_date || '',
    monthOverride: row.month_override || '',
    billingMonth: row.billing_month,
    orderNumber: row.order_number || '',
    accountCode: row.account_code || '',
    omegaTaxCents: row.omega_tax_cents === null || row.omega_tax_cents === undefined ? null : Number(row.omega_tax_cents),
    driveLink: row.drive_link || '',
    notes: row.notes || '',
    equipmentNumber: row.equipment_number || '',
    serialNumber: row.serial_number || '',
    status: row.status,
    // What Omega said at the last import; its flag and subtotal feed the review checks.
    omegaSnapshot: snapshot,
    omegaFlag: snapshot?.flag || '',
    omegaSubtotalCents: Number.isInteger(snapshot?.subtotalCents) ? snapshot.subtotalCents : null,
    version: Number(row.version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    createdBy: row.created_by || '',
    updatedBy: row.updated_by || '',
    lines: lines.map(line => ({ id: line.id, sku: line.sku, itemId: line.item_id || '', description: line.description || '', quantity: line.quantity, rateCents: Number(line.rate_cents) }))
  };
}

async function readInvoice(tx, number) {
  const row = await tx.get('SELECT * FROM freeport_invoices WHERE invoice_number = ?', [number]);
  if (!row) return null;
  const lines = await tx.all('SELECT * FROM freeport_invoice_lines WHERE invoice_id = ? ORDER BY position', [row.id]);
  return invoiceFromRow(row, lines);
}

async function insertLines(tx, invoiceId, lines) {
  for (const [index, line] of lines.entries()) {
    await tx.run(
      'INSERT INTO freeport_invoice_lines (id, invoice_id, position, sku, item_id, description, quantity, rate_cents) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [newId('line'), invoiceId, index, line.sku, line.itemId || null, line.description || null, line.quantity, line.rateCents]
    );
  }
}

const invoiceColumns = invoice => [
  invoice.number, invoice.omegaDate || null, invoice.installDate || null, invoice.monthOverride || null, invoice.billingMonth,
  invoice.orderNumber || null, invoice.accountCode || null, invoice.omegaTaxCents, invoice.driveLink || null, invoice.notes || null, invoice.status,
  invoice.equipmentNumber || null, invoice.serialNumber || null
];

async function insertInvoice(tx, invoice, actor) {
  const id = newId('invoice');
  const now = isoNow();
  await tx.run(
    `INSERT INTO freeport_invoices (invoice_number, omega_date, install_date, month_override, billing_month, order_number, account_code,
      omega_tax_cents, drive_link, notes, status, equipment_number, serial_number, id, version, created_at, updated_at, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    [...invoiceColumns(invoice), id, now, now, actor, actor]
  );
  await insertLines(tx, id, invoice.lines);
}

const duplicateNumber = number => new FreeportError(409, `Invoice ${number} already exists.`, { existing: number });

export async function listMonths() {
  return transaction(async tx => {
    const rows = await tx.all(
      `SELECT billing_month, COUNT(*) AS invoice_count, SUM(CASE WHEN status = 'Ready' THEN 0 ELSE 1 END) AS needs_review
       FROM freeport_invoices GROUP BY billing_month ORDER BY billing_month DESC`
    );
    const records = new Map((await tx.all('SELECT * FROM freeport_months')).map(row => [row.month, monthFromRow(row)]));
    return rows.map(row => ({
      month: row.billing_month,
      invoices: Number(row.invoice_count),
      needsReview: Number(row.needs_review),
      status: records.get(row.billing_month)?.status ?? 'Open',
      revision: records.get(row.billing_month)?.revision ?? 0
    }));
  });
}

// ---------- Month-end packages ----------

const monthFromRow = row => ({ month: row.month, status: row.status, revision: Number(row.revision), correctionReason: row.correction_reason || '', updatedAt: row.updated_at, updatedBy: row.updated_by || '' });
const monthLabel = month => new Date(`${month}-01T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const SEND_FILES = { 'consolidated-invoice.pdf': 'consolidated_pdf', 'invoices.pdf': 'invoices_pdf', 'spreadsheet.xlsx': 'spreadsheet' };

// Invoices in a sent month can't change until someone starts a correction.
async function assertMonthOpen(tx, month) {
  if (!month) return;
  const row = await tx.get('SELECT status FROM freeport_months WHERE month = ?', [month]);
  if (row?.status === 'Sent') {
    throw new FreeportError(409, `${monthLabel(month)} was sent to Freeport, so its invoices are locked. Start a correction on Month close to change it.`, { lockedMonth: month });
  }
}

const sendFromRow = row => ({
  revision: Number(row.revision),
  packageNumber: row.package_number,
  reason: row.reason || '',
  invoiceNumbers: JSON.parse(row.invoice_numbers),
  totals: JSON.parse(row.totals),
  sentAt: row.sent_at,
  sentBy: row.sent_by
});

// Status of a month: 'Open' (never sent), 'Sent' (locked) or 'Correcting'
// (reopened to send revision R1, R2...), plus every package sent so far.
export function getMonthStatus(month) {
  return transaction(async tx => {
    const record = await tx.get('SELECT * FROM freeport_months WHERE month = ?', [month]);
    const sends = await tx.all(
      'SELECT revision, package_number, reason, invoice_numbers, totals, sent_at, sent_by FROM freeport_month_sends WHERE month = ? ORDER BY revision DESC',
      [month]
    );
    return { month, status: 'Open', revision: 0, correctionReason: '', ...(record ? monthFromRow(record) : {}), sends: sends.map(sendFromRow) };
  });
}

export async function lockedMonths() {
  const rows = await transaction(tx => tx.all("SELECT month FROM freeport_months WHERE status = 'Sent'"));
  return new Set(rows.map(row => row.month));
}

const invoiceVersions = async (tx, month) => (await tx.all('SELECT invoice_number, version FROM freeport_invoices WHERE billing_month = ? ORDER BY invoice_number', [month]))
  .map(row => `${row.invoice_number}:${row.version}`).join(',');

export async function monthInvoiceVersions(month) {
  return transaction(tx => invoiceVersions(tx, month));
}

// Saves the package exactly as built and locks the month. `versions` is the
// invoice list the files were built from; if anything changed since, nothing
// is saved and the person tries again.
export function markMonthSent(month, { revision, packageNumber, versions, invoiceNumbers, totals, files }, actor) {
  return transaction(async tx => {
    const record = await tx.get('SELECT * FROM freeport_months WHERE month = ?', [month]);
    if (record?.status === 'Sent') throw new FreeportError(409, `${monthLabel(month)} was already marked sent.`);
    const expectedRevision = record ? Number(record.revision) : 0;
    if (expectedRevision !== revision) throw new FreeportError(409, 'This month changed while the package was being built. Try again.');
    if (await invoiceVersions(tx, month) !== versions) throw new FreeportError(409, 'An invoice changed while the package was being built. Try again.');
    const now = isoNow();
    await tx.run(
      `INSERT INTO freeport_month_sends (id, month, revision, package_number, reason, invoice_numbers, totals, consolidated_pdf, invoices_pdf, spreadsheet, sent_at, sent_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId('send'), month, revision, packageNumber, record?.correction_reason || null, JSON.stringify(invoiceNumbers), JSON.stringify(totals),
        Buffer.from(files.consolidated).toString('base64'), Buffer.from(files.invoices).toString('base64'), Buffer.from(files.spreadsheet).toString('base64'), now, actor]
    );
    if (record) await tx.run("UPDATE freeport_months SET status = 'Sent', correction_reason = NULL, updated_at = ?, updated_by = ? WHERE month = ?", [now, actor, month]);
    else await tx.run("INSERT INTO freeport_months (month, status, revision, updated_at, updated_by) VALUES (?, 'Sent', 0, ?, ?)", [month, now, actor]);
  });
}

export function startCorrection(month, reason, actor) {
  return transaction(async tx => {
    const record = await tx.get('SELECT * FROM freeport_months WHERE month = ?', [month]);
    if (record?.status !== 'Sent') throw new FreeportError(409, `${monthLabel(month)} isn't marked sent, so there's nothing to correct.`);
    await tx.run(
      "UPDATE freeport_months SET status = 'Correcting', revision = revision + 1, correction_reason = ?, updated_at = ?, updated_by = ? WHERE month = ?",
      [reason, isoNow(), actor, month]
    );
  });
}

export async function getSentFile(month, revision, file) {
  const column = SEND_FILES[file];
  if (!column) return null;
  const row = await transaction(tx => tx.get(`SELECT package_number, ${column} AS data FROM freeport_month_sends WHERE month = ? AND revision = ?`, [month, revision]));
  return row ? { packageNumber: row.package_number, bytes: Buffer.from(row.data, 'base64') } : null;
}

export function listInvoices(month) {
  return transaction(async tx => {
    const rows = await tx.all('SELECT * FROM freeport_invoices WHERE billing_month = ? ORDER BY install_date, invoice_number', [month]);
    const lines = await tx.all(
      `SELECT l.* FROM freeport_invoice_lines l JOIN freeport_invoices i ON i.id = l.invoice_id
       WHERE i.billing_month = ? ORDER BY l.invoice_id, l.position`,
      [month]
    );
    return rows.map(row => invoiceFromRow(row, lines.filter(line => line.invoice_id === row.id)));
  });
}

export function getInvoice(number) {
  return transaction(tx => readInvoice(tx, number));
}

const saveSnapshot = (tx, number, snapshot) => tx.run('UPDATE freeport_invoices SET omega_snapshot = ? WHERE invoice_number = ?', [JSON.stringify(snapshot), number]);

export async function createInvoice(invoice, actor, { omegaSnapshot } = {}) {
  try {
    return await transaction(async tx => {
      if (await tx.get('SELECT id FROM freeport_invoices WHERE invoice_number = ?', [invoice.number])) throw duplicateNumber(invoice.number);
      await assertMonthOpen(tx, invoice.billingMonth);
      await insertInvoice(tx, invoice, actor);
      if (omegaSnapshot) await saveSnapshot(tx, invoice.number, omegaSnapshot);
      return readInvoice(tx, invoice.number);
    });
  } catch (error) {
    throw isUniqueViolation(error) ? duplicateNumber(invoice.number) : error;
  }
}

export async function updateInvoice(currentNumber, expectedVersion, invoice, actor, { omegaSnapshot } = {}) {
  try {
    return await transaction(async tx => {
      const existing = await tx.get('SELECT id, billing_month FROM freeport_invoices WHERE invoice_number = ?', [currentNumber]);
      if (!existing) throw new FreeportError(404, `Invoice ${currentNumber} was not found.`);
      await assertMonthOpen(tx, existing.billing_month);
      await assertMonthOpen(tx, invoice.billingMonth);
      if (invoice.number !== currentNumber && await tx.get('SELECT id FROM freeport_invoices WHERE invoice_number = ?', [invoice.number])) {
        throw duplicateNumber(invoice.number);
      }
      const updated = await tx.run(
        `UPDATE freeport_invoices SET invoice_number = ?, omega_date = ?, install_date = ?, month_override = ?, billing_month = ?, order_number = ?,
          account_code = ?, omega_tax_cents = ?, drive_link = ?, notes = ?, status = ?, equipment_number = ?, serial_number = ?,
          version = version + 1, updated_at = ?, updated_by = ?
         WHERE id = ? AND version = ?`,
        [...invoiceColumns(invoice), isoNow(), actor, existing.id, expectedVersion]
      );
      if (!updated) throw new FreeportError(409, 'Someone else saved this invoice while you were editing. Reload to see their changes.');
      await tx.run('DELETE FROM freeport_invoice_lines WHERE invoice_id = ?', [existing.id]);
      await insertLines(tx, existing.id, invoice.lines);
      if (omegaSnapshot) await saveSnapshot(tx, invoice.number, omegaSnapshot);
      return readInvoice(tx, invoice.number);
    });
  } catch (error) {
    throw isUniqueViolation(error) ? duplicateNumber(invoice.number) : error;
  }
}

// Marks an imported invoice that Omega voided or moved off Freeport: its flag
// blocks Ready until someone deletes it or fixes it in Omega.
export function flagOmegaInvoice(number, expectedVersion, snapshot, actor) {
  return transaction(async tx => {
    await assertMonthOpen(tx, (await tx.get('SELECT billing_month FROM freeport_invoices WHERE invoice_number = ?', [number]))?.billing_month);
    const updated = await tx.run(
      `UPDATE freeport_invoices SET omega_snapshot = ?, status = 'Needs review', version = version + 1, updated_at = ?, updated_by = ?
       WHERE invoice_number = ? AND version = ?`,
      [JSON.stringify(snapshot), isoNow(), actor, number, expectedVersion]
    );
    if (!updated) throw new FreeportError(409, `Invoice ${number} changed in the app while importing. Check Omega again.`);
    return readInvoice(tx, number);
  });
}

// Records Omega's current values for an invoice saved before snapshots existed,
// without changing the invoice itself.
export function saveOmegaSnapshot(number, snapshot) {
  return transaction(async tx => {
    await assertMonthOpen(tx, (await tx.get('SELECT billing_month FROM freeport_invoices WHERE invoice_number = ?', [number]))?.billing_month);
    await saveSnapshot(tx, number, snapshot);
  });
}

export async function findInvoiceNumbers(numbers) {
  if (!numbers.length) return new Set();
  const rows = await transaction(tx => tx.all(`SELECT invoice_number FROM freeport_invoices WHERE invoice_number IN (${numbers.map(() => '?').join(', ')})`, numbers));
  return new Set(rows.map(row => row.invoice_number));
}

export function deleteInvoice(number, expectedVersion) {
  return transaction(async tx => {
    const existing = await tx.get('SELECT id, billing_month FROM freeport_invoices WHERE invoice_number = ?', [number]);
    if (!existing) throw new FreeportError(404, `Invoice ${number} was not found.`);
    await assertMonthOpen(tx, existing.billing_month);
    // The version check is part of the DELETE so a save committed meanwhile can't be lost.
    const removed = await tx.run('DELETE FROM freeport_invoices WHERE id = ? AND version = ?', [existing.id, expectedVersion]);
    if (!removed) throw new FreeportError(409, 'This invoice changed since you opened it. Reload before deleting.');
    await tx.run('DELETE FROM freeport_invoice_lines WHERE invoice_id = ?', [existing.id]);
  });
}
