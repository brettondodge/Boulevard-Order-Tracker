import { scheduleMatches, unscannedGlass } from './autoglass-match.js';

const $ = id => document.getElementById(id);
const state = {
  scans: [],
  pending: [], // part numbers scanned and still being saved, in order
  schedule: null // { jobs, from, to } once Omega has been checked
};
let saving = Promise.resolve();

const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const phoenixDay = (offsetDays = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix' }).format(new Date(Date.now() + offsetDays * 86400000));
const shortDate = day => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`));
const jobText = job => [`WO #${job.number}`, shortDate(job.scheduledDate), job.vehicle].filter(Boolean).join(' · ');

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

function matchHtml(scan) {
  if (!state.schedule) return '';
  const { exact, close } = scheduleMatches(scan.part_number, state.schedule.jobs);
  if (exact.length) return `<span class="match on">On ${exact.map(jobText).map(esc).join('; ')}</span>`;
  if (close.length) return `<span class="match close">Close: ${close.map(job => `${esc(jobText(job))} needs ${esc(job.part)}`).join('; ')}</span>`;
  return `<span class="match none">Not on the Omega schedule (${esc(shortDate(state.schedule.from))} – ${esc(shortDate(state.schedule.to))})</span>`;
}

function renderScans() {
  const { scans, pending } = state;
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
    </li>`).join('') + pending.map((part, index) => `
    <li class="scan-row saving">
      <span class="scan-number">${scans.length + index + 1}</span>
      <div class="scan-part"><strong>${esc(part)}</strong><span class="match">Saving…</span></div>
    </li>`).join('');
  $('nextNumber').textContent = scans.length + pending.length + 1;
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
  $('scheduleStatus').textContent = `${jobs} work ${jobs === 1 ? 'order' : 'orders'} scheduled ${shortDate(state.schedule.from)} – ${shortDate(state.schedule.to)}. `
    + (missing.length ? `Glass on them not scanned yet: ${missing.length}.` : 'All their glass has been scanned.');
  list.innerHTML = missing.map(job => `<li><strong>${esc(job.part)}</strong> · ${esc(jobText(job))}</li>`).join('');
}

// Scans save one at a time, in the order they were scanned.
function addScan(value) {
  const part = value.trim();
  if (!part) return;
  showMessage('');
  state.pending.push(part);
  renderScans();
  saving = saving.then(async () => {
    try {
      const { scan } = await api('/scans', { method: 'POST', body: { part_number: part } });
      state.scans.push(scan);
    } catch (error) {
      showMessage(`${part} wasn't saved: ${error.message}`);
    } finally {
      state.pending.shift();
      renderScans();
    }
  });
}

async function mark(id, field, checked) {
  const scan = state.scans.find(entry => entry.id === id);
  if (!scan) return;
  const before = { need: scan.need, to_return: scan.to_return };
  // Need and Return are one or the other.
  const next = field === 'need' ? { need: checked, to_return: checked ? false : scan.to_return } : { to_return: checked, need: checked ? false : scan.need };
  Object.assign(scan, next);
  renderScans();
  focusScan();
  try {
    Object.assign(scan, (await api(`/scans/${encodeURIComponent(id)}`, { method: 'PUT', body: next })).scan);
  } catch (error) {
    Object.assign(scan, before);
    showMessage(error.message);
  }
  renderScans();
}

async function remove(id) {
  showMessage('');
  try {
    await api(`/scans/${encodeURIComponent(id)}`, { method: 'DELETE' });
    state.scans = state.scans.filter(scan => scan.id !== id);
  } catch (error) {
    showMessage(error.message);
  }
  renderScans();
  focusScan();
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
  renderScans();
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
  renderScans();
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
  const box = event.target.closest('[data-mark]');
  if (box) mark(box.closest('[data-id]').dataset.id, box.dataset.mark, box.checked);
});
$('scanRows').addEventListener('click', event => {
  const button = event.target.closest('[data-remove]');
  if (button) remove(button.closest('[data-id]').dataset.id);
});
$('clearScans').addEventListener('click', clearList);
$('checkSchedule').addEventListener('click', checkSchedule);

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
    const data = await api('/scans');
    state.scans = data.scans;
    renderScans();
    if (data.omegaConnected) checkSchedule();
    else {
      $('scheduleStatus').textContent = "Omega isn't connected, so scans aren't checked against the schedule.";
      $('checkSchedule').hidden = true;
    }
  } catch (error) {
    showMessage(error.message);
  }
  focusScan();
})();
