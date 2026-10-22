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
    // Local databases created before these columns existed.
    const hasColumn = (table, column) => db.prepare(`SELECT COUNT(*) AS count FROM pragma_table_info('${table}') WHERE name = ?`).get(column).count > 0;
    if (!hasColumn('freeport_items', 'custom_description')) db.exec('ALTER TABLE freeport_items ADD COLUMN custom_description INTEGER NOT NULL DEFAULT 0');
    if (!hasColumn('freeport_invoice_lines', 'description')) db.exec('ALTER TABLE freeport_invoice_lines ADD COLUMN description TEXT');
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

async function readConfig(tx) {
  const settingsRow = await tx.get('SELECT data FROM freeport_settings WHERE id = ?', [SETTINGS_ID]);
  return {
    settings: { ...defaultSettings, ...(settingsRow ? JSON.parse(settingsRow.data) : {}) },
    accounts: (await tx.all('SELECT * FROM freeport_accounts ORDER BY sort_order, code')).map(accountFromRow),
    items: (await tx.all('SELECT * FROM freeport_items ORDER BY sort_order, sku')).map(itemFromRow)
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

function invoiceFromRow(row, lines) {
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
    status: row.status,
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
  invoice.orderNumber || null, invoice.accountCode || null, invoice.omegaTaxCents, invoice.driveLink || null, invoice.notes || null, invoice.status
];

async function insertInvoice(tx, invoice, actor) {
  const id = newId('invoice');
  const now = isoNow();
  await tx.run(
    `INSERT INTO freeport_invoices (invoice_number, omega_date, install_date, month_override, billing_month, order_number, account_code,
      omega_tax_cents, drive_link, notes, status, id, version, created_at, updated_at, created_by, updated_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    [...invoiceColumns(invoice), id, now, now, actor, actor]
  );
  await insertLines(tx, id, invoice.lines);
}

const duplicateNumber = number => new FreeportError(409, `Invoice ${number} already exists.`, { existing: number });

export async function listMonths() {
  const rows = await transaction(tx => tx.all(
    `SELECT billing_month, COUNT(*) AS invoice_count, SUM(CASE WHEN status = 'Ready' THEN 0 ELSE 1 END) AS needs_review
     FROM freeport_invoices GROUP BY billing_month ORDER BY billing_month DESC`
  ));
  return rows.map(row => ({ month: row.billing_month, invoices: Number(row.invoice_count), needsReview: Number(row.needs_review) }));
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

export async function createInvoice(invoice, actor) {
  try {
    return await transaction(async tx => {
      if (await tx.get('SELECT id FROM freeport_invoices WHERE invoice_number = ?', [invoice.number])) throw duplicateNumber(invoice.number);
      await insertInvoice(tx, invoice, actor);
      return readInvoice(tx, invoice.number);
    });
  } catch (error) {
    throw isUniqueViolation(error) ? duplicateNumber(invoice.number) : error;
  }
}

export async function updateInvoice(currentNumber, expectedVersion, invoice, actor) {
  try {
    return await transaction(async tx => {
      const existing = await tx.get('SELECT id FROM freeport_invoices WHERE invoice_number = ?', [currentNumber]);
      if (!existing) throw new FreeportError(404, `Invoice ${currentNumber} was not found.`);
      if (invoice.number !== currentNumber && await tx.get('SELECT id FROM freeport_invoices WHERE invoice_number = ?', [invoice.number])) {
        throw duplicateNumber(invoice.number);
      }
      const updated = await tx.run(
        `UPDATE freeport_invoices SET invoice_number = ?, omega_date = ?, install_date = ?, month_override = ?, billing_month = ?, order_number = ?,
          account_code = ?, omega_tax_cents = ?, drive_link = ?, notes = ?, status = ?, version = version + 1, updated_at = ?, updated_by = ?
         WHERE id = ? AND version = ?`,
        [...invoiceColumns(invoice), isoNow(), actor, existing.id, expectedVersion]
      );
      if (!updated) throw new FreeportError(409, 'Someone else saved this invoice while you were editing. Reload to see their changes.');
      await tx.run('DELETE FROM freeport_invoice_lines WHERE invoice_id = ?', [existing.id]);
      await insertLines(tx, existing.id, invoice.lines);
      return readInvoice(tx, invoice.number);
    });
  } catch (error) {
    throw isUniqueViolation(error) ? duplicateNumber(invoice.number) : error;
  }
}

export function deleteInvoice(number, expectedVersion) {
  return transaction(async tx => {
    const existing = await tx.get('SELECT id FROM freeport_invoices WHERE invoice_number = ?', [number]);
    if (!existing) throw new FreeportError(404, `Invoice ${number} was not found.`);
    // The version check is part of the DELETE so a save committed meanwhile can't be lost.
    const removed = await tx.run('DELETE FROM freeport_invoices WHERE id = ? AND version = ?', [existing.id, expectedVersion]);
    if (!removed) throw new FreeportError(409, 'This invoice changed since you opened it. Reload before deleting.');
    await tx.run('DELETE FROM freeport_invoice_lines WHERE invoice_id = ?', [existing.id]);
  });
}
