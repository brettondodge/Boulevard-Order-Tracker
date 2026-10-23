import {
  ITEM_TYPES,
  ITEM_UNITS,
  SPREADSHEET_COLUMNS,
  billingMonthFor,
  formatMoney as money,
  hasListPrice,
  isValidMonth,
  matchLine,
  parseMoney,
  parseQuantity,
  spreadsheetRows,
  summarizeInvoice,
  summarizeMonth
} from './freeport-billing.js';

const screen = document.getElementById('screen');

const state = {
  config: null,
  renderId: 0,
  currentUrl: location.pathname + location.search,
  dirty: false,
  editor: null
};

// ---------- Helpers ----------

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function parseDate(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(year, month - 1, day || 1);
}

const formatDate = iso => (iso ? parseDate(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
const formatMonth = month => parseDate(month).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
const centsToInput = cents => (Number.isInteger(cents) ? (cents / 100).toFixed(2) : '');

function shiftMonth(month, delta) {
  const date = parseDate(month);
  date.setMonth(date.getMonth() + delta);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function monthEnd(month) {
  const date = parseDate(shiftMonth(month, 1));
  date.setDate(0);
  return `${month}-${String(date.getDate()).padStart(2, '0')}`;
}

function phoenixMonth() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Phoenix', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  return `${parts.find(part => part.type === 'year').value}-${parts.find(part => part.type === 'month').value}`;
}

async function api(path, options = {}) {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: options.body ? { 'Content-Type': 'application/json' } : {},
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401 && path === '/me') {
    location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
  }
  if (!response.ok) {
    const error = new Error(body.error || 'Something went wrong. Try again.');
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

async function loadConfig(force = false) {
  if (!state.config || force) state.config = await api('/freeport/config');
  return state.config;
}

const statusBadge = status => `<span class="badge ${status === 'Ready' ? 'ok' : 'review'}">${esc(status)}</span>`;
const stepButton = (step, label) => `<button type="button" disabled title="Arrives in build step ${step}">${esc(label)}</button>`;

function metric(label, value, note = '') {
  return `<div class="metric"><span>${esc(label)}</span><b>${value}</b>${note ? `<small>${note}</small>` : ''}</div>`;
}

function messageHtml(error) {
  if (!error) return '';
  const blockers = error.body?.blockers || [];
  const existing = error.body?.existing;
  const invoices = error.body?.invoices || [];
  return `<div class="alert error" role="alert">
    ${esc(error.message)}
    ${existing ? ` <a href="/freeport/invoices/${encodeURIComponent(existing)}">Open invoice ${esc(existing)}</a>` : ''}
    ${invoices.length ? ` Needs review: ${invoices.map(number => `<a href="/freeport/invoices/${encodeURIComponent(number)}">${esc(number)}</a>`).join(', ')}` : ''}
    ${blockers.length ? `<ul>${blockers.map(item => `<li>${esc(item)}</li>`).join('')}</ul>` : ''}
  </div>`;
}

function issuesHtml(summary) {
  if (!summary.blockers.length && !summary.warnings.length) return '<p class="ok-text">✓ No problems found.</p>';
  return `
    ${summary.blockers.length ? `<p><strong>Must fix before Ready</strong></p><ul class="issues blockers">${summary.blockers.map(item => `<li>${esc(item)}</li>`).join('')}</ul>` : ''}
    ${summary.warnings.length ? `<p><strong>Check</strong></p><ul class="issues warnings">${summary.warnings.map(item => `<li>${esc(item)}</li>`).join('')}</ul>` : ''}`;
}

// ---------- Month view ----------

async function defaultMonth() {
  const months = await api('/freeport/months');
  const oldestToReview = [...months].reverse().find(month => month.needsReview > 0);
  return oldestToReview?.month || months[0]?.month || phoenixMonth();
}

// Only a well-formed month from the URL is ever used; anything else falls back.
async function monthParam(params) {
  const month = params.get('month');
  return isValidMonth(month) ? month : defaultMonth();
}

async function renderMonth(params, isCurrent) {
  const month = await monthParam(params);
  const [config, invoices, months] = await Promise.all([loadConfig(), api(`/freeport/invoices?month=${encodeURIComponent(month)}`), api('/freeport/months')]);
  if (!isCurrent()) return;
  const summary = summarizeMonth(month, invoices, config);
  const chips = months.slice(0, 8).map(entry => `
    <a class="chip ${entry.month === month ? 'active' : ''}" href="/freeport?month=${entry.month}">
      ${esc(formatMonth(entry.month))} · ${entry.invoices}${entry.needsReview ? ` <span class="warn">(${entry.needsReview} to review)</span>` : ''}
    </a>`).join('');

  const rows = summary.invoices.map(invoice => {
    const lateInvoice = invoice.omegaDate && invoice.omegaDate.slice(0, 7) !== invoice.billingMonth;
    const href = `/freeport/invoices/${encodeURIComponent(invoice.number)}`;
    return `
      <tr class="clickable" data-href="${href}">
        <td><a href="${href}"><strong>${esc(invoice.number)}</strong></a></td>
        <td>${formatDate(invoice.installDate)}</td>
        <td>${formatDate(invoice.omegaDate)}${lateInvoice ? ' <span class="badge info" title="Billed by install date">Different month</span>' : ''}</td>
        <td>${esc(invoice.orderNumber) || '—'}</td>
        <td>${esc(invoice.account?.name ?? (invoice.accountCode || '—'))}<small class="block">${esc(invoice.accountCode)}</small></td>
        <td class="num">${money(invoice.parts)}</td>
        <td class="num">${money(invoice.labor)}</td>
        <td class="num">${money(invoice.tax)}</td>
        <td class="num">${money(invoice.total)}</td>
        <td>${statusBadge(invoice.status)}${invoice.blockers.length ? `<small class="block warn">${invoice.blockers.length} to fix</small>` : ''}</td>
      </tr>`;
  }).join('');

  screen.innerHTML = `
    <div class="page-head">
      <div>
        <p class="eyebrow">FREEPORT-MCMORAN · SAFFORD</p>
        <div class="month-picker">
          <a class="button icon" href="/freeport?month=${shiftMonth(month, -1)}" aria-label="Previous month">‹</a>
          <h1>${formatMonth(month)}</h1>
          <a class="button icon" href="/freeport?month=${shiftMonth(month, 1)}" aria-label="Next month">›</a>
        </div>
      </div>
      <div class="actions">
        ${stepButton(7, 'Import from Omega')}
        <a class="button" href="/freeport/invoices/new?month=${month}">Add invoice</a>
        <a class="button primary" href="/freeport/close?month=${month}">Month close →</a>
      </div>
    </div>
    ${chips ? `<nav class="chips" aria-label="Months with invoices">${chips}</nav>` : ''}

    <section class="metrics-row">
      ${metric('Invoices', summary.invoices.length, summary.needsReview.length ? `<span class="warn">${summary.needsReview.length} need review</span>` : summary.invoices.length ? 'All ready' : '')}
      ${metric('Parts', money(summary.parts))}
      ${metric('Labor', money(summary.labor))}
      ${metric(`Tax (${esc(config.settings.taxRate)}% of parts)`, money(summary.tax))}
      ${metric('Month total', money(summary.total))}
    </section>

    <section class="panel">
      ${summary.invoices.length ? `
        <div class="scroll">
          <table class="invoice-table">
            <thead><tr>
              <th>Invoice #</th><th>Install date</th><th>Invoice date</th><th>Order #</th><th>Account</th>
              <th class="num">Parts</th><th class="num">Labor</th><th class="num">Tax</th><th class="num">Total</th><th>Status</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>` : `<p class="empty">No invoices installed in ${formatMonth(month)} yet. <a href="/freeport/invoices/new?month=${month}">Add one</a></p>`}
    </section>`;
}

// ---------- Invoice editor ----------

function blankInvoice(month) {
  return {
    number: '', omegaDate: '', installDate: '', monthOverride: '', orderNumber: '', accountCode: '',
    omegaTax: '', driveLink: '', notes: '', status: 'Needs review', version: 0,
    lines: [],
    suggestedMonth: month
  };
}

function draftFromInvoice(invoice) {
  return {
    ...invoice,
    omegaTax: centsToInput(invoice.omegaTaxCents),
    lines: invoice.lines.map(line => ({ sku: line.sku, itemId: line.itemId, description: line.description, quantity: line.quantity, rate: centsToInput(line.rateCents) }))
  };
}

function invoiceFromDraft(draft) {
  const omegaTax = draft.omegaTax.trim();
  return {
    number: draft.number.trim(),
    omegaDate: draft.omegaDate,
    installDate: draft.installDate,
    monthOverride: draft.monthOverride,
    orderNumber: draft.orderNumber,
    accountCode: draft.accountCode,
    omegaTaxCents: omegaTax ? parseMoney(omegaTax) : null,
    driveLink: draft.driveLink.trim(),
    notes: draft.notes,
    status: draft.status,
    version: draft.version,
    lines: draft.lines.map(line => ({ sku: line.sku, itemId: line.itemId, description: (line.description || '').trim(), quantity: line.quantity.trim(), rateCents: parseMoney(line.rate) }))
  };
}

function itemOptions(selectedId, config) {
  const options = ITEM_TYPES.map(type => {
    const items = config.items.filter(item => item.type === type && (item.active || item.id === selectedId));
    return `<optgroup label="${type}">${items.map(item => `
      <option value="${item.id}" ${item.id === selectedId ? 'selected' : ''}>${esc(item.description)} · ${esc(item.sku)}${item.priceCents ? ` · ${money(item.priceCents)}` : ''}${item.active ? '' : ' (inactive)'}</option>`).join('')}
    </optgroup>`;
  }).join('');
  return `<option value="">Pick item…</option>${options}`;
}

function lineRowHtml(line, index, matched, config) {
  const selectedId = line.itemId || matched?.item?.id || '';
  return `
    <tr data-row="${index}">
      <td class="item-cell">
        <select data-line-field="itemId" aria-label="Line ${index + 1} item">${itemOptions(selectedId, config)}</select>
        <input data-line-field="description" value="${esc(line.description || '')}" class="line-description" placeholder="Description for the spreadsheet, e.g. DW02153GTYN Windshield" aria-label="Line ${index + 1} description" hidden>
        <small class="block warn" data-cell="sku-hint"></small>
      </td>
      <td><input data-line-field="quantity" value="${esc(line.quantity)}" inputmode="decimal" aria-label="Line ${index + 1} quantity" class="short"></td>
      <td data-cell="unit"></td>
      <td><input data-line-field="rate" value="${esc(line.rate)}" inputmode="decimal" aria-label="Line ${index + 1} rate" class="short"></td>
      <td class="num" data-cell="total"></td>
      <td data-cell="type"></td>
      <td data-cell="check"></td>
      <td class="row-actions">
        <button type="button" data-action="copy-line" title="Copy line (e.g. second technician)">Copy</button>
        <button type="button" data-action="remove-line" title="Remove line" aria-label="Remove line ${index + 1}">✕</button>
      </td>
    </tr>`;
}

function renderLines() {
  const { draft, config } = state.editor;
  const summary = summarizeInvoice(invoiceFromDraft(draft), config);
  screen.querySelector('#lines').innerHTML = draft.lines.length
    ? draft.lines.map((line, index) => lineRowHtml(line, index, summary.lines[index], config)).join('')
    : '<tr><td colspan="8" class="empty">No line items yet.</td></tr>';
  updateDerived();
}

function updateDerived() {
  const { draft, config, original } = state.editor;
  const summary = summarizeInvoice(invoiceFromDraft(draft), config);
  summary.lines.forEach((line, index) => {
    const row = screen.querySelector(`tr[data-row="${index}"]`);
    if (!row) return;
    // Lines without a hand-picked item follow the match, e.g. a rate edit picks a different size.
    if (!draft.lines[index].itemId) row.querySelector('select').value = line.item?.id ?? '';
    row.querySelector('[data-cell="sku-hint"]').textContent = !line.item && line.sku ? `SKU on invoice: ${line.sku}` : '';
    row.querySelector('[data-line-field="description"]').hidden = !line.item?.customDescription;
    row.classList.toggle('flagged', Boolean(line.issue));
    row.querySelector('[data-cell="unit"]').textContent = line.item?.unit ?? '';
    row.querySelector('[data-cell="type"]').textContent = line.item?.type ?? '';
    row.querySelector('[data-cell="total"]').textContent = line.total ? money(line.total) : '';
    row.querySelector('[data-cell="check"]').innerHTML = line.issue
      ? `<span class="warn">${esc(line.issue)}</span>`
      : line.warning ? `<span class="info-text">${esc(line.warning)}</span>` : '<span class="ok-text">OK</span>';
  });

  screen.querySelector('#totals').innerHTML = `
    <dt>Parts</dt><dd>${money(summary.parts)}</dd>
    <dt>Labor</dt><dd>${money(summary.labor)}</dd>
    ${summary.unmatched ? `<dt class="warn">Not matched</dt><dd class="warn">${money(summary.unmatched)}</dd>` : ''}
    <dt>Tax${Number.isInteger(summary.omegaTaxCents) ? ' (from invoice)' : ` (${esc(config.settings.taxRate)}% of parts)`}</dt><dd>${money(summary.tax)}</dd>
    <dt><strong>Total</strong></dt><dd><strong>${money(summary.total)}</strong></dd>`;
  screen.querySelector('#omegaTaxHint').textContent = `Leave blank to use ${config.settings.taxRate}% of parts: ${money(summary.expectedTax)}`;
  screen.querySelector('#issues').innerHTML = issuesHtml(summary);

  const month = billingMonthFor(invoiceFromDraft(draft));
  screen.querySelector('#billedIn').innerHTML = month
    ? `Billed in <strong>${formatMonth(month)}</strong>${draft.monthOverride ? ' (set by hand)' : draft.installDate ? ' (from install date)' : ' (from invoice date until the install date is entered)'}`
    : '<span class="warn">Enter the install date to place this invoice in a month.</span>';
  if (draft.omegaDate && month && draft.omegaDate.slice(0, 7) !== month) {
    screen.querySelector('#billedIn').innerHTML += `<br><small>Invoice dated ${formatDate(draft.omegaDate)}; it still bills in ${formatMonth(month)}.</small>`;
  }

  const readyButton = screen.querySelector('[data-action="save-ready"]');
  if (readyButton) {
    readyButton.disabled = summary.blockers.length > 0;
    readyButton.title = summary.blockers.length ? 'Fix the problems listed below first' : '';
  }
  state.dirty = JSON.stringify(invoiceFromDraft(draft)) !== JSON.stringify(invoiceFromDraft(original));
  screen.querySelector('#dirtyNote').textContent = state.dirty ? 'Unsaved changes' : '';
}

async function renderInvoice(number, params, isCurrent, loaded = null) {
  const config = await loadConfig();
  const isNew = number === null;
  const requestedMonth = params.get('month');
  const invoice = isNew
    ? blankInvoice(isValidMonth(requestedMonth) ? requestedMonth : phoenixMonth())
    : draftFromInvoice(loaded ?? await api(`/freeport/invoices/${encodeURIComponent(number)}`));
  if (!isCurrent()) return;
  const backMonth = isNew ? invoice.suggestedMonth : invoice.billingMonth;
  state.editor = { draft: structuredClone(invoice), original: structuredClone(invoice), config, isNew, error: null };

  const accountOptions = config.accounts
    .filter(account => account.active || account.code === invoice.accountCode)
    .map(account => `<option value="${esc(account.code)}" ${account.code === invoice.accountCode ? 'selected' : ''}>${esc(account.code)} · ${esc(account.name)}</option>`).join('');
  const unknownAccount = invoice.accountCode && !config.accounts.some(account => account.code === invoice.accountCode);

  screen.innerHTML = `
    <nav class="back-links">
      <a class="back" href="/freeport?month=${backMonth}">← ${formatMonth(backMonth)}</a>
      <a class="back" href="/freeport/close?month=${backMonth}">← ${formatMonth(backMonth)} month close</a>
    </nav>
    <form id="invoiceForm" novalidate>
      <div class="page-head">
        <div>
          <p class="eyebrow">INVOICE</p>
          <h1>${isNew ? 'New invoice' : `Invoice ${esc(invoice.number)} ${statusBadge(invoice.status)}`}</h1>
          ${isNew ? '' : `<p class="muted">Last saved ${formatDate(invoice.updatedAt.slice(0, 10))} by ${esc(invoice.updatedBy)}</p>`}
        </div>
        <div class="actions">
          <span id="dirtyNote" class="warn"></span>
          ${isNew ? '' : '<button type="button" data-action="delete" class="danger">Delete</button>'}
          ${invoice.status === 'Ready' && !isNew ? '<button type="button" data-action="save-review">Move back to review</button>' : ''}
          <button type="submit">${isNew ? 'Create' : 'Save'}</button>
          ${invoice.status === 'Ready' && !isNew ? '' : `<button type="button" class="primary" data-action="save-ready">${isNew ? 'Create and mark ready' : 'Save and mark ready'}</button>`}
        </div>
      </div>
      <div id="formMessage"></div>

      <section class="panel">
        <h2>Details</h2>
        <div class="grid">
          <label>Invoice #<input data-field="number" value="${esc(invoice.number)}" required autocomplete="off"></label>
          <label>Install date<input type="date" data-field="installDate" value="${esc(invoice.installDate)}"></label>
          <label>Invoice date<input type="date" data-field="omegaDate" value="${esc(invoice.omegaDate)}"></label>
          <label>Order number<input data-field="orderNumber" value="${esc(invoice.orderNumber)}" autocomplete="off"></label>
          <label class="span-2">Account code
            <select data-field="accountCode">
              <option value="">Choose where the job was…</option>
              ${unknownAccount ? `<option value="${esc(invoice.accountCode)}" selected>${esc(invoice.accountCode)} (not on list)</option>` : ''}
              ${accountOptions}
            </select>
          </label>
        </div>
        <p id="billedIn" class="muted"></p>
        <details ${invoice.monthOverride ? 'open' : ''}>
          <summary>Bill in a different month</summary>
          <label class="inline">Billing month override<input type="month" data-field="monthOverride" value="${esc(invoice.monthOverride)}"></label>
          <p class="muted">Only for exceptions. Normally the install date decides the month.</p>
        </details>
      </section>

      <section class="panel">
        <div class="section-head"><h2>Line items</h2><button type="button" data-action="add-line">Add line</button></div>
        <div class="scroll">
          <table class="lines-table">
            <thead><tr><th>Item</th><th>Qty</th><th>Unit</th><th>Rate</th><th class="num">Line total</th><th>Type</th><th>Check</th><th></th></tr></thead>
            <tbody id="lines"></tbody>
          </table>
        </div>
        <div class="totals-row">
          <label class="tax-input">Invoice tax<input data-field="omegaTax" value="${esc(invoice.omegaTax)}" inputmode="decimal" placeholder="Auto"><small id="omegaTaxHint"></small></label>
          <dl class="totals" id="totals"></dl>
        </div>
      </section>

      <section class="panel">
        <h2>Review</h2>
        <div id="issues"></div>
      </section>

      <section class="panel">
        <h2>Work order and photos</h2>
        <div class="grid">
          <label class="span-2">Google Drive folder link<input type="url" data-field="driveLink" value="${esc(invoice.driveLink)}" placeholder="https://drive.google.com/…"></label>
          ${invoice.driveLink ? `<p><a href="${esc(invoice.driveLink)}" target="_blank" rel="noopener noreferrer">Open folder ↗</a></p>` : ''}
        </div>
        <label>Notes<textarea data-field="notes">${esc(invoice.notes)}</textarea></label>
      </section>
    </form>`;

  renderLines();
}

function readField(target) {
  const { draft } = state.editor;
  if (target.dataset.field) {
    draft[target.dataset.field] = target.value;
    return;
  }
  const row = target.closest('tr[data-row]');
  if (!row || !target.dataset.lineField) return;
  const line = draft.lines[Number(row.dataset.row)];
  if (target.dataset.lineField === 'itemId') {
    // The item the row was showing, whether picked by hand or matched by SKU/price.
    const previous = matchLine({ ...line, quantity: '1', rateCents: parseMoney(line.rate) }, state.editor.config.items).item;
    const item = state.editor.config.items.find(candidate => candidate.id === target.value);
    line.itemId = item?.id || '';
    if (item) {
      line.sku = item.sku;
      // Replace a blank or auto-filled rate with the new item's list price. Items
      // priced on each line get a blank rate, so the old item's price can't carry over.
      const autoFilled = !line.rate.trim() || (previous && parseMoney(line.rate) === previous.priceCents);
      if (autoFilled) line.rate = hasListPrice(item) ? centsToInput(item.priceCents) : '';
    }
    renderLines();
    return;
  }
  line[target.dataset.lineField] = target.value;
}

async function saveInvoice(status) {
  const editor = state.editor;
  const payload = { ...invoiceFromDraft(editor.draft), status };
  const badLine = payload.lines.findIndex(line => line.rateCents === null || !parseQuantity(line.quantity));
  const messageBox = screen.querySelector('#formMessage');
  if (badLine >= 0) {
    messageBox.innerHTML = messageHtml(new Error(`Line ${badLine + 1}: enter a quantity above zero and a rate like 125.00.`));
    return;
  }
  if (editor.draft.omegaTax.trim() && payload.omegaTaxCents === null) {
    messageBox.innerHTML = messageHtml(new Error('Invoice tax must be a dollar amount like 55.44, or blank.'));
    return;
  }
  const buttons = screen.querySelectorAll('#invoiceForm button');
  buttons.forEach(button => { button.disabled = true; });
  let saved;
  try {
    saved = editor.isNew
      ? await api('/freeport/invoices', { method: 'POST', body: payload })
      : await api(`/freeport/invoices/${encodeURIComponent(editor.original.number)}`, { method: 'PUT', body: payload });
  } catch (error) {
    buttons.forEach(button => { button.disabled = false; });
    updateDerived();
    messageBox.innerHTML = messageHtml(error);
    messageBox.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return;
  }

  // Redraw from the saved record itself; skip if the user already moved on.
  if (state.editor !== editor) return;
  const renderId = ++state.renderId;
  state.dirty = false;
  const href = `/freeport/invoices/${encodeURIComponent(saved.number)}`;
  history.replaceState(null, '', href);
  state.currentUrl = href;
  await renderInvoice(saved.number, new URLSearchParams(), () => renderId === state.renderId, saved);
  const becameReady = saved.status === 'Ready' && editor.original.status !== 'Ready';
  screen.querySelector('#formMessage')?.insertAdjacentHTML('beforeend', `<div class="alert success" role="status">Saved${becameReady ? ' and marked ready' : ''}.</div>`);
}

async function deleteCurrentInvoice() {
  const { original } = state.editor;
  if (!confirm(`Delete invoice ${original.number}? This can't be undone.`)) return;
  try {
    await api(`/freeport/invoices/${encodeURIComponent(original.number)}?version=${original.version}`, { method: 'DELETE' });
    state.dirty = false;
    navigate(`/freeport?month=${original.billingMonth}`, { replace: true });
  } catch (error) {
    screen.querySelector('#formMessage').innerHTML = messageHtml(error);
  }
}

function handleEditorClick(event) {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (!action || !state.editor || !screen.querySelector('#invoiceForm')) return false;
  const { draft } = state.editor;
  const index = Number(event.target.closest('tr[data-row]')?.dataset.row);
  if (action === 'add-line') {
    draft.lines.push({ sku: '', itemId: '', description: '', quantity: '1', rate: '' });
    renderLines();
    screen.querySelector(`tr[data-row="${draft.lines.length - 1}"] select`)?.focus();
  } else if (action === 'copy-line') {
    draft.lines.splice(index + 1, 0, { ...draft.lines[index] });
    renderLines();
  } else if (action === 'remove-line') {
    draft.lines.splice(index, 1);
    renderLines();
  } else if (action === 'save-ready') {
    saveInvoice('Ready');
  } else if (action === 'save-review') {
    saveInvoice('Needs review');
  } else if (action === 'delete') {
    deleteCurrentInvoice();
  } else {
    return false;
  }
  return true;
}

screen.addEventListener('input', event => {
  if (!state.editor || !event.target.closest('#invoiceForm')) return;
  readField(event.target);
  if (event.target.dataset.lineField !== 'itemId') updateDerived();
});

screen.addEventListener('submit', event => {
  if (event.target.id !== 'invoiceForm') return;
  event.preventDefault();
  saveInvoice(state.editor.draft.status);
});

// ---------- Month close ----------

function renderConsolidatedInvoice(summary, settings) {
  const lines = text => esc(text).replace(/\n/g, '<br>');
  return `
    <article class="paper" aria-label="Consolidated invoice preview">
      <div class="paper-head">
        <div>
          <strong>${esc(settings.businessName)}</strong>
          <p>${lines(settings.businessAddress)}<br>${esc(settings.businessPhone)}</p>
        </div>
        <dl class="paper-meta">
          <dt>INVOICE</dt><dd>${esc(summary.packageNumber)}</dd>
          <dt>DATE</dt><dd>${formatDate(monthEnd(summary.month))}</dd>
          <dt>PO</dt><dd>${esc(settings.poNumber)}</dd>
        </dl>
      </div>
      <div class="paper-parties">
        <div><span>BILL TO</span><p>${lines(settings.billTo)}</p></div>
        <div><span>FOR</span><p>Contract No. ${esc(settings.contractNumber)}<br>Attn: ${formatMonth(summary.month)}<br>${summary.invoices.length} invoices</p></div>
      </div>
      <table>
        <thead><tr><th>Description</th><th class="num">Amount</th></tr></thead>
        <tbody>
          <tr><td>Parts and Materials · ${formatMonth(summary.month)}</td><td class="num">${money(summary.parts)}</td></tr>
          <tr><td>Labor · ${formatMonth(summary.month)}</td><td class="num">${money(summary.labor)}</td></tr>
        </tbody>
      </table>
      <dl class="totals">
        <dt>Subtotal</dt><dd>${money(summary.parts + summary.labor)}</dd>
        <dt>Tax (${esc(settings.taxRate)}% of parts)</dt><dd>${money(summary.tax)}</dd>
        <dt><strong>Amount due</strong></dt><dd><strong>${money(summary.total)}</strong></dd>
      </dl>
      <p class="paper-foot">LICENSED-INSURED-BONDED AZ ROC# ${esc(settings.rocNumber)} · AZ Procure Vendor ID # ${esc(settings.vendorId)}${settings.footerNote ? `<br>${esc(settings.footerNote)}` : ''}</p>
    </article>`;
}

async function renderClose(params, isCurrent) {
  const month = await monthParam(params);
  const [config, invoices] = await Promise.all([loadConfig(), api(`/freeport/invoices?month=${encodeURIComponent(month)}`)]);
  if (!isCurrent()) return;
  const summary = summarizeMonth(month, invoices, config);
  const rowCount = spreadsheetRows(summary, config).length;
  const taxDifference = summary.tax - summary.invoiceTaxTotal;
  // Each row opens its invoice on screen; the .xlsx gets plain text.
  // A divider starts each invoice; hovering any line highlights that whole invoice.
  const sheetBody = summary.invoices.map(invoice => {
    const href = `/freeport/invoices/${encodeURIComponent(invoice.number)}`;
    return spreadsheetRows({ invoices: [invoice] }, config).map((row, lineIndex) => {
      const [description, ...rest] = row.cells;
      return `<tr class="clickable ${lineIndex === 0 ? 'invoice-start' : ''} ${row.flagged ? 'flagged' : ''}" data-href="${href}" data-invoice="${esc(invoice.number)}">
        <td><a href="${href}" title="Open invoice ${esc(invoice.number)}">${esc(description)}</a></td>${rest.map(cell => `<td>${esc(cell)}</td>`).join('')}
      </tr>`;
    }).join('');
  }).join('');

  screen.innerHTML = `
    <a class="back" href="/freeport?month=${month}">← ${formatMonth(month)}</a>
    <div class="page-head">
      <div>
        <p class="eyebrow">MONTH CLOSE</p>
        <h1>${formatMonth(month)}</h1>
        <p class="muted">Package invoice number <strong>${esc(summary.packageNumber)}</strong></p>
      </div>
      <div class="actions">${stepButton(6, 'Mark sent')}</div>
    </div>

    <section class="panel checklist">
      <h2>Ready to send?</h2>
      <ul>
        <li class="${summary.invoices.length && !summary.needsReview.length ? 'done' : 'todo'}">
          ${summary.invoices.length - summary.needsReview.length} of ${summary.invoices.length} invoices ready
          ${summary.needsReview.map(invoice => `<a href="/freeport/invoices/${encodeURIComponent(invoice.number)}">${esc(invoice.number)}</a>`).join(' ')}
        </li>
        <li class="${taxDifference ? 'info' : 'done'}">
          Tax: ${money(summary.tax)} on the package (${esc(config.settings.taxRate)}% of month parts) vs ${money(summary.invoiceTaxTotal)} added up from the invoices
          ${taxDifference ? `· ${money(Math.abs(taxDifference))} difference` : '· matches'}
        </li>
        ${summary.unmatched ? `<li class="todo">${money(summary.unmatched)} of line items aren't matched to the item list, so they're left out of the totals above</li>` : ''}
      </ul>
    </section>

    <section class="panel">
      <div class="section-head">
        <div><h2>1. Consolidated invoice</h2><p class="muted">The invoice Freeport writes the check from.</p></div>
        ${stepButton(4, 'Download PDF')}
      </div>
      ${renderConsolidatedInvoice(summary, config.settings)}
    </section>

    <section class="panel">
      <div class="section-head">
        <div><h2>2. Line-item spreadsheet</h2><p class="muted">${rowCount} rows · replaces the Google Sheet · click a row to open its invoice</p></div>
        ${summary.invoices.length && !summary.needsReview.length
          ? `<button type="button" class="primary" data-action="download-xlsx" data-month="${month}">Download .xlsx</button>`
          : '<button type="button" disabled title="Every invoice must be Ready first">Download .xlsx</button>'}
      </div>
      <div id="sheetMessage"></div>
      <div class="scroll sheet">
        <table>
          <thead><tr>${SPREADSHEET_COLUMNS.map(column => `<th>${esc(column)}</th>`).join('')}</tr></thead>
          <tbody>${sheetBody}</tbody>
        </table>
      </div>
    </section>

    <section class="panel">
      <div class="section-head">
        <div><h2>3. Merged invoice PDF</h2><p class="muted">One app-generated page per invoice, in install-date order.</p></div>
        ${stepButton(5, 'Download PDF')}
      </div>
      <ol class="pages">
        ${summary.invoices.map(invoice => `<li><strong>${esc(invoice.number)}</strong> · installed ${formatDate(invoice.installDate)} · ${money(invoice.total)}</li>`).join('')}
      </ol>
    </section>`;
}

// The download goes through fetch so a refusal shows as a message, not a broken file.
function handleCloseClick(event) {
  const button = event.target.closest('[data-action="download-xlsx"]');
  if (!button) return false;
  downloadSpreadsheet(button);
  return true;
}

async function downloadSpreadsheet(button) {
  const box = screen.querySelector('#sheetMessage');
  button.disabled = true;
  try {
    const response = await fetch(`/api/freeport/months/${encodeURIComponent(button.dataset.month)}/spreadsheet.xlsx`);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const error = new Error(body.error || 'The spreadsheet could not be downloaded. Try again.');
      error.body = body;
      throw error;
    }
    const filename = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') || '')?.[1] || 'Line Items.xlsx';
    const url = URL.createObjectURL(await response.blob());
    const link = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    box.innerHTML = '';
  } catch (error) {
    box.innerHTML = messageHtml(error);
  } finally {
    button.disabled = false;
  }
}

// Hovering one spreadsheet line highlights every line of that invoice.
function highlightInvoice(number) {
  screen.querySelectorAll('.sheet tr.invoice-hover').forEach(row => row.classList.remove('invoice-hover'));
  if (number) screen.querySelectorAll(`.sheet tr[data-invoice="${CSS.escape(number)}"]`).forEach(row => row.classList.add('invoice-hover'));
}

screen.addEventListener('mouseover', event => {
  const row = event.target.closest('.sheet tr[data-invoice]');
  if (row && !row.classList.contains('invoice-hover')) highlightInvoice(row.dataset.invoice);
});

screen.addEventListener('mouseout', event => {
  if (event.target.closest('.sheet tbody') && !event.relatedTarget?.closest?.('.sheet tbody')) highlightInvoice(null);
});

// ---------- Admin ----------

const ADMIN_TABS = [['items', 'Item master list'], ['accounts', 'Account codes'], ['settings', 'Settings']];

const SETTINGS_FIELDS = [
  ['poNumber', 'PO number'], ['contractNumber', 'Contract number'], ['companyCode', 'Company code'],
  ['taxRate', 'Tax rate (% of parts)'], ['partsExpense', 'Parts expense element'], ['laborExpense', 'Labor expense element'],
  ['businessName', 'Business name'], ['businessPhone', 'Phone'], ['rocNumber', 'AZ ROC #'], ['vendorId', 'AZ Procure Vendor ID']
];
const SETTINGS_AREAS = [['businessAddress', 'Business address'], ['billTo', 'Bill to'], ['footerNote', 'Footer note']];

function select(name, options, value, disabled) {
  return `<select data-name="${name}" ${disabled}>${options.map(option => `<option ${option === value ? 'selected' : ''}>${esc(option)}</option>`).join('')}</select>`;
}

function itemRowHtml(item, disabled) {
  return `<tr data-id="${esc(item.id || '')}">
    <td><input data-name="sku" value="${esc(item.sku)}" ${disabled}></td>
    <td><input data-name="description" value="${esc(item.description)}" class="wide" ${disabled}></td>
    <td>${select('unit', ITEM_UNITS, item.unit, disabled)}</td>
    <td>${select('type', ITEM_TYPES, item.type, item.inUse ? 'disabled title="Already on saved invoices"' : disabled)}</td>
    <td><input data-name="price" value="${esc(item.customDescription && !item.priceCents ? '' : centsToInput(item.priceCents))}" inputmode="decimal" class="short" ${disabled}></td>
    <td class="center"><input type="checkbox" data-name="customDescription" ${item.customDescription ? 'checked' : ''} ${item.inUse ? 'disabled title="Already on saved invoices"' : disabled} aria-label="Description typed on each line"></td>
    <td class="center"><input type="checkbox" data-name="active" ${item.active ? 'checked' : ''} ${disabled} aria-label="Active"></td>
  </tr>`;
}

function accountRowHtml(account, disabled, isNew = false) {
  return `<tr data-new="${isNew}">
    <td><input data-name="code" value="${esc(account.code)}" ${isNew ? '' : 'readonly'} ${disabled} inputmode="numeric" class="code"></td>
    <td><input data-name="name" value="${esc(account.name)}" class="wide" ${disabled}></td>
    <td><input data-name="group" value="${esc(account.group)}" ${disabled}></td>
    <td><input data-name="usingAreaName" value="${esc(account.usingAreaName)}" ${disabled}></td>
    <td class="center"><input type="checkbox" data-name="active" ${account.active ? 'checked' : ''} ${disabled} aria-label="Active"></td>
  </tr>`;
}

async function renderAdmin(params, isCurrent) {
  const tab = ADMIN_TABS.some(([id]) => id === params.get('tab')) ? params.get('tab') : 'items';
  const [config, adminStatus] = await Promise.all([loadConfig(true), api('/admin/me')]);
  if (!isCurrent()) return;
  const isAdmin = Boolean(adminStatus.admin);
  const disabled = isAdmin ? '' : 'disabled';
  const { settings } = config;
  const tabs = ADMIN_TABS.map(([id, label]) => `<a class="tab ${tab === id ? 'active' : ''}" href="/freeport/admin?tab=${id}">${label}</a>`).join('');

  const bodies = {
    items: `
      <p class="muted">Only these items can be billed to Freeport. Invoice lines match by SKU (ELMO or Omega); when one SKU covers several sizes, the billed price picks the size. Billed prices are never changed. "Per-line description" items (windshields, special-order parts) get their spreadsheet description typed on each invoice line; leave the list price blank if it varies. Once an item is on saved invoices its type and per-line setting are fixed; add a new item instead.</p>
      <div class="scroll"><table class="admin-table">
        <thead><tr><th>SKU</th><th>Freeport description (spreadsheet)</th><th>Unit</th><th>Type</th><th>List price</th><th title="The description is typed on each invoice line, e.g. a windshield part number">Per-line description</th><th>Active</th></tr></thead>
        <tbody id="adminRows">${config.items.map(item => itemRowHtml(item, disabled)).join('')}</tbody>
      </table></div>
      ${isAdmin ? '<div class="bar"><button type="button" data-action="add-item">Add item</button><button type="button" class="primary" data-action="save-items">Save items</button></div>' : ''}`,
    accounts: `
      <p class="muted">Chosen per invoice based on where the job took place. "Using area name" fills that spreadsheet column.</p>
      <div class="scroll"><table class="admin-table">
        <thead><tr><th>Code</th><th>Name</th><th>Area</th><th>Using area name</th><th>Active</th></tr></thead>
        <tbody id="adminRows">${config.accounts.map(account => accountRowHtml(account, disabled)).join('')}</tbody>
      </table></div>
      ${isAdmin ? '<div class="bar"><button type="button" data-action="add-account">Add account</button><button type="button" class="primary" data-action="save-accounts">Save accounts</button></div>' : ''}`,
    settings: `
      <form id="settingsForm" class="grid">
        ${SETTINGS_FIELDS.map(([key, label]) => `<label>${esc(label)}<input data-name="${key}" value="${esc(settings[key])}" ${disabled}></label>`).join('')}
        ${SETTINGS_AREAS.map(([key, label]) => `<label>${esc(label)}<textarea data-name="${key}" ${disabled}>${esc(settings[key])}</textarea></label>`).join('')}
      </form>
      ${isAdmin ? '<div class="bar"><button type="button" class="primary" data-action="save-settings">Save settings</button></div>' : ''}`
  };

  screen.innerHTML = `
    <div class="page-head">
      <div><p class="eyebrow">FREEPORT</p><h1>Admin</h1></div>
      ${isAdmin ? '<div class="actions"><span class="badge ok">Unlocked</span><button type="button" data-action="admin-lock">Lock</button></div>' : ''}
    </div>
    ${isAdmin ? '' : `
      <form id="adminUnlock" class="panel unlock">
        <p><strong>View only.</strong> Editing needs the administrator login (the same one as Master Lists).</p>
        <div class="bar">
          <label>Admin username<input name="username" autocomplete="username"></label>
          <label>Password<input name="password" type="password" autocomplete="current-password"></label>
          <button class="primary">Unlock</button>
        </div>
      </form>`}
    <div id="adminMessage"></div>
    <nav class="tabs">${tabs}</nav>
    <section class="panel" data-tab="${tab}">${bodies[tab]}</section>`;
}

function readRows(mapper) {
  return [...screen.querySelectorAll('#adminRows tr')].map(row => {
    const value = name => row.querySelector(`[data-name="${name}"]`);
    return mapper(row, name => value(name).type === 'checkbox' ? value(name).checked : value(name).value);
  });
}

async function adminSave(path, body, tab) {
  const box = screen.querySelector('#adminMessage');
  // One save at a time; a double click would otherwise add new rows twice.
  const buttons = screen.querySelectorAll('[data-action]');
  buttons.forEach(button => { button.disabled = true; });
  try {
    state.config = await api(path, { method: 'PUT', body });
  } catch (error) {
    buttons.forEach(button => { button.disabled = false; });
    box.innerHTML = messageHtml(error);
    box.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return;
  }
  const renderId = ++state.renderId;
  await renderAdmin(new URLSearchParams({ tab }), () => renderId === state.renderId);
  screen.querySelector('#adminMessage')?.insertAdjacentHTML('beforeend', '<div class="alert success" role="status">Saved.</div>');
}

const ADMIN_ACTIONS = ['add-item', 'add-account', 'save-items', 'save-accounts', 'save-settings', 'admin-lock'];

// Decides synchronously so link clicks can still be intercepted; the work runs after.
function handleAdminClick(event) {
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (!ADMIN_ACTIONS.includes(action) || !screen.querySelector('.tabs')) return false;
  runAdminAction(action);
  return true;
}

async function runAdminAction(action) {
  const rows = screen.querySelector('#adminRows');
  if (action === 'add-item') {
    rows.insertAdjacentHTML('beforeend', itemRowHtml({ sku: '', description: '', unit: 'ea', type: 'Parts', priceCents: null, customDescription: false, active: true }, ''));
    rows.lastElementChild.querySelector('input').focus();
  } else if (action === 'add-account') {
    rows.insertAdjacentHTML('beforeend', accountRowHtml({ code: '', name: '', group: '', usingAreaName: 'Mine Maintenance', active: true }, '', true));
    rows.lastElementChild.querySelector('input').focus();
  } else if (action === 'save-items') {
    const items = readRows((row, get) => {
      const customDescription = get('customDescription');
      // A per-line description item may leave its price blank: priced on each line.
      const priceCents = customDescription && !get('price').trim() ? 0 : parseMoney(get('price'));
      return { id: row.dataset.id, sku: get('sku'), description: get('description'), unit: get('unit'), type: get('type'), priceCents, customDescription, active: get('active') };
    });
    const badPrice = items.findIndex(item => item.priceCents === null);
    if (badPrice >= 0) {
      screen.querySelector('#adminMessage').innerHTML = messageHtml(new Error(`Item row ${badPrice + 1}: enter a list price like 125.00.`));
      return;
    }
    await adminSave('/freeport/items', { items }, 'items');
  } else if (action === 'save-accounts') {
    const accounts = readRows((row, get) => ({ code: get('code'), name: get('name'), group: get('group'), usingAreaName: get('usingAreaName'), active: get('active') }));
    await adminSave('/freeport/accounts', { accounts }, 'accounts');
  } else if (action === 'save-settings') {
    const settings = Object.fromEntries([...screen.querySelectorAll('#settingsForm [data-name]')].map(field => [field.dataset.name, field.value]));
    await adminSave('/freeport/settings', settings, 'settings');
  } else if (action === 'admin-lock') {
    await api('/admin/logout', { method: 'POST' });
    render();
  }
}

screen.addEventListener('submit', async event => {
  if (event.target.id !== 'adminUnlock') return;
  event.preventDefault();
  const form = new FormData(event.target);
  try {
    await api('/admin/login', { method: 'POST', body: { username: form.get('username'), password: form.get('password') } });
    render();
  } catch (error) {
    screen.querySelector('#adminMessage').innerHTML = messageHtml(error);
  }
});

// ---------- Routing ----------

// Phones (portrait or landscape) get the Order Tracker only; Freeport needs a computer.
const PHONE_QUERY = '(max-width: 760px), (max-height: 500px) and (pointer: coarse)';

function renderPhoneNotice() {
  document.querySelectorAll('[data-nav]').forEach(link => link.remove());
  screen.innerHTML = `
    <section class="panel phone-notice">
      <h1>Use a computer for Freeport Billing</h1>
      <p class="muted">Freeport Billing isn't available on phones. The Order Tracker works here.</p>
      <div class="actions"><a class="button primary" href="/app">Open Order Tracker</a><a class="button" href="/">Tools Home</a></div>
    </section>`;
}

// Each render gets a token; a slower earlier render that finishes late is dropped.
async function render() {
  if (matchMedia(PHONE_QUERY).matches) {
    renderPhoneNotice();
    return;
  }
  const renderId = ++state.renderId;
  const isCurrent = () => renderId === state.renderId;
  const { pathname, searchParams } = new URL(location.href);
  const invoiceMatch = pathname.match(/^\/freeport\/invoices\/([^/]+)$/);
  const section = pathname === '/freeport/admin' ? 'admin' : 'month';
  document.querySelectorAll('[data-nav]').forEach(link => link.classList.toggle('active', link.dataset.nav === section));
  state.editor = null;
  state.dirty = false;
  try {
    if (invoiceMatch && invoiceMatch[1] === 'new') await renderInvoice(null, searchParams, isCurrent);
    else if (invoiceMatch) await renderInvoice(decodeURIComponent(invoiceMatch[1]), searchParams, isCurrent);
    else if (pathname === '/freeport/close') await renderClose(searchParams, isCurrent);
    else if (section === 'admin') await renderAdmin(searchParams, isCurrent);
    else await renderMonth(searchParams, isCurrent);
  } catch (error) {
    if (!isCurrent()) return;
    screen.innerHTML = `${messageHtml(error)}<p><a href="/freeport">Back to Freeport</a></p>`;
  }
}

function confirmLeave() {
  return !state.dirty || confirm('You have unsaved changes. Leave without saving?');
}

function navigate(href, { replace = false } = {}) {
  if (!replace && !confirmLeave()) return;
  state.dirty = false;
  history[replace ? 'replaceState' : 'pushState'](null, '', href);
  state.currentUrl = href;
  window.scrollTo(0, 0);
  render();
}

document.addEventListener('click', event => {
  if (handleEditorClick(event) || handleAdminClick(event) || handleCloseClick(event)) return;
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
  const link = event.target.closest('a[href^="/freeport"]');
  const row = !link && event.target.closest('tr[data-href]');
  if (link) {
    event.preventDefault();
    navigate(link.getAttribute('href'));
  } else if (row) {
    navigate(row.dataset.href);
  }
});

window.addEventListener('popstate', () => {
  if (!confirmLeave()) {
    history.pushState(null, '', state.currentUrl);
    return;
  }
  state.currentUrl = location.pathname + location.search;
  render();
});

window.addEventListener('beforeunload', event => {
  if (state.dirty) event.preventDefault();
});

const me = await api('/me');
document.getElementById('user').textContent = me.user.full_name;
render();
