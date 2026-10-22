import * as sample from './freeport-sample.js';

const SPREADSHEET_COLUMNS = [
  'DESCRIPTION', 'Classification', 'QUANTITY', 'UNIT OF MEASURE', 'UNIT RATE', 'TYPE', 'COMPANY CODE',
  'ORDER NUMBER', 'WBS ELEMENT', 'ACCOUNT CODE', 'Cash Pay', 'EXPENSE ELEMENT', 'SUPPLIER REFERENCE',
  'USING AREA NAME', 'PO NUMBER'
];

const screen = document.getElementById('screen');

// ---------- Formatting ----------

const moneyFormat = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const money = cents => moneyFormat.format(cents / 100);
const toCents = value => Math.round(Number(value) * 100);

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function parseDate(iso) {
  const [year, month, day] = iso.split('-').map(Number);
  return new Date(year, month - 1, day || 1);
}

const formatDate = iso => parseDate(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const formatMonth = month => parseDate(month).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

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

// ---------- Billing math ----------

function taxOnParts(partsCents) {
  return Math.round(partsCents * Number(sample.settings.taxRate) / 100);
}

// SKUs that cover several sizes are matched by billed price until each size has its own SKU.
function matchLine(line) {
  const candidates = sample.items.filter(item => item.sku === line.sku);
  const total = Math.round(Number(line.quantity) * toCents(line.rate));
  if (!candidates.length) {
    return { ...line, total, item: null, issue: 'SKU is not on the item master list' };
  }
  if (candidates.length > 1) {
    const item = candidates.find(candidate => toCents(candidate.price) === toCents(line.rate));
    return item
      ? { ...line, total, item }
      : { ...line, total, item: null, issue: `Price matches no ${line.sku} size; pick one` };
  }
  const [item] = candidates;
  const issue = toCents(item.price) === toCents(line.rate) ? '' : `Billed price differs from list price ${money(toCents(item.price))}`;
  return { ...line, total, item, issue };
}

function summarizeInvoice(invoice) {
  const lines = invoice.lines.map(matchLine);
  const parts = lines.filter(line => line.item?.type === 'Parts').reduce((sum, line) => sum + line.total, 0);
  const labor = lines.filter(line => line.item?.type === 'Labor').reduce((sum, line) => sum + line.total, 0);
  const unmatched = lines.filter(line => !line.item).reduce((sum, line) => sum + line.total, 0);
  const omegaTax = taxOnParts(parts);
  return {
    ...invoice,
    lines,
    parts,
    labor,
    unmatched,
    omegaTax,
    total: parts + labor + unmatched + omegaTax,
    issues: lines.filter(line => line.issue).length,
    account: sample.accountCodes.find(account => account.code === invoice.accountCode)
  };
}

function summarizeMonth(month) {
  const invoices = sample.invoices
    .filter(invoice => invoice.month === month)
    .sort((a, b) => a.installDate.localeCompare(b.installDate))
    .map(summarizeInvoice);
  const parts = invoices.reduce((sum, invoice) => sum + invoice.parts, 0);
  const labor = invoices.reduce((sum, invoice) => sum + invoice.labor, 0);
  const tax = taxOnParts(parts);
  const record = sample.months[month] || { status: 'Open', revision: 0 };
  return {
    month,
    invoices,
    parts,
    labor,
    tax,
    omegaTax: invoices.reduce((sum, invoice) => sum + invoice.omegaTax, 0),
    total: parts + labor + tax,
    needsReview: invoices.filter(invoice => invoice.status !== 'Ready'),
    record,
    invoiceNumber: `FMI-${month}${record.revision ? `-R${record.revision}` : ''}`
  };
}

function spreadsheetRows(summary) {
  const { settings } = sample;
  return summary.invoices.flatMap(invoice => invoice.lines.map(line => ({
    unmatched: !line.item,
    cells: [
      line.item?.description ?? line.sku, '', line.quantity, line.item?.unit ?? '', line.rate, 'Work Order',
      settings.companyCode, invoice.orderNumber, '', invoice.accountCode, '',
      line.item ? (line.item.type === 'Labor' ? settings.laborExpense : settings.partsExpense) : '',
      invoice.number, settings.usingAreaName, settings.poNumber
    ]
  })));
}

// ---------- Shared pieces ----------

const statusBadge = status => `<span class="badge ${status === 'Ready' || status === 'Sent' ? 'ok' : 'review'}">${esc(status)}</span>`;

const stepNote = (step, label) => `<button disabled title="Arrives in build step ${step}">${esc(label)}</button>`;

function metric(label, value, note = '') {
  return `<div class="metric"><span>${esc(label)}</span><b>${value}</b>${note ? `<small>${note}</small>` : ''}</div>`;
}

function defaultMonth() {
  return Object.keys(sample.months).sort().reverse().find(month => sample.months[month].status === 'Open')
    || new Date().toISOString().slice(0, 7);
}

// ---------- Month view ----------

function renderMonth(params) {
  const month = params.get('month') || defaultMonth();
  const summary = summarizeMonth(month);
  const rows = summary.invoices.map(invoice => {
    const lateInvoice = invoice.omegaDate.slice(0, 7) !== invoice.month;
    return `
      <tr class="clickable" data-href="/freeport/invoices/${esc(invoice.number)}">
        <td><a href="/freeport/invoices/${esc(invoice.number)}"><strong>${esc(invoice.number)}</strong></a></td>
        <td>${formatDate(invoice.installDate)}</td>
        <td>${formatDate(invoice.omegaDate)}${lateInvoice ? ' <span class="badge info" title="Billed by install date">Later month</span>' : ''}</td>
        <td>${esc(invoice.orderNumber)}</td>
        <td>${esc(invoice.account?.name ?? invoice.accountCode)}<small class="block">${esc(invoice.accountCode)}</small></td>
        <td class="num">${money(invoice.parts)}</td>
        <td class="num">${money(invoice.labor)}</td>
        <td class="num">${money(invoice.omegaTax)}</td>
        <td class="num">${money(invoice.total)}</td>
        <td>${statusBadge(invoice.status)}${invoice.issues ? `<small class="block warn">${invoice.issues} flagged line${invoice.issues > 1 ? 's' : ''}</small>` : ''}</td>
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
          ${statusBadge(summary.record.status)}
        </div>
      </div>
      <div class="actions">
        ${stepNote(7, 'Import Omega report')}
        ${stepNote(2, 'Add invoice')}
        <a class="button primary" href="/freeport/close?month=${month}">Month close →</a>
      </div>
    </div>

    <section class="metrics-row">
      ${metric('Invoices', summary.invoices.length, summary.needsReview.length ? `<span class="warn">${summary.needsReview.length} need review</span>` : 'All ready')}
      ${metric('Parts', money(summary.parts))}
      ${metric('Labor', money(summary.labor))}
      ${metric(`Tax (${sample.settings.taxRate}% of parts)`, money(summary.tax))}
      ${metric('Month total', money(summary.total))}
    </section>

    <section class="panel">
      ${summary.invoices.length ? `
        <div class="scroll">
          <table class="invoice-table">
            <thead><tr>
              <th>Invoice #</th><th>Install date</th><th>Omega date</th><th>Order #</th><th>Account</th>
              <th class="num">Parts</th><th class="num">Labor</th><th class="num">Omega tax</th><th class="num">Total</th><th>Status</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>` : `<p class="empty">No invoices billed to ${formatMonth(month)} yet.</p>`}
    </section>`;
}

// ---------- Invoice record ----------

function renderInvoice(number) {
  const raw = sample.invoices.find(invoice => invoice.number === number);
  if (!raw) {
    screen.innerHTML = `<p class="empty">Invoice ${esc(number)} was not found. <a href="/freeport">Back to months</a></p>`;
    return;
  }
  const invoice = summarizeInvoice(raw);
  const lateInvoice = invoice.omegaDate.slice(0, 7) !== invoice.month;
  const accountOptions = sample.accountCodes.map(account =>
    `<option value="${account.code}" ${account.code === invoice.accountCode ? 'selected' : ''}>${esc(account.code)} · ${esc(account.name)}</option>`).join('');
  const lineRows = invoice.lines.map(line => `
    <tr class="${line.issue ? 'flagged' : ''}">
      <td>${esc(line.sku)}</td>
      <td>${line.item ? esc(line.item.description) : '<em>Not matched</em>'}</td>
      <td class="num">${esc(line.quantity)}</td>
      <td>${esc(line.item?.unit ?? '')}</td>
      <td class="num">${money(toCents(line.rate))}</td>
      <td class="num">${money(line.total)}</td>
      <td>${esc(line.item?.type ?? '')}</td>
      <td>${line.item ? (line.item.type === 'Labor' ? sample.settings.laborExpense : sample.settings.partsExpense) : ''}</td>
      <td>${line.issue ? `<span class="warn">${esc(line.issue)}</span>` : '<span class="ok-text">OK</span>'}</td>
    </tr>`).join('');

  screen.innerHTML = `
    <a class="back" href="/freeport?month=${invoice.month}">← ${formatMonth(invoice.month)}</a>
    <div class="page-head">
      <div>
        <p class="eyebrow">OMEGA INVOICE</p>
        <h1>Invoice ${esc(invoice.number)} ${statusBadge(invoice.status)}</h1>
      </div>
      <div class="actions">
        ${stepNote(2, 'Mark ready')}
        ${stepNote(2, 'Save')}
      </div>
    </div>

    ${lateInvoice ? `<p class="notice">Omega dated this invoice ${formatDate(invoice.omegaDate)}. It's billed in <strong>${formatMonth(invoice.month)}</strong> because it was installed ${formatDate(invoice.installDate)}.</p>` : ''}

    <section class="panel">
      <h2>Details</h2>
      <div class="grid">
        <label>Omega invoice #<input value="${esc(invoice.number)}" disabled></label>
        <label>Omega invoice date<input type="date" value="${invoice.omegaDate}" disabled></label>
        <label>Install date<input type="date" value="${invoice.installDate}" disabled></label>
        <label>Billing month<input type="month" value="${invoice.month}" disabled></label>
        <label>Order number<input value="${esc(invoice.orderNumber)}" disabled></label>
        <label class="span-2">Account code<select disabled>${accountOptions}</select></label>
        <label class="span-2">Google Drive folder (work order and photos)<input placeholder="Paste folder link" disabled></label>
      </div>
    </section>

    <section class="panel">
      <h2>Line items</h2>
      <div class="scroll">
        <table>
          <thead><tr>
            <th>Omega SKU</th><th>Freeport description</th><th class="num">Qty</th><th>Unit</th><th class="num">Rate</th>
            <th class="num">Line total</th><th>Type</th><th>Expense element</th><th>Check</th>
          </tr></thead>
          <tbody>${lineRows}</tbody>
        </table>
      </div>
      <dl class="totals">
        <dt>Parts</dt><dd>${money(invoice.parts)}</dd>
        <dt>Labor</dt><dd>${money(invoice.labor)}</dd>
        ${invoice.unmatched ? `<dt class="warn">Not matched</dt><dd class="warn">${money(invoice.unmatched)}</dd>` : ''}
        <dt>Omega tax</dt><dd>${money(invoice.omegaTax)}</dd>
        <dt><strong>Total</strong></dt><dd><strong>${money(invoice.total)}</strong></dd>
      </dl>
    </section>`;
}

// ---------- Month close ----------

function renderConsolidatedInvoice(summary) {
  const { settings } = sample;
  return `
    <article class="paper" aria-label="Consolidated invoice preview">
      <div class="paper-head">
        <div>
          <strong>${esc(settings.businessName)}</strong>
          <p>${esc(settings.businessAddress).replace(/\n/g, '<br>')}<br>${esc(settings.businessPhone)}</p>
        </div>
        <dl class="paper-meta">
          <dt>INVOICE</dt><dd>${esc(summary.invoiceNumber)}</dd>
          <dt>DATE</dt><dd>${formatDate(monthEnd(summary.month))}</dd>
          <dt>PO</dt><dd>${esc(settings.poNumber)}</dd>
        </dl>
      </div>
      <div class="paper-parties">
        <div><span>BILL TO</span><p>${esc(settings.billTo).replace(/\n/g, '<br>')}</p></div>
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
      <p class="paper-foot">LICENSED-INSURED-BONDED AZ ROC# ${esc(settings.rocNumber)} · AZ Procure Vendor ID # ${esc(settings.vendorId)}</p>
    </article>`;
}

function renderClose(params) {
  const month = params.get('month') || defaultMonth();
  const summary = summarizeMonth(month);
  const sent = summary.record.status === 'Sent';
  const rows = spreadsheetRows(summary);
  const taxDifference = summary.tax - summary.omegaTax;

  screen.innerHTML = `
    <a class="back" href="/freeport?month=${month}">← ${formatMonth(month)}</a>
    <div class="page-head">
      <div>
        <p class="eyebrow">MONTH CLOSE</p>
        <h1>${formatMonth(month)} ${statusBadge(summary.record.status)}</h1>
        <p class="muted">Package invoice number <strong>${esc(summary.invoiceNumber)}</strong>${sent ? ` · sent ${formatDate(summary.record.sentOn)}` : ''}</p>
      </div>
      <div class="actions">
        ${sent ? stepNote(6, 'Start correction (R1)') : stepNote(6, 'Mark sent')}
      </div>
    </div>

    <section class="panel checklist">
      <h2>Ready to send?</h2>
      <ul>
        <li class="${summary.needsReview.length ? 'todo' : 'done'}">
          ${summary.invoices.length - summary.needsReview.length} of ${summary.invoices.length} invoices ready
          ${summary.needsReview.map(invoice => `<a href="/freeport/invoices/${esc(invoice.number)}">${esc(invoice.number)}</a>`).join(' ')}
        </li>
        <li class="${taxDifference ? 'info' : 'done'}">
          Tax: ${money(summary.tax)} on this invoice (${sample.settings.taxRate}% of month parts) vs ${money(summary.omegaTax)} added up from Omega invoices
          ${taxDifference ? `· ${money(Math.abs(taxDifference))} rounding difference` : '· matches'}
        </li>
      </ul>
    </section>

    <section class="panel">
      <div class="section-head">
        <div><h2>1. Consolidated invoice</h2><p class="muted">The invoice Freeport writes the check from.</p></div>
        ${stepNote(4, 'Download PDF')}
      </div>
      ${renderConsolidatedInvoice(summary)}
    </section>

    <section class="panel">
      <div class="section-head">
        <div><h2>2. Line-item spreadsheet</h2><p class="muted">${rows.length} rows · replaces the Google Sheet</p></div>
        ${stepNote(3, 'Download .xlsx')}
      </div>
      <div class="scroll sheet">
        <table>
          <thead><tr>${SPREADSHEET_COLUMNS.map(column => `<th>${esc(column)}</th>`).join('')}</tr></thead>
          <tbody>${rows.map(row => `<tr class="${row.unmatched ? 'flagged' : ''}">${row.cells.map(cell => `<td>${esc(cell)}</td>`).join('')}</tr>`).join('')}</tbody>
        </table>
      </div>
    </section>

    <section class="panel">
      <div class="section-head">
        <div><h2>3. Merged invoice PDF</h2><p class="muted">One app-generated page per invoice, in install-date order.</p></div>
        ${stepNote(5, 'Download PDF')}
      </div>
      <ol class="pages">
        ${summary.invoices.map(invoice => `<li><strong>${esc(invoice.number)}</strong> · installed ${formatDate(invoice.installDate)} · ${money(invoice.total)}</li>`).join('')}
      </ol>
    </section>`;
}

// ---------- Admin ----------

function renderAdmin(params) {
  const tab = params.get('tab') || 'items';
  const { settings } = sample;
  const tabs = [['items', 'Item master list'], ['accounts', 'Account codes'], ['settings', 'Settings']]
    .map(([id, label]) => `<a class="tab ${tab === id ? 'active' : ''}" href="/freeport/admin?tab=${id}">${label}</a>`).join('');

  const bodies = {
    items: `
      <p class="muted">Only these items can appear on Freeport invoices. Billed prices are never changed; a different price is flagged for review.</p>
      <div class="scroll"><table>
        <thead><tr><th>Omega SKU</th><th>Freeport description</th><th>Unit</th><th>Type</th><th>Expense element</th><th class="num">List price</th></tr></thead>
        <tbody>${sample.items.map(item => `<tr>
          <td>${esc(item.sku)}</td><td>${esc(item.description)}</td><td>${esc(item.unit)}</td><td>${esc(item.type)}</td>
          <td>${item.type === 'Labor' ? settings.laborExpense : settings.partsExpense}</td><td class="num">${money(toCents(item.price))}</td>
        </tr>`).join('')}</tbody>
      </table></div>`,
    accounts: `
      <p class="muted">Chosen per invoice based on where the job took place.</p>
      <div class="scroll"><table>
        <thead><tr><th>Code</th><th>Name</th><th>Area</th></tr></thead>
        <tbody>${sample.accountCodes.map(account => `<tr><td>${esc(account.code)}</td><td>${esc(account.name)}</td><td>${esc(account.group)}</td></tr>`).join('')}</tbody>
      </table></div>`,
    settings: `
      <div class="grid">
        ${[
          ['PO number', settings.poNumber], ['Contract number', settings.contractNumber], ['Company code', settings.companyCode],
          ['Tax rate (% of parts)', settings.taxRate], ['Parts expense element', settings.partsExpense], ['Labor expense element', settings.laborExpense],
          ['Using area name', settings.usingAreaName], ['Business name', settings.businessName], ['Phone', settings.businessPhone],
          ['AZ ROC #', settings.rocNumber], ['AZ Procure Vendor ID', settings.vendorId]
        ].map(([label, value]) => `<label>${esc(label)}<input value="${esc(value)}" disabled></label>`).join('')}
        <label>Business address<textarea disabled>${esc(settings.businessAddress)}</textarea></label>
        <label>Bill to<textarea disabled>${esc(settings.billTo)}</textarea></label>
      </div>`
  };

  screen.innerHTML = `
    <div class="page-head">
      <div><p class="eyebrow">FREEPORT ADMIN</p><h1>Admin</h1></div>
      <div class="actions">${stepNote(2, 'Edit')}</div>
    </div>
    <nav class="tabs">${tabs}</nav>
    <section class="panel">${bodies[tab] ?? bodies.items}</section>`;
}

// ---------- Routing ----------

function render() {
  const { pathname, searchParams } = new URL(location.href);
  const invoiceMatch = pathname.match(/^\/freeport\/invoices\/([^/]+)$/);
  let section = 'month';
  if (invoiceMatch) renderInvoice(decodeURIComponent(invoiceMatch[1]));
  else if (pathname === '/freeport/close') renderClose(searchParams);
  else if (pathname === '/freeport/admin') { section = 'admin'; renderAdmin(searchParams); }
  else renderMonth(searchParams);
  document.querySelectorAll('[data-nav]').forEach(link => link.classList.toggle('active', link.dataset.nav === section));
  window.scrollTo(0, 0);
}

function navigate(href) {
  history.pushState(null, '', href);
  render();
}

document.addEventListener('click', event => {
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

window.addEventListener('popstate', render);

const me = await fetch('/api/me');
if (!me.ok) {
  location.href = `/login?next=${encodeURIComponent(location.pathname + location.search)}`;
} else {
  document.getElementById('user').textContent = (await me.json()).user.full_name;
  render();
}
