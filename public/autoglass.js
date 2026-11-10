import { matchesSearch, partKey, scheduleMatches, unscannedGlass } from './autoglass-match.js';

const $ = id => document.getElementById(id);
const RECEIVING_INTRO = "Scan each part's barcode; the next line is ready right away. Tick <strong>Need</strong> to keep a part (green) or <strong>Return</strong> to send it back (red).";
// Receiving has a list per supplier (PLK, PGW); supplier is set on those tabs only.
const TABS = {
  plk: { supplier: 'plk', label: 'PLK', title: 'PLK receiving', intro: RECEIVING_INTRO, placeholder: 'Scan the next PLK part' },
  pgw: { supplier: 'pgw', label: 'PGW', title: 'PGW receiving', intro: RECEIVING_INTRO, placeholder: 'Scan the next PGW part' },
  stock: {
    label: 'Stock',
    title: 'Stock',
    intro: 'Parts kept on hand. Scan a part to add it; scanning the same part again adds one more.',
    placeholder: 'Scan a part into Stock'
  },
  old: {
    label: 'Old inventory',
    title: 'Old inventory',
    intro: "Leftover parts to use up. Scan a part to add it; scanning the same part again adds one more. When an Omega job needs one, you're emailed.",
    placeholder: 'Scan a part into Old inventory'
  }
};
const state = {
  tab: 'plk',
  receiving: 'plk', // the receiving list open last, where the Receiving tab goes
  scans: [], // both receiving lists
  search: { plk: '', pgw: '', stock: '', old: '' },
  inventory: [],
  check: null, // the Omega check's settings and last result
  pending: [], // part numbers scanned and still being saved, in order
  editing: null, // { id, part, supplier } while a line's part number is being edited
  schedule: null // { jobs, from, to } once Omega has been checked
};
let saving = Promise.resolve();

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const phoenixDay = (offsetDays = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix' }).format(new Date(Date.now() + offsetDays * 86400000));
const shortDate = day => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`));
const dateTime = iso => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Phoenix' }).format(new Date(iso));
const jobText = job => [`WO #${job.number}`, shortDate(job.scheduledDate), job.vehicle].filter(Boolean).join(' · ');
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;
// When Omega lists another version of the glass, say which, so it can be checked.
const versionNote = (scanned, part) => (partKey(scanned).includes(partKey(part)) ? '' : ` (Omega: ${esc(part)})`);

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(`/api/autoglass${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined
  });
  if (response.status === 401) {
    location.href = '/login?next=%2Fautoglass';
    throw new Error('Sign in again.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || 'Something went wrong. Try again.'), { status: response.status, data });
  return data;
}

function showMessage(text) {
  $('scanMessage').textContent = text;
}

// The scan box always gets the next key press, so a scan never lands in a
// checkbox. It doesn't scroll the page there (ticking Need or Return low in a
// long list stays put), except when a scan starts while focus is elsewhere.
function focusScan({ scroll = false } = {}) {
  $('scanInput').focus({ preventScroll: !scroll });
}

const listScans = supplier => state.scans.filter(scan => scan.supplier === supplier);
const searchText = () => state.search[state.tab].trim();

// The part number opens the line's edit box.
const partButton = line => `<button type="button" class="part-button" data-edit aria-label="Edit ${esc(line.part_number)}"><strong>${esc(line.part_number)}</strong><span class="edit-hint">Edit</span></button>`;

// A line being edited: the part number, and for receiving the list it's on.
function editRow(number) {
  const { id, part, supplier, saving } = state.editing;
  const lists = supplier ? `<select data-edit-supplier aria-label="List">${['plk', 'pgw'].map(key => `<option value="${key}" ${key === supplier ? 'selected' : ''}>${TABS[key].label}</option>`).join('')}</select>` : '';
  return `
    <li class="scan-row editing" data-id="${esc(id)}">
      <span class="scan-number">${number}</span>
      <div class="scan-edit">
        <input type="text" data-edit-part value="${esc(part)}" maxlength="80" aria-label="Part number" autocomplete="off" autocapitalize="characters" spellcheck="false" enterkeyhint="done">
        ${lists}
        <button type="button" class="primary" data-edit-save ${saving ? 'disabled' : ''}>Save</button>
        <button type="button" data-edit-cancel>Cancel</button>
      </div>
    </li>`;
}

// The band at the top of the list: its name, its counts, and how many lines
// the search shows.
function showSummary(counts, shown, total) {
  const search = searchText();
  $('scanSummary').textContent = `${TABS[state.tab].label} · ${counts}${search && total ? ` · ${shown} of ${total} match “${search}”` : ''}`;
  $('noResults').hidden = !(search && total && !shown);
  $('noResults').textContent = `Nothing on this list matches “${search}”.`;
}

function render() {
  const editFocused = document.activeElement?.matches?.('[data-edit-part]');
  const { supplier } = TABS[state.tab];
  const receiving = Boolean(supplier);
  document.querySelectorAll('[data-tab]').forEach(link => link.setAttribute('aria-current', String(link.dataset.tab === state.tab || (link.dataset.tab === 'receiving' && receiving))));
  document.querySelector('[data-tab="receiving"]').href = `#${state.receiving}`;
  document.querySelectorAll('[data-count]').forEach(count => { count.textContent = listScans(count.dataset.count).length || ''; });
  $('supplierTabs').hidden = !receiving;
  $('scanSheet').classList.toggle('plk', supplier === 'plk');
  $('scanSheet').classList.toggle('pgw', supplier === 'pgw');
  $('tabIntro').innerHTML = TABS[state.tab].intro;
  $('scanInput').placeholder = TABS[state.tab].placeholder;
  if ($('searchInput').value !== state.search[state.tab]) $('searchInput').value = state.search[state.tab];
  $('searchInput').placeholder = `Search ${TABS[state.tab].title}`;
  $('clearScans').hidden = !receiving;
  $('downloadInventory').hidden = receiving;
  $('downloadInventory').href = `/api/autoglass/inventory.csv?section=${state.tab}`;
  $('schedulePanel').hidden = !receiving;
  $('checkPanel').hidden = receiving;
  if (receiving) renderScans();
  else renderInventory();
  if (editFocused) focusEdit();
}

// ---------- Receiving ----------

const scheduleJobs = scan => (state.schedule ? scheduleMatches(scan.part_number, state.schedule.jobs) : []);

// What a search looks in: the part, Need or Return, and the jobs it's on.
const scanTexts = scan => [
  scan.part_number, scan.need ? 'need' : '', scan.to_return ? 'return' : '',
  ...scheduleJobs(scan).flatMap(job => [`WO #${job.number}`, job.vehicle, job.part])
];

function matchHtml(scan) {
  if (!state.schedule) return '';
  const jobs = scheduleJobs(scan);
  if (!jobs.length) return `<span class="match none">Not on the Omega schedule (${esc(shortDate(state.schedule.from))} – ${esc(shortDate(state.schedule.to))})</span>`;
  return `<span class="match on">On ${jobs.map(job => esc(jobText(job)) + versionNote(scan.part_number, job.part)).join('; ')}</span>`;
}

const pendingRows = (count) => state.pending.map((part, index) => `
    <li class="scan-row saving">
      <span class="scan-number">${count + index + 1}</span>
      <div class="scan-part"><strong>${esc(part)}</strong><span class="match">Saving…</span></div>
    </li>`).join('');

// Lines keep their number in the whole list while a search hides others.
const shownScans = () => listScans(TABS[state.tab].supplier)
  .map((scan, index) => ({ scan, number: index + 1 }))
  .filter(({ scan }) => scan.id === state.editing?.id || matchesSearch(searchText(), scanTexts(scan)));

function renderScans() {
  const scans = listScans(TABS[state.tab].supplier);
  const need = scans.filter(scan => scan.need).length;
  const back = scans.filter(scan => scan.to_return).length;
  const shown = shownScans();
  showSummary(scans.length ? `${scans.length} scanned · ${need} need · ${back} return · ${scans.length - need - back} not marked` : 'Nothing scanned yet.', shown.length, scans.length);
  $('clearScans').disabled = !scans.length;
  $('scanRows').innerHTML = shown.map(({ scan, number }) => (scan.id === state.editing?.id ? editRow(number) : `
    <li class="scan-row ${scan.need ? 'need' : scan.to_return ? 'return' : ''}" data-id="${esc(scan.id)}">
      <span class="scan-number">${number}</span>
      <div class="scan-part">${partButton(scan)}${matchHtml(scan)}</div>
      <label class="scan-box ${scan.need ? 'on' : ''}"><input type="checkbox" data-mark="need" ${scan.need ? 'checked' : ''}> Need</label>
      <label class="scan-box ${scan.to_return ? 'on' : ''}"><input type="checkbox" data-mark="to_return" ${scan.to_return ? 'checked' : ''}> Return</label>
      <button type="button" class="scan-remove" data-remove aria-label="Remove ${esc(scan.part_number)}">×</button>
    </li>`)).join('') + pendingRows(scans.length);
  $('nextNumber').textContent = scans.length + state.pending.length + 1;
  renderUnscanned();
}

function renderUnscanned() {
  const list = $('unscanned');
  if (!state.schedule) {
    list.innerHTML = '';
    return;
  }
  const missing = unscannedGlass(state.schedule.jobs, state.scans.map(scan => scan.part_number));
  const jobs = state.schedule.jobs.length;
  $('scheduleStatus').textContent = `${plural(jobs, 'work order', 'work orders')} scheduled ${shortDate(state.schedule.from)} – ${shortDate(state.schedule.to)}. `
    + (missing.length ? `Glass on them not scanned into PLK or PGW yet: ${missing.length}.` : 'All their glass has been scanned.');
  list.innerHTML = missing.map(job => `<li><strong>${esc(job.glass)}</strong> · ${esc(jobText(job))}</li>`).join('');
}

async function mark(id, field, checked) {
  const scan = state.scans.find(entry => entry.id === id);
  if (!scan) return;
  const before = { need: scan.need, to_return: scan.to_return };
  // Need and Return are one or the other.
  const next = field === 'need' ? { need: checked, to_return: checked ? false : scan.to_return } : { to_return: checked, need: checked ? false : scan.need };
  Object.assign(scan, next);
  render();
  focusScan();
  try {
    Object.assign(scan, (await api(`/scans/${encodeURIComponent(id)}`, { method: 'PUT', body: next })).scan);
  } catch (error) {
    Object.assign(scan, before);
    showMessage(error.message);
  }
  render();
}

async function clearList() {
  const { supplier, label } = TABS[state.tab];
  const count = listScans(supplier).length;
  if (!count || !confirm(`Clear all ${count} ${label} scans and start a new ${label} list?`)) return;
  try {
    await api('/clear', { method: 'POST', body: { supplier } });
    state.scans = state.scans.filter(scan => scan.supplier !== supplier);
    state.search[state.tab] = '';
    showMessage('');
  } catch (error) {
    showMessage(error.message);
  }
  render();
  focusScan();
}

async function checkSchedule() {
  const from = $('scheduleFrom').value;
  const to = $('scheduleTo').value;
  const button = $('checkSchedule');
  button.disabled = true;
  $('scheduleStatus').textContent = 'Checking Omega…';
  try {
    const data = await api(`/schedule?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    if (!data.connected) {
      state.schedule = null;
      $('scheduleStatus').textContent = "Omega isn't connected, so scans aren't checked against the schedule.";
      button.hidden = true;
    } else {
      state.schedule = { jobs: data.jobs, from: data.from, to: data.to };
    }
  } catch (error) {
    $('scheduleStatus').textContent = error.message;
  } finally {
    button.disabled = false;
  }
  render();
}

// ---------- Stock and Old inventory ----------

const itemTexts = item => [
  item.part_number, item.shelf,
  ...item.matches.flatMap(match => [`${match.status || 'Job'} #${match.job_number}`, match.vehicle, match.part])
];

const matchText = (item, match) => [
  `${match.status || 'Job'} #${match.job_number}`,
  match.scheduled_date ? `scheduled ${shortDate(match.scheduled_date)}` : '',
  match.vehicle
].filter(Boolean).map(esc).join(' · ') + versionNote(item.part_number, match.part);

function inventoryMatches(item) {
  if (!item.matches.length) return '';
  return `<span class="match on">Needed by ${item.matches.map(match => matchText(item, match) + (match.emailed ? ' · emailed' : '')).join('; ')}</span>`;
}

const listItems = () => state.inventory.filter(item => item.section === state.tab);
const shownItems = () => listItems()
  .map((item, index) => ({ item, number: index + 1 }))
  .filter(({ item }) => item.id === state.editing?.id || matchesSearch(searchText(), itemTexts(item)));

function renderInventory() {
  const items = listItems();
  const total = items.reduce((sum, item) => sum + item.quantity, 0);
  const matched = items.filter(item => item.matches.length).length;
  const shown = shownItems();
  showSummary(items.length
    ? `${plural(items.length, 'part number', 'part numbers')} · ${total} on hand${state.check?.last ? ` · ${matched} needed by open Omega jobs` : ''}`
    : 'Nothing here yet.', shown.length, items.length);
  $('scanRows').innerHTML = shown.map(({ item, number }) => (item.id === state.editing?.id ? editRow(number) : `
    <li class="scan-row inventory-row ${item.matches.length ? 'matched' : ''}" data-id="${esc(item.id)}">
      <span class="scan-number">${number}</span>
      <div class="scan-part">${partButton(item)}${inventoryMatches(item)}</div>
      <div class="quantity" role="group" aria-label="Quantity of ${esc(item.part_number)}">
        <button type="button" data-quantity="-1" aria-label="One less">−</button>
        <span>${item.quantity}</span>
        <button type="button" data-quantity="1" aria-label="One more">+</button>
      </div>
      <label class="shelf">Shelf<input type="text" data-shelf value="${esc(item.shelf)}" maxlength="40" autocomplete="off"></label>
      <button type="button" class="scan-remove" data-remove aria-label="Remove ${esc(item.part_number)}">×</button>
    </li>`)).join('') + pendingRows(items.length);
  $('nextNumber').textContent = items.length + state.pending.length + 1;
  renderCheck();
}

function renderCheck() {
  const check = state.check;
  if (!check) return;
  const hour = new Intl.DateTimeFormat('en-US', { hour: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(2026, 0, 1, check.checkHour)));
  $('checkAbout').textContent = `Stock and old inventory are checked against Omega quotes and work orders written up in the last 60 days, every morning at ${hour} (Arizona time). `
    + (check.emailConfigured ? 'New old-inventory matches are emailed.' : "Email isn't set up yet, so matches only show here.");
  $('checkInventory').hidden = !check.omegaConnected;
  const last = check.last;
  $('checkStatus').textContent = !check.omegaConnected
    ? "Omega isn't connected, so inventory isn't checked."
    : !last ? 'Not checked yet.'
      : last.error ? `The last check (${dateTime(last.checkedAt)}) didn't finish: ${last.error}`
        : `Last checked ${dateTime(last.checkedAt)}: ${plural(last.jobs, 'open job', 'open jobs')}, ${plural(last.matches, 'match', 'matches')}.`
          + (last.emailed ? ` ${plural(last.emailed, 'old-inventory match', 'old-inventory matches')} emailed.` : '')
          + (last.emailError ? ` The email wasn't sent: ${last.emailError}` : '');
}

async function loadInventory() {
  const data = await api('/inventory');
  state.inventory = data.items;
  state.check = data.check;
}

async function changeInventory(id, changes) {
  const item = state.inventory.find(entry => entry.id === id);
  if (!item) return;
  const before = { quantity: item.quantity, shelf: item.shelf };
  Object.assign(item, changes);
  render();
  try {
    await api(`/inventory/${encodeURIComponent(id)}`, { method: 'PUT', body: { quantity: item.quantity, shelf: item.shelf } });
  } catch (error) {
    Object.assign(item, before);
    showMessage(error.message);
    render();
  }
}

async function checkInventory() {
  const button = $('checkInventory');
  button.disabled = true;
  $('checkStatus').textContent = 'Checking Omega…';
  try {
    await api('/inventory/check', { method: 'POST' });
  } catch (error) {
    showMessage(error.message);
  }
  try {
    await loadInventory();
  } catch {}
  button.disabled = false;
  render();
}

// ---------- Editing a part number ----------

function focusEdit({ select = false } = {}) {
  const input = $('scanRows').querySelector('[data-edit-part]');
  if (!input) return;
  input.focus();
  if (select) input.select();
  else input.setSelectionRange(input.value.length, input.value.length);
}

function startEdit(id) {
  const line = state.scans.find(scan => scan.id === id) || state.inventory.find(item => item.id === id);
  if (!line) return;
  showMessage('');
  state.editing = { id, part: line.part_number, supplier: line.supplier || '' };
  render();
  focusEdit({ select: true });
}

function cancelEdit() {
  state.editing = null;
  render();
  focusScan();
}

// Receiving lines save the part number and the list; inventory lines save
// the part number, and a part number already on the list can be combined
// into that line.
async function saveEdit({ combine = false } = {}) {
  const edit = state.editing;
  if (!edit || edit.saving) return;
  const { supplier, title } = TABS[state.tab];
  edit.saving = true;
  showMessage('');
  $('scanNote').textContent = '';
  render();
  try {
    if (supplier) {
      const { scan } = await api(`/scans/${encodeURIComponent(edit.id)}`, { method: 'PUT', body: { part_number: edit.part, supplier: edit.supplier } });
      Object.assign(state.scans.find(entry => entry.id === edit.id), scan);
      if (scan.supplier !== supplier) $('scanNote').textContent = `${scan.part_number} moved to the ${TABS[scan.supplier].label} list.`;
    } else {
      const item = state.inventory.find(entry => entry.id === edit.id);
      const before = partKey(item.part_number);
      const result = await api(`/inventory/${encodeURIComponent(edit.id)}`, { method: 'PUT', body: { quantity: item.quantity, shelf: item.shelf, part_number: edit.part, combine } });
      await loadInventory();
      const combined = state.inventory.find(entry => entry.id === result.combined);
      if (combined) $('scanNote').textContent = `Combined: ${combined.part_number}, now ${combined.quantity} in ${title}.`;
      else if (partKey(edit.part) !== before && state.check?.omegaConnected) $('scanNote').textContent = `Saved. The Omega jobs that need ${edit.part.trim()} show after the next check, or use Check now.`;
    }
    state.editing = null;
  } catch (error) {
    edit.saving = false;
    const other = error.data?.existing;
    if (other && !combine && confirm(`${other.part_number} is already in ${title} (${other.quantity} on hand). Combine them into one line?`)) return saveEdit({ combine: true });
    showMessage(error.message);
  }
  render();
  if (state.editing) focusEdit();
  else focusScan();
}

// ---------- Scanning ----------

// Scans save one at a time, in the order they were scanned, into the list on
// screen when the scan was made. A scan clears that list's search, so the new
// line shows.
function addScan(value) {
  const part = value.trim();
  if (!part) return;
  const tab = state.tab;
  const { supplier } = TABS[tab];
  showMessage('');
  $('scanNote').textContent = '';
  state.search[tab] = '';
  state.pending.push(part);
  render();
  saving = saving.then(async () => {
    try {
      if (supplier) {
        const { scan } = await api('/scans', { method: 'POST', body: { supplier, part_number: part } });
        state.scans.push(scan);
      } else {
        const { item } = await api('/inventory', { method: 'POST', body: { section: tab, part_number: part } });
        await loadInventory();
        if (!item.added) $('scanNote').textContent = `${part}: now ${item.quantity} in ${TABS[tab].title}.`;
      }
    } catch (error) {
      showMessage(`${part} wasn't saved: ${error.message}`);
    } finally {
      state.pending.shift();
      render();
    }
  });
}

async function removeLine(id) {
  showMessage('');
  try {
    if (TABS[state.tab].supplier) {
      await api(`/scans/${encodeURIComponent(id)}`, { method: 'DELETE' });
      state.scans = state.scans.filter(scan => scan.id !== id);
    } else {
      const item = state.inventory.find(entry => entry.id === id);
      if (item && !confirm(`Remove ${item.part_number} (${item.quantity} on hand) from ${TABS[state.tab].title}?`)) return;
      await api(`/inventory/${encodeURIComponent(id)}`, { method: 'DELETE' });
      state.inventory = state.inventory.filter(entry => entry.id !== id);
    }
  } catch (error) {
    showMessage(error.message);
  } finally {
    render();
    focusScan();
  }
}

// #receiving (the old link) opens the receiving list used last.
function showTab() {
  const tab = location.hash.slice(1);
  state.tab = TABS[tab] ? tab : state.receiving;
  if (TABS[state.tab].supplier) state.receiving = state.tab;
  state.editing = null;
  showMessage('');
  $('scanNote').textContent = '';
  render();
  focusScan();
}

$('scanInput').addEventListener('keydown', event => {
  // Scanners end each barcode with Enter (some with Tab).
  if (event.key !== 'Enter' && !(event.key === 'Tab' && event.target.value.trim())) return;
  event.preventDefault();
  const value = event.target.value;
  event.target.value = '';
  addScan(value);
});

// ---------- Printing ----------
// A plain black-and-white sheet, not the screen: the list's name and the
// time, then compact tables. A search limits what prints. Save as PDF names
// the file after the list.

const printTable = (headings, rows) => (rows.length
  ? `<table><thead><tr>${headings.map(([text, kind = '']) => `<th class="${kind}">${text}</th>`).join('')}</tr></thead>`
    + `<tbody>${rows.map(cells => `<tr>${cells.join('')}</tr>`).join('')}</tbody></table>`
  : '<p class="print-none">None</p>');

// Receiving: Return to the vendor first, then Need, then anything not marked
// (left off when there's nothing). The Omega column shows only work orders.
function receivingPrint(supplier) {
  const lines = shownScans();
  const omega = Boolean(state.schedule);
  const table = entries => printTable(
    [['#', 'num'], ['Part number', 'part'], ...(omega ? [['Omega work order']] : [])],
    entries.map(({ scan, number }) => [
      `<td class="num">${number}</td>`,
      `<td class="part">${esc(scan.part_number)}</td>`,
      ...(omega ? [`<td>${scheduleJobs(scan).map(job => esc(jobText(job)) + versionNote(scan.part_number, job.part)).join('; ')}</td>`] : [])
    ])
  );
  const section = (name, entries) => `<section class="print-section"><h3>${name} <span>(${entries.length})</span></h3>${table(entries)}</section>`;
  const unmarked = lines.filter(({ scan }) => !scan.need && !scan.to_return);
  return section(`Return to ${TABS[supplier].label}`, lines.filter(({ scan }) => scan.to_return))
    + section('Need', lines.filter(({ scan }) => scan.need))
    + (unmarked.length ? section('Not marked', unmarked) : '');
}

function inventoryPrint() {
  const lines = shownItems();
  const omega = Boolean(state.check?.omegaConnected);
  const total = lines.reduce((sum, { item }) => sum + item.quantity, 0);
  return `<section class="print-section"><h3>${plural(lines.length, 'part number', 'part numbers')} <span>(${total} on hand)</span></h3>${printTable(
    [['#', 'num'], ['Part number', 'part'], ['Qty', 'qty'], ['Shelf', 'shelf'], ...(omega ? [['Needed by']] : [])],
    lines.map(({ item, number }) => [
      `<td class="num">${number}</td>`,
      `<td class="part">${esc(item.part_number)}</td>`,
      `<td class="qty">${item.quantity}</td>`,
      `<td>${esc(item.shelf)}</td>`,
      ...(omega ? [`<td>${item.matches.map(match => matchText(item, match)).join('; ')}</td>`] : [])
    ])
  )}</section>`;
}

// Each part number prints on one line (DW02416 GTY never breaks at the space):
// the part column is as wide as the longest part number on the sheet, the same
// in every table so they line up. Only a part number too long for half the
// page may still wrap.
const PART_COLUMN_MAX = 340; // px
function fitPartColumn() {
  const sheet = $('printSheet');
  const context = document.createElement('canvas').getContext('2d');
  const family = getComputedStyle(sheet).fontFamily;
  const textWidth = (text, font) => {
    context.font = `${font} ${family}`;
    return context.measureText(text).width;
  };
  const widest = Math.max(
    textWidth('PART NUMBER', '700 9pt'),
    ...[...sheet.querySelectorAll('td.part')].map(cell => textWidth(cell.textContent, '700 12pt'))
  );
  const column = Math.ceil(widest) + 20; // 12px of padding, plus room to spare
  sheet.style.setProperty('--part-width', `${Math.min(column, PART_COLUMN_MAX)}px`);
  sheet.classList.toggle('long-parts', column > PART_COLUMN_MAX);
}

const pageTitle = document.title;
function preparePrint() {
  const { supplier, label, title } = TABS[state.tab];
  const search = searchText();
  const printed = new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'America/Phoenix' }).format(new Date());
  $('printSheet').innerHTML = `
    <div class="print-head"><h2>${supplier ? `${esc(label)} <span>Receiving</span>` : esc(title)}</h2><p>${esc(printed)}</p></div>
    ${search ? `<p class="print-filter">Only parts matching “${esc(search)}”</p>` : ''}
    ${supplier ? receivingPrint(supplier) : inventoryPrint()}`;
  fitPartColumn();
  document.title = `${title} ${printed}`;
}
window.addEventListener('beforeprint', preparePrint);
window.addEventListener('afterprint', () => { document.title = pageTitle; });
$('printList').addEventListener('click', () => {
  preparePrint();
  window.print();
  focusScan();
});

$('searchInput').addEventListener('input', event => {
  state.search[state.tab] = event.target.value;
  render();
});
$('searchInput').addEventListener('keydown', event => {
  // Escape clears the search and goes back to scanning.
  if (event.key === 'Escape') {
    event.preventDefault();
    state.search[state.tab] = '';
    render();
    focusScan();
  }
  // Enter selects the search, so a part scanned into it next replaces it.
  if (event.key === 'Enter') {
    event.preventDefault();
    event.target.select();
  }
});

// A scan that starts while a checkbox or button has focus still goes to the scan box.
document.addEventListener('keydown', event => {
  const active = document.activeElement;
  const typing = active?.matches?.('input[type="text"], input[type="search"], input[type="date"], select, textarea');
  if (!typing && event.key.length === 1 && event.key.trim() && !event.ctrlKey && !event.metaKey && !event.altKey) focusScan({ scroll: true });
});

$('scanRows').addEventListener('change', event => {
  const row = event.target.closest('[data-id]');
  if (!row) return;
  if (event.target.matches('[data-mark]')) mark(row.dataset.id, event.target.dataset.mark, event.target.checked);
  if (event.target.matches('[data-shelf]')) changeInventory(row.dataset.id, { shelf: event.target.value.trim() });
  if (event.target.matches('[data-edit-supplier]') && state.editing) state.editing.supplier = event.target.value;
});
$('scanRows').addEventListener('input', event => {
  if (event.target.matches('[data-edit-part]') && state.editing) state.editing.part = event.target.value;
});
// Enter in a shelf box saves it and goes back to scanning. Enter in the edit
// box saves it (a part scanned into it too); Escape cancels.
$('scanRows').addEventListener('keydown', event => {
  if (event.key === 'Enter' && event.target.matches('[data-shelf]')) {
    event.preventDefault();
    focusScan();
  }
  if (event.target.matches('[data-edit-part], [data-edit-supplier]')) {
    if (event.key === 'Enter') {
      event.preventDefault();
      saveEdit();
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelEdit();
    }
  }
});
$('scanRows').addEventListener('click', event => {
  const row = event.target.closest('[data-id]');
  if (!row) return;
  if (event.target.closest('[data-remove]')) removeLine(row.dataset.id);
  if (event.target.closest('[data-edit]')) startEdit(row.dataset.id);
  if (event.target.closest('[data-edit-save]')) saveEdit();
  if (event.target.closest('[data-edit-cancel]')) cancelEdit();
  const step = event.target.closest('[data-quantity]');
  if (step) {
    const item = state.inventory.find(entry => entry.id === row.dataset.id);
    const quantity = item.quantity + Number(step.dataset.quantity);
    if (quantity < 1) removeLine(item.id);
    else changeInventory(item.id, { quantity: Math.min(quantity, 999) });
    focusScan();
  }
});
$('clearScans').addEventListener('click', clearList);
$('checkSchedule').addEventListener('click', checkSchedule);
$('checkInventory').addEventListener('click', checkInventory);
window.addEventListener('hashchange', showTab);

(async () => {
  const me = await fetch('/api/me');
  if (!me.ok) {
    location.href = '/login?next=%2Fautoglass';
    return;
  }
  $('user').textContent = (await me.json()).user.full_name;
  // Default: today through a week out.
  $('scheduleFrom').value = phoenixDay();
  $('scheduleTo').value = phoenixDay(7);
  try {
    const [scans] = await Promise.all([api('/scans'), loadInventory()]);
    state.scans = scans.scans;
    showTab();
    if (scans.omegaConnected) checkSchedule();
    else {
      $('scheduleStatus').textContent = "Omega isn't connected, so scans aren't checked against the schedule.";
      $('checkSchedule').hidden = true;
    }
  } catch (error) {
    showMessage(error.message);
  }
  focusScan();
})();
