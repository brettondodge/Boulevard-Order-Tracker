import { partKey, scheduleMatches, unscannedGlass } from './autoglass-match.js';

const $ = id => document.getElementById(id);
const TABS = {
  receiving: {
    intro: "Scan each part's barcode; the next line is ready right away. Tick <strong>Need</strong> to keep a part (green) or <strong>Return</strong> to send it back (red).",
    placeholder: 'Scan the next part'
  },
  stock: {
    intro: 'Parts kept on hand. Scan a part to add it; scanning the same part again adds one more.',
    placeholder: 'Scan a part into Stock'
  },
  old: {
    intro: "Leftover parts to use up. Scan a part to add it; scanning the same part again adds one more. When an Omega job needs one, you're emailed.",
    placeholder: 'Scan a part into Old inventory'
  }
};
const state = {
  tab: 'receiving',
  scans: [],
  inventory: [],
  check: null, // the Omega check's settings and last result
  pending: [], // part numbers scanned and still being saved, in order
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
  if (!response.ok) throw new Error(data.error || 'Something went wrong. Try again.');
  return data;
}

function showMessage(text) {
  $('scanMessage').textContent = text;
}

// The scan box always gets the next key press, so a scan never lands in a checkbox.
function focusScan() {
  $('scanInput').focus();
}

function render() {
  const receiving = state.tab === 'receiving';
  document.querySelectorAll('[data-tab]').forEach(link => link.setAttribute('aria-current', String(link.dataset.tab === state.tab)));
  $('tabIntro').innerHTML = TABS[state.tab].intro;
  $('scanInput').placeholder = TABS[state.tab].placeholder;
  $('clearScans').hidden = !receiving;
  $('downloadInventory').hidden = receiving;
  $('downloadInventory').href = `/api/autoglass/inventory.csv?section=${state.tab}`;
  $('schedulePanel').hidden = !receiving;
  $('checkPanel').hidden = receiving;
  if (receiving) renderScans();
  else renderInventory();
}

// ---------- Receiving ----------

function matchHtml(scan) {
  if (!state.schedule) return '';
  const jobs = scheduleMatches(scan.part_number, state.schedule.jobs);
  if (!jobs.length) return `<span class="match none">Not on the Omega schedule (${esc(shortDate(state.schedule.from))} – ${esc(shortDate(state.schedule.to))})</span>`;
  return `<span class="match on">On ${jobs.map(job => esc(jobText(job)) + versionNote(scan.part_number, job.part)).join('; ')}</span>`;
}

const pendingRows = (count) => state.pending.map((part, index) => `
    <li class="scan-row saving">
      <span class="scan-number">${count + index + 1}</span>
      <div class="scan-part"><strong>${esc(part)}</strong><span class="match">Saving…</span></div>
    </li>`).join('');

function renderScans() {
  const { scans } = state;
  const need = scans.filter(scan => scan.need).length;
  const back = scans.filter(scan => scan.to_return).length;
  $('scanSummary').textContent = scans.length
    ? `${scans.length} scanned · ${need} need · ${back} return · ${scans.length - need - back} not marked`
    : 'Nothing scanned yet.';
  $('clearScans').disabled = !scans.length;
  $('scanRows').innerHTML = scans.map((scan, index) => `
    <li class="scan-row ${scan.need ? 'need' : scan.to_return ? 'return' : ''}" data-id="${esc(scan.id)}">
      <span class="scan-number">${index + 1}</span>
      <div class="scan-part"><strong>${esc(scan.part_number)}</strong>${matchHtml(scan)}</div>
      <label class="scan-box"><input type="checkbox" data-mark="need" ${scan.need ? 'checked' : ''}> Need</label>
      <label class="scan-box"><input type="checkbox" data-mark="to_return" ${scan.to_return ? 'checked' : ''}> Return</label>
      <button type="button" class="scan-remove" data-remove aria-label="Remove ${esc(scan.part_number)}">×</button>
    </li>`).join('') + pendingRows(scans.length);
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
    + (missing.length ? `Glass on them not scanned yet: ${missing.length}.` : 'All their glass has been scanned.');
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
  if (!state.scans.length || !confirm(`Clear all ${state.scans.length} scans and start a new list?`)) return;
  try {
    await api('/clear', { method: 'POST' });
    state.scans = [];
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

function inventoryMatches(item) {
  if (!item.matches.length) return '';
  const jobs = item.matches.map(match => [
    `${match.status || 'Job'} #${match.job_number}`,
    match.scheduled_date ? `scheduled ${shortDate(match.scheduled_date)}` : '',
    match.vehicle
  ].filter(Boolean).map(esc).join(' · ') + versionNote(item.part_number, match.part) + (match.emailed ? ' · emailed' : ''));
  return `<span class="match on">Needed by ${jobs.join('; ')}</span>`;
}

function renderInventory() {
  const items = state.inventory.filter(item => item.section === state.tab);
  const total = items.reduce((sum, item) => sum + item.quantity, 0);
  const matched = items.filter(item => item.matches.length).length;
  $('scanSummary').textContent = items.length
    ? `${plural(items.length, 'part number', 'part numbers')} · ${total} on hand${state.check?.last ? ` · ${matched} needed by open Omega jobs` : ''}`
    : 'Nothing here yet.';
  $('scanRows').innerHTML = items.map((item, index) => `
    <li class="scan-row inventory-row ${item.matches.length ? 'matched' : ''}" data-id="${esc(item.id)}">
      <span class="scan-number">${index + 1}</span>
      <div class="scan-part"><strong>${esc(item.part_number)}</strong>${inventoryMatches(item)}</div>
      <div class="quantity" role="group" aria-label="Quantity of ${esc(item.part_number)}">
        <button type="button" data-quantity="-1" aria-label="One less">−</button>
        <span>${item.quantity}</span>
        <button type="button" data-quantity="1" aria-label="One more">+</button>
      </div>
      <label class="shelf">Shelf<input type="text" data-shelf value="${esc(item.shelf)}" maxlength="40" autocomplete="off"></label>
      <button type="button" class="scan-remove" data-remove aria-label="Remove ${esc(item.part_number)}">×</button>
    </li>`).join('') + pendingRows(items.length);
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

// ---------- Scanning ----------

// Scans save one at a time, in the order they were scanned, into the list on
// screen when the scan was made.
function addScan(value) {
  const part = value.trim();
  if (!part) return;
  const tab = state.tab;
  showMessage('');
  $('scanNote').textContent = '';
  state.pending.push(part);
  render();
  saving = saving.then(async () => {
    try {
      if (tab === 'receiving') {
        const { scan } = await api('/scans', { method: 'POST', body: { part_number: part } });
        state.scans.push(scan);
      } else {
        const { item } = await api('/inventory', { method: 'POST', body: { section: tab, part_number: part } });
        await loadInventory();
        if (!item.added) $('scanNote').textContent = `${part}: now ${item.quantity} in ${tab === 'old' ? 'Old inventory' : 'Stock'}.`;
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
    if (state.tab === 'receiving') {
      await api(`/scans/${encodeURIComponent(id)}`, { method: 'DELETE' });
      state.scans = state.scans.filter(scan => scan.id !== id);
    } else {
      const item = state.inventory.find(entry => entry.id === id);
      if (item && !confirm(`Remove ${item.part_number} (${item.quantity} on hand) from ${state.tab === 'old' ? 'Old inventory' : 'Stock'}?`)) return;
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

function showTab() {
  const tab = location.hash.slice(1);
  state.tab = TABS[tab] ? tab : 'receiving';
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

// A scan that starts while a checkbox or button has focus still goes to the scan box.
document.addEventListener('keydown', event => {
  const active = document.activeElement;
  const typing = active?.matches?.('input[type="text"], input[type="date"], textarea');
  if (!typing && event.key.length === 1 && event.key.trim() && !event.ctrlKey && !event.metaKey && !event.altKey) focusScan();
});

$('scanRows').addEventListener('change', event => {
  const row = event.target.closest('[data-id]');
  if (!row) return;
  if (event.target.matches('[data-mark]')) mark(row.dataset.id, event.target.dataset.mark, event.target.checked);
  if (event.target.matches('[data-shelf]')) changeInventory(row.dataset.id, { shelf: event.target.value.trim() });
});
// Enter in a shelf box saves it and goes back to scanning.
$('scanRows').addEventListener('keydown', event => {
  if (event.key === 'Enter' && event.target.matches('[data-shelf]')) {
    event.preventDefault();
    focusScan();
  }
});
$('scanRows').addEventListener('click', event => {
  const row = event.target.closest('[data-id]');
  if (!row) return;
  if (event.target.closest('[data-remove]')) removeLine(row.dataset.id);
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
