import express from 'express';
import { isValidMonth, summarizeMonth } from '../../public/freeport-billing.js';
import { buildSpreadsheet, spreadsheetSheetName as monthLabel } from './spreadsheet.js';
import { buildConsolidatedInvoice, buildInvoicePages } from './pdf.js';
import { applyImport, monthCheck, omegaConnected, previewImport } from './omega.js';
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
  getMonthStatus,
  getSentFile,
  markMonthSent,
  monthInvoiceVersions,
  startCorrection,
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

  // Every config response says whether Omega is connected, so the browser knows
  // whether to offer the import.
  const withOmega = config => ({ ...config, omegaConnected: omegaConnected() });

  router.get('/config', route(async (req, res) => res.json(withOmega(await getConfig()))));

  router.put('/settings', requireAdminAuth, route(async (req, res) => {
    res.json(withOmega(await saveSettings(normalizeSettingsInput(req.body), actor(req))));
  }));

  router.put('/accounts', requireAdminAuth, route(async (req, res) => {
    res.json(withOmega(await saveAccounts(normalizeAccountsInput(req.body), actor(req))));
  }));

  router.put('/items', requireAdminAuth, route(async (req, res) => {
    res.json(withOmega(await saveItems(normalizeItemsInput(req.body), actor(req))));
  }));

  router.get('/months', route(async (req, res) => res.json(await listMonths())));

  // Omega import: preview first, then import the invoices the person saw.
  router.post('/omega/preview', route(async (req, res) => {
    res.json(await previewImport({ from: req.body?.from, to: req.body?.to }, await getConfig()));
  }));

  router.post('/omega/import', route(async (req, res) => {
    res.json(await applyImport({ from: req.body?.from, to: req.body?.to, numbers: req.body?.numbers }, await getConfig(), actor(req)));
  }));

  router.get('/omega/month-check', route(async (req, res) => {
    if (!isValidMonth(req.query.month)) throw new FreeportError(400, 'Choose a month like 2026-09.');
    res.json(await monthCheck(req.query.month, await getConfig()));
  }));

  // Month-end files are only built once every invoice is Ready, so an
  // incomplete package can't be sent to Freeport by accident.
  async function readyMonth(month) {
    if (!isValidMonth(month)) throw new FreeportError(400, 'Choose a month like 2026-09.');
    const [config, invoices, status] = await Promise.all([getConfig(), listInvoices(month), getMonthStatus(month)]);
    const summary = summarizeMonth(month, invoices, config, status.revision);
    if (!summary.invoices.length) throw new FreeportError(409, `There are no invoices in ${month} yet.`);
    if (summary.needsReview.length) {
      throw new FreeportError(409, 'Every invoice must be Ready before downloading month-end files.', { invoices: summary.needsReview.map(invoice => invoice.number) });
    }
    return { config, summary, status };
  }

  function sendDownload(res, bytes, contentType, filename) {
    res.set({ 'Content-Type': contentType, 'Content-Disposition': `attachment; filename="${filename}"`, 'Cache-Control': 'no-store' });
    res.send(Buffer.from(bytes));
  }

  const downloads = [
    ['spreadsheet.xlsx', buildSpreadsheet, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Line Items.xlsx'],
    ['consolidated-invoice.pdf', buildConsolidatedInvoice, 'application/pdf', 'Consolidated Invoice.pdf'],
    ['invoices.pdf', buildInvoicePages, 'application/pdf', 'Invoices.pdf']
  ];
  const DOWNLOADS = Object.fromEntries(downloads.map(([file, , contentType, suffix]) => [file, { contentType, suffix }]));

  // A sent month always downloads the exact files that were sent.
  async function sendSaved(res, month, revision, file) {
    const saved = await getSentFile(month, revision, file);
    if (!saved) throw new FreeportError(404, 'That sent file was not found.');
    sendDownload(res, saved.bytes, DOWNLOADS[file].contentType, `${saved.packageNumber} ${DOWNLOADS[file].suffix}`);
  }

  for (const [file, build, contentType, suffix] of downloads) {
    router.get(`/months/:month/${file}`, route(async (req, res) => {
      const status = isValidMonth(req.params.month) ? await getMonthStatus(req.params.month) : null;
      if (status?.status === 'Sent') return sendSaved(res, req.params.month, status.revision, file);
      const { config, summary } = await readyMonth(req.params.month);
      sendDownload(res, await build(summary, config), contentType, `${summary.packageNumber} ${suffix}`);
    }));
  }

  router.get('/months/:month/sends/:revision/:file', route(async (req, res) => {
    const revision = Number(req.params.revision);
    if (!isValidMonth(req.params.month) || !Number.isInteger(revision) || revision < 0 || !DOWNLOADS[req.params.file]) throw new FreeportError(404, 'That sent file was not found.');
    await sendSaved(res, req.params.month, revision, req.params.file);
  }));

  router.get('/months/:month/status', route(async (req, res) => {
    if (!isValidMonth(req.params.month)) throw new FreeportError(400, 'Choose a month like 2026-09.');
    res.json(await getMonthStatus(req.params.month));
  }));

  // Mark sent: builds the package from Ready invoices, keeps an exact copy of
  // the three files, and locks the month.
  router.post('/months/:month/send', route(async (req, res) => {
    const month = req.params.month;
    const { config, summary, status } = await readyMonth(month);
    if (status.status === 'Sent') throw new FreeportError(409, `${monthLabel(month)} was already marked sent.`);
    const versions = await monthInvoiceVersions(month);
    const [consolidated, invoices, spreadsheet] = await Promise.all([
      buildConsolidatedInvoice(summary, config), buildInvoicePages(summary, config), buildSpreadsheet(summary, config)
    ]);
    await markMonthSent(month, {
      revision: status.revision,
      packageNumber: summary.packageNumber,
      versions,
      invoiceNumbers: summary.invoices.map(invoice => invoice.number),
      totals: { invoices: summary.invoices.length, partsCents: summary.parts, laborCents: summary.labor, taxCents: summary.tax, totalCents: summary.total },
      files: { consolidated, invoices, spreadsheet }
    }, actor(req));
    res.json(await getMonthStatus(month));
  }));

  router.post('/months/:month/correction', route(async (req, res) => {
    const month = req.params.month;
    if (!isValidMonth(month)) throw new FreeportError(400, 'Choose a month like 2026-09.');
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (!reason) throw new FreeportError(400, 'Say why the package needs a correction.');
    if (reason.length > 500) throw new FreeportError(400, 'Keep the reason to 500 characters or fewer.');
    await startCorrection(month, reason, actor(req));
    res.json(await getMonthStatus(month));
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
    const invoice = normalizeInvoiceInput(req.body, await getConfig(), await getInvoice(req.params.number));
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
