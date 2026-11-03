import express from 'express';
import { randomUUID } from 'node:crypto';
import { dbAll, dbGet, dbRun } from './db.js';
import { isoNow, todayPhoenixString } from './utils.js';
import { omegaConnected, scheduledParts } from './freeport/omega.js';
import { FreeportError } from './freeport/validate.js';
import {
  MAX_QUANTITY, SECTIONS, addInventory, checkStatus, deleteInventory, inventoryCsv, listInventory, runInventoryCheck, updateInventory
} from './autoglass-inventory.js';

const route = handler => (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(next);
const actor = req => req.session.user.username;
const MAX_PART_LENGTH = 80;

const serialize = row => ({
  id: row.id,
  part_number: row.part_number,
  need: Boolean(Number(row.need)),
  to_return: Boolean(Number(row.to_return)),
  scanned_at: row.scanned_at,
  scanned_by: row.scanned_by || ''
});

// The current list is everything scanned since the last Clear list, oldest first.
export function autoglassRouter({ requireStaffAuth }) {
  const router = express.Router();
  router.use(requireStaffAuth);

  router.get('/scans', route(async (req, res) => {
    const rows = await dbAll('SELECT * FROM autoglass_scans WHERE cleared_at IS NULL ORDER BY scanned_at, id');
    res.json({ scans: rows.map(serialize), omegaConnected: omegaConnected() });
  }));

  router.post('/scans', route(async (req, res) => {
    const part = partNumberFrom(req, res);
    if (!part) return;
    const id = randomUUID();
    const now = isoNow();
    await dbRun(
      'INSERT INTO autoglass_scans (id, part_number, need, to_return, scanned_at, scanned_by, updated_at, updated_by) VALUES (?, ?, 0, 0, ?, ?, ?, ?)',
      [id, part, now, actor(req), now, actor(req)]
    );
    res.status(201).json({ scan: serialize(await dbGet('SELECT * FROM autoglass_scans WHERE id = ?', [id])) });
  }));

  // Need and Return: one or neither.
  router.put('/scans/:id', route(async (req, res) => {
    const need = req.body.need === true;
    const toReturn = req.body.to_return === true;
    if (need && toReturn) return res.status(400).json({ error: 'A part is either needed or going back, not both.' });
    const result = await dbRun(
      'UPDATE autoglass_scans SET need = ?, to_return = ?, updated_at = ?, updated_by = ? WHERE id = ? AND cleared_at IS NULL',
      [need ? 1 : 0, toReturn ? 1 : 0, isoNow(), actor(req), req.params.id]
    );
    if (!result.changes) return res.status(404).json({ error: 'That scan is no longer on the list. Reload the page.' });
    res.json({ scan: serialize(await dbGet('SELECT * FROM autoglass_scans WHERE id = ?', [req.params.id])) });
  }));

  router.delete('/scans/:id', route(async (req, res) => {
    const result = await dbRun('DELETE FROM autoglass_scans WHERE id = ? AND cleared_at IS NULL', [req.params.id]);
    if (!result.changes) return res.status(404).json({ error: 'That scan is no longer on the list. Reload the page.' });
    res.json({ deleted: true });
  }));

  // Starts a new list. Cleared scans stay in the database.
  router.post('/clear', route(async (req, res) => {
    const now = isoNow();
    const result = await dbRun('UPDATE autoglass_scans SET cleared_at = ?, updated_at = ?, updated_by = ? WHERE cleared_at IS NULL', [now, now, actor(req)]);
    res.json({ cleared: result.changes });
  }));

  router.get('/schedule', route(async (req, res) => {
    if (!omegaConnected()) return res.json({ connected: false });
    const from = String(req.query.from || '');
    const to = String(req.query.to || '');
    try {
      res.json({ connected: true, from, to, ...(await scheduledParts(from, to)) });
    } catch (error) {
      if (error instanceof FreeportError) return res.status(error.status).json({ error: error.message });
      throw error;
    }
  }));

  // Stock and Old inventory.
  router.get('/inventory', route(async (req, res) => res.json({ items: await listInventory(), check: await checkStatus() })));

  router.post('/inventory', route(async (req, res) => {
    if (!SECTIONS[req.body.section]) return res.status(400).json({ error: 'Choose Stock or Old inventory.' });
    const part = partNumberFrom(req, res);
    if (!part) return;
    const item = await addInventory(req.body.section, part, actor(req));
    res.status(item.added ? 201 : 200).json({ item });
  }));

  router.put('/inventory/:id', route(async (req, res) => {
    const quantity = Number(req.body.quantity);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) return res.status(400).json({ error: `Quantity is a whole number from 1 to ${MAX_QUANTITY}.` });
    const shelf = typeof req.body.shelf === 'string' ? req.body.shelf.trim().slice(0, 40) : '';
    if (!(await updateInventory(req.params.id, { quantity, shelf }, actor(req)))) return res.status(404).json({ error: 'That part is no longer in inventory. Reload the page.' });
    res.json({ updated: true });
  }));

  router.delete('/inventory/:id', route(async (req, res) => {
    if (!(await deleteInventory(req.params.id))) return res.status(404).json({ error: 'That part is no longer in inventory. Reload the page.' });
    res.json({ deleted: true });
  }));

  router.get('/inventory.csv', route(async (req, res) => {
    const section = String(req.query.section || '');
    if (!SECTIONS[section]) return res.status(400).json({ error: 'Choose Stock or Old inventory.' });
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="autoglass-${section}-${todayPhoenixString()}.csv"`);
    res.send(await inventoryCsv(section));
  }));

  router.post('/inventory/check', route(async (req, res) => {
    if (!omegaConnected()) return res.status(503).json({ error: "Omega isn't connected, so inventory can't be checked." });
    try {
      res.json({ result: await runInventoryCheck() });
    } catch (error) {
      if (error instanceof FreeportError) return res.status(error.status).json({ error: error.message });
      throw error;
    }
  }));

  return router;
}

// A scanned or typed part number, or '' after answering with what's wrong.
function partNumberFrom(req, res) {
  const part = typeof req.body.part_number === 'string' ? req.body.part_number.trim().replace(/\s+/g, ' ') : '';
  if (!part) res.status(400).json({ error: 'Scan or type a part number.' });
  else if (part.length > MAX_PART_LENGTH) res.status(400).json({ error: `That's longer than a part number (${MAX_PART_LENGTH} characters at most).` });
  else return part;
  return '';
}
