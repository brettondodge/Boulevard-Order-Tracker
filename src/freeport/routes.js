import express from 'express';
import { isValidMonth, summarizeMonth } from '../../public/freeport-billing.js';
import { buildSpreadsheet } from './spreadsheet.js';
import {
  FreeportError,
  normalizeAccountsInput,
  normalizeInvoiceInput,
  normalizeItemsInput,
  normalizeSettingsInput
} from './validate.js';
import {
  createInvoice,
  deleteInvoice,
  getConfig,
  getInvoice,
  listInvoices,
  listMonths,
  saveAccounts,
  saveItems,
  saveSettings,
  updateInvoice
} from './store.js';

const route = handler => (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(next);
const actor = req => req.session.user.username;

function expectedVersion(value) {
  const version = Number(value);
  if (!Number.isInteger(version) || version < 1) throw new FreeportError(400, 'Reload the invoice and try again.');
  return version;
}

export function freeportRouter({ requireStaffAuth, requireAdminAuth }) {
  const router = express.Router();
  router.use(requireStaffAuth);

  router.get('/config', route(async (req, res) => res.json(await getConfig())));

  router.put('/settings', requireAdminAuth, route(async (req, res) => {
    res.json(await saveSettings(normalizeSettingsInput(req.body), actor(req)));
  }));

  router.put('/accounts', requireAdminAuth, route(async (req, res) => {
    res.json(await saveAccounts(normalizeAccountsInput(req.body), actor(req)));
  }));

  router.put('/items', requireAdminAuth, route(async (req, res) => {
    res.json(await saveItems(normalizeItemsInput(req.body), actor(req)));
  }));

  router.get('/months', route(async (req, res) => res.json(await listMonths())));

  // Month-end line-item spreadsheet. Only built once every invoice is Ready,
  // so an incomplete file can't be sent to Freeport by accident.
  router.get('/months/:month/spreadsheet.xlsx', route(async (req, res) => {
    const { month } = req.params;
    if (!isValidMonth(month)) throw new FreeportError(400, 'Choose a month like 2026-09.');
    const [config, invoices] = await Promise.all([getConfig(), listInvoices(month)]);
    const summary = summarizeMonth(month, invoices, config);
    if (!summary.invoices.length) throw new FreeportError(409, `There are no invoices in ${month} yet.`);
    if (summary.needsReview.length) {
      throw new FreeportError(409, 'Every invoice must be Ready before downloading the spreadsheet.', { invoices: summary.needsReview.map(invoice => invoice.number) });
    }
    const buffer = await buildSpreadsheet(summary, config);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${summary.packageNumber} Line Items.xlsx"`,
      'Cache-Control': 'no-store'
    });
    res.send(Buffer.from(buffer));
  }));

  router.get('/invoices', route(async (req, res) => {
    if (!isValidMonth(req.query.month)) throw new FreeportError(400, 'Choose a month like 2026-09.');
    res.json(await listInvoices(req.query.month));
  }));

  router.get('/invoices/:number', route(async (req, res) => {
    const invoice = await getInvoice(req.params.number);
    if (!invoice) throw new FreeportError(404, `Invoice ${req.params.number} was not found.`);
    res.json(invoice);
  }));

  router.post('/invoices', route(async (req, res) => {
    const invoice = normalizeInvoiceInput(req.body, await getConfig());
    res.status(201).json(await createInvoice(invoice, actor(req)));
  }));

  router.put('/invoices/:number', route(async (req, res) => {
    const version = expectedVersion(req.body?.version);
    const invoice = normalizeInvoiceInput(req.body, await getConfig());
    res.json(await updateInvoice(req.params.number, version, invoice, actor(req)));
  }));

  router.delete('/invoices/:number', route(async (req, res) => {
    await deleteInvoice(req.params.number, expectedVersion(req.query.version));
    res.json({ deleted: req.params.number });
  }));

  // Validation and conflict messages are written for staff; anything else
  // falls through to the app's generic error handler.
  router.use((error, req, res, next) => {
    if (!(error instanceof FreeportError)) return next(error);
    res.status(error.status).json({ error: error.message, ...error.details });
  });

  return router;
}
