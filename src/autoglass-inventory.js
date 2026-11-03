import { randomUUID } from 'node:crypto';
import { dbAll, dbGet, dbRun } from './db.js';
import { isoNow, todayPhoenixString } from './utils.js';
import { omegaConnected, openJobParts } from './freeport/omega.js';
import { alertEmailConfigured, sendAlertEmail } from './email.js';
import { glassNumber, partKey, scheduleMatches } from '../public/autoglass-match.js';

// Stock: parts kept on hand. Old inventory: leftovers to use up.
export const SECTIONS = { stock: 'Stock', old: 'Old inventory' };
export const MAX_QUANTITY = 999;
const APP_URL = 'https://tools.blvdglass.com';

const getState = async name => (await dbGet('SELECT value FROM autoglass_state WHERE name = ?', [name]))?.value ?? null;
const setState = (name, value) => dbRun('INSERT INTO autoglass_state (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value', [name, value]);

const serializeMatch = row => ({
  job_number: row.job_number,
  status: row.job_status || '',
  part: row.part || '',
  vehicle: row.vehicle || '',
  written_up: row.written_up || '',
  scheduled_date: row.scheduled_date || '',
  emailed: Boolean(row.emailed_at)
});

// In scan order, each with the open Omega jobs that need it as of the last check.
export async function listInventory() {
  const [items, matches] = await Promise.all([
    dbAll('SELECT * FROM autoglass_inventory ORDER BY created_at, id'),
    dbAll('SELECT * FROM autoglass_matches ORDER BY written_up, job_number')
  ]);
  const matchesByItem = Map.groupBy(matches, row => row.item_id);
  return items.map(item => ({
    id: item.id,
    section: item.section,
    part_number: item.part_number,
    glass_number: glassNumber(item.part_number),
    quantity: Number(item.quantity),
    shelf: item.shelf || '',
    matches: (matchesByItem.get(item.id) || []).map(serializeMatch)
  }));
}

// A part already in the section gets one more; a new part starts at one.
export async function addInventory(section, partNumber, actor) {
  const id = randomUUID();
  const key = partKey(partNumber);
  const now = isoNow();
  await dbRun(`
    INSERT INTO autoglass_inventory (id, section, part_number, part_key, quantity, shelf, created_at, created_by, updated_at, updated_by)
    VALUES (?, ?, ?, ?, 1, '', ?, ?, ?, ?)
    ON CONFLICT (section, part_key) DO UPDATE SET quantity = autoglass_inventory.quantity + 1, updated_at = excluded.updated_at, updated_by = excluded.updated_by
  `, [id, section, partNumber, key, now, actor, now, actor]);
  const item = await dbGet('SELECT id, quantity FROM autoglass_inventory WHERE section = ? AND part_key = ?', [section, key]);
  return { id: item.id, quantity: Number(item.quantity), added: item.id === id };
}

// Quantity and shelf, and the part number when one is given. A new part
// number drops the line's Omega matches (they were for the old one) until the
// next check. A part number already in the section is combined into that
// line, quantities added, only when asked (combine); otherwise that line is
// returned as existing.
export async function updateInventory(id, { quantity, shelf, partNumber, combine = false }, actor) {
  const item = await dbGet('SELECT * FROM autoglass_inventory WHERE id = ?', [id]);
  if (!item) return { missing: true };
  const key = partNumber ? partKey(partNumber) : item.part_key;
  const now = isoNow();
  if (key !== item.part_key) {
    const other = await dbGet('SELECT * FROM autoglass_inventory WHERE section = ? AND part_key = ?', [item.section, key]);
    if (other && !combine) return { existing: { id: other.id, part_number: other.part_number, quantity: Number(other.quantity) } };
    if (other) {
      await dbRun(
        'UPDATE autoglass_inventory SET quantity = ?, shelf = ?, updated_at = ?, updated_by = ? WHERE id = ?',
        [Math.min(Number(other.quantity) + quantity, MAX_QUANTITY), other.shelf || shelf, now, actor, other.id]
      );
      await deleteInventory(id);
      return { combined: other.id };
    }
    await dbRun('DELETE FROM autoglass_matches WHERE item_id = ?', [id]);
  }
  await dbRun(
    'UPDATE autoglass_inventory SET part_number = ?, part_key = ?, quantity = ?, shelf = ?, updated_at = ?, updated_by = ? WHERE id = ?',
    [partNumber || item.part_number, key, quantity, shelf, now, actor, id]
  );
  return { updated: true };
}

export async function deleteInventory(id) {
  await dbRun('DELETE FROM autoglass_matches WHERE item_id = ?', [id]);
  return (await dbRun('DELETE FROM autoglass_inventory WHERE id = ?', [id])).changes > 0;
}

const csvCell = value => (/[",\n]/.test(String(value)) ? `"${String(value).replace(/"/g, '""')}"` : String(value));
const jobLabel = match => `${match.status || 'Job'} #${match.job_number}`;

// One section as a spreadsheet, sorted by part number.
export async function inventoryCsv(section) {
  const items = (await listInventory()).filter(item => item.section === section).sort((a, b) => partKey(a.part_number).localeCompare(partKey(b.part_number)));
  const rows = [['Part number', 'NAGS number', 'Quantity', 'Shelf', 'Open Omega jobs that need it']]
    .concat(items.map(item => [item.part_number, item.glass_number, item.quantity, item.shelf, item.matches.map(jobLabel).join('; ')]));
  return `${rows.map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

const shortDate = day => (day ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`)) : '');

// rows: matches joined with their inventory part (job_status, not status).
export function oldInventoryEmail(rows) {
  const label = row => jobLabel({ ...row, status: row.job_status });
  const lines = rows.map(row => {
    const on = [
      `${label(row)}${row.vehicle ? ` · ${row.vehicle}` : ''}`,
      row.written_up ? `written up ${shortDate(row.written_up)}` : '',
      row.scheduled_date ? `scheduled ${shortDate(row.scheduled_date)}` : ''
    ].filter(Boolean).join(' · ');
    const have = [row.shelf ? `shelf ${row.shelf}` : '', `${row.quantity} on hand`].filter(Boolean).join(', ');
    const version = partKey(row.part_number).includes(partKey(row.part)) ? '' : `\n  Omega lists ${row.part}: check the version letters before using it.`;
    return `- ${row.part_number} (${have}) fits ${on}${version}`;
  });
  const first = rows[0];
  return {
    subject: rows.length === 1
      ? `Old inventory match: ${glassNumber(first.part_number) || first.part_number} for ${label(first)}`
      : `${rows.length} old inventory matches`,
    text: `Old inventory parts that fit open Omega jobs:\n\n${lines.join('\n')}\n\nOld inventory: ${APP_URL}/autoglass#old\n`
  };
}

let running = null;

// Matches every inventory part against open Omega quotes and work orders,
// keeps the current matches, and emails old-inventory matches not sent before.
// A check already running is shared rather than started twice.
export function runInventoryCheck({ today = todayPhoenixString() } = {}) {
  running ||= checkNow(today).finally(() => { running = null; });
  return running;
}

async function checkNow(today) {
  const checkedAt = isoNow();
  try {
    const { jobs } = await openJobParts(today);
    const current = new Set();
    for (const item of await dbAll('SELECT id, part_number FROM autoglass_inventory')) {
      for (const job of scheduleMatches(item.part_number, jobs)) {
        current.add(`${item.id} ${job.number}`);
        await dbRun(`
          INSERT INTO autoglass_matches (item_id, job_number, job_status, part, vehicle, written_up, scheduled_date, found_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (item_id, job_number) DO UPDATE SET job_status = excluded.job_status, part = excluded.part, vehicle = excluded.vehicle,
            written_up = excluded.written_up, scheduled_date = excluded.scheduled_date
        `, [item.id, job.number, job.status, job.part, job.vehicle, job.writtenUp, job.scheduledDate, checkedAt]);
      }
    }
    // Jobs no longer open (invoiced, voided, or older than the search) drop off.
    for (const row of await dbAll('SELECT item_id, job_number FROM autoglass_matches')) {
      if (!current.has(`${row.item_id} ${row.job_number}`)) await dbRun('DELETE FROM autoglass_matches WHERE item_id = ? AND job_number = ?', [row.item_id, row.job_number]);
    }

    const unsent = await dbAll(`
      SELECT m.*, i.part_number, i.shelf, i.quantity FROM autoglass_matches m JOIN autoglass_inventory i ON i.id = m.item_id
      WHERE i.section = 'old' AND m.emailed_at IS NULL ORDER BY m.written_up, m.job_number
    `);
    let emailed = 0;
    let emailError = '';
    if (unsent.length && alertEmailConfigured()) {
      try {
        await sendAlertEmail(oldInventoryEmail(unsent));
        for (const row of unsent) await dbRun('UPDATE autoglass_matches SET emailed_at = ? WHERE item_id = ? AND job_number = ?', [isoNow(), row.item_id, row.job_number]);
        emailed = unsent.length;
      } catch (error) {
        emailError = error.message;
      }
    }
    const result = { checkedAt, jobs: jobs.length, matches: current.size, waiting: unsent.length - emailed, emailed, emailError, error: '' };
    await setState('last_check', JSON.stringify(result));
    return result;
  } catch (error) {
    await setState('last_check', JSON.stringify({ checkedAt, error: error.message }));
    throw error;
  }
}

export async function checkStatus() {
  let last = null;
  try { last = JSON.parse((await getState('last_check')) || 'null'); } catch {}
  return { omegaConnected: omegaConnected(), emailConfigured: alertEmailConfigured(), checkHour: checkHour(), last };
}

const checkHour = () => Number(process.env.AUTOGLASS_CHECK_HOUR ?? 7);
const phoenixHour = () => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Phoenix', hour: 'numeric', hourCycle: 'h23' }).format(new Date()));

// Claims today's check, so two servers (or a restart) still run it once.
async function claimDay(today) {
  await dbRun("INSERT INTO autoglass_state (name, value) VALUES ('daily_check_day', '') ON CONFLICT (name) DO NOTHING");
  return (await dbRun("UPDATE autoglass_state SET value = ? WHERE name = 'daily_check_day' AND value <> ?", [today, today])).changes === 1;
}

// Once a day at 7 AM Arizona time, or the first chance after (a restart or
// deploy over that hour just runs it later). A failed check is tried again on
// the next tick.
export function startDailyInventoryCheck() {
  const everySeconds = Number(process.env.AUTOGLASS_CHECK_SECONDS ?? 600);
  const tick = async () => {
    if (!omegaConnected() || phoenixHour() < checkHour()) return;
    const today = todayPhoenixString();
    try {
      if (!(await claimDay(today))) return;
      await runInventoryCheck({ today });
    } catch (error) {
      console.error('Autoglass inventory check failed:', error.message);
      await dbRun("UPDATE autoglass_state SET value = '' WHERE name = 'daily_check_day' AND value = ?", [today]).catch(() => {});
    }
  };
  setTimeout(tick, Math.min(30, everySeconds) * 1000).unref();
  setInterval(tick, everySeconds * 1000).unref();
}
