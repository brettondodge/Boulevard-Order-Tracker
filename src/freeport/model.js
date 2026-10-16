import Decimal from 'decimal.js';
import { fail } from './store.js';
export const columns = ['DESCRIPTION','Classification','QUANTITY','UNIT OF MEASURE','UNIT RATE','TYPE','COMPANY CODE','ORDER NUMBER','WBS ELEMENT','ACCOUNT CODE','Cash Pay','EXPENSE ELEMENT','SUPPLIER REFERENCE','USING AREA NAME','PO NUMBER'];
export const cents = value => {
  if (value === '' || value === null || value === undefined) throw fail(400, 'A financial value is missing.');
  let n; try { n = new Decimal(value); } catch { throw fail(400, 'Invalid decimal value.'); }
  if (!n.isFinite() || n.abs().gt('1000000000')) throw fail(400, 'Financial value outside supported range.');
  return n.mul(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();
};
export const money = value => new Decimal(value).div(100).toFixed(2);
export function monthEnd(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || '')) throw fail(400, 'Use a billing month in YYYY-MM format.');
  const [year,m] = month.split('-').map(Number);
  if (year < 2000 || year > 2199) throw fail(400, 'Billing year must be 2000–2199.');
  return `${month}-${new Date(Date.UTC(year, m, 0)).getUTCDate()}`;
}
export function lineAmount(line) { return cents(new Decimal(line.quantity).mul(line.rate)); }
export function normalizeJob(input, original = null) {
  const job = structuredClone(input);
  job.invoiceNumber = String(job.invoiceNumber || '').trim();
  job.sourceCompany = String(job.sourceCompany || 'Boulevard Glass LLC').trim();
  job.sourceSystem = String(job.sourceSystem || 'Manual').trim();
  if (!job.invoiceNumber || !job.sourceCompany || !['Invoice','Quote','Unknown'].includes(job.documentType)) throw fail(400, 'Invoice identifier, company and document type are required.');
  if (job.month) monthEnd(job.month);
  if (!Array.isArray(job.lines) || job.lines.length > 500) throw fail(400, 'Provide at most 500 charge rows.');
  job.lines.forEach((line, index) => {
    line.row = index + 1;
    line.quantity = String(line.quantity ?? ''); line.rate = String(line.rate ?? '');
    if (line.quantity !== '' && line.rate !== '') lineAmount(line);
    if (line.amount !== '' && line.amount != null) cents(line.amount);
  });
  for (const field of ['subtotal','tax','total']) if (job[field] !== '' && job[field] != null) cents(job[field]);
  // Source evidence is immutable. Corrections live in the review model and audit.
  if (original) { job.source = original.source; job.fileId = original.fileId; job.pages = original.pages; job.importHash = original.importHash; job.attachments = original.attachments || []; }
  return job;
}
export function jobIssues(job) {
  const issues = [];
  const add = (key, message, financial = false) => issues.push({ key, message, financial });
  if (job.documentType !== 'Invoice') add('document', 'Only invoices can be billed.');
  if (!job.reviewed) add('source-review', 'Review the source document and confirm extraction/manual entry.');
  if (!job.invoiceDate) add('date', 'Original invoice date is missing.');
  for (const key of ['orderNumber','accountCode','usingArea']) if (!String(job[key] || '').trim()) add(key, `${key} is required; explicitly review the source mapping.`);
  if (!job.lines.length) add('lines', 'No charge rows.');
  let parts = 0, labor = 0;
  job.lines.forEach((line,i) => {
    const prefix = `line-${i+1}`;
    if (!['Parts','Labor','Informational'].includes(line.classification)) add(`${prefix}-mapping`, `Row ${i+1}: choose Parts, Labor, or Informational.`);
    if (!line.exportDescription) add(`${prefix}-description`, `Row ${i+1}: export description is missing.`);
    if (!line.unit) add(`${prefix}-unit`, `Row ${i+1}: source unit is missing.`);
    if (!line.mappingReviewed) add(`${prefix}-review`, `Row ${i+1}: mapping/units require review.`);
    if (line.quantity === '' || line.rate === '' || line.amount === '' || line.amount == null) { add(`${prefix}-amount`, `Row ${i+1}: quantity, billed rate and extended amount are required.`); return; }
    const amount = cents(line.amount);
    if (lineAmount(line) !== amount && !job.decisions?.[`${prefix}-extension`]?.reason) add(`${prefix}-extension`, `Row ${i+1}: quantity × billed rate differs from the source extended amount.`, true);
    if (line.classification === 'Parts') parts += amount;
    if (line.classification === 'Labor') labor += amount;
    if (line.classification === 'Informational' && amount !== 0) add(`${prefix}-nonzero`, `Row ${i+1}: informational rows must be zero.`);
  });
  for (const key of ['subtotal','tax','total']) if (job[key] === '' || job[key] == null) add(key, `Source ${key} is missing.`);
  if (job.subtotal !== '' && job.subtotal != null && cents(job.subtotal) !== parts+labor && !job.decisions?.subtotal?.reason) add('subtotal', 'Mapped charge rows differ from source subtotal.', true);
  if ([job.subtotal,job.tax,job.total].every(x => x !== '' && x != null) && cents(job.subtotal)+cents(job.tax) !== cents(job.total) && !job.decisions?.total?.reason) add('total', 'Source subtotal plus source tax differs from source total.', true);
  if (job.correction && !job.correction.reason) add('correction', 'Financial correction requires an explanation; Omega is unchanged.');
  return { issues, parts, labor };
}
export function exportRows(jobs, settings) {
  return jobs.flatMap(job => job.lines.filter(line => line.classification !== 'Informational').map(line => [
    line.exportDescription, line.exportClassification || '', Number(line.quantity), line.unit, Number(line.rate), 'Work Order', String(settings.companyCode), String(job.orderNumber), job.wbs || '', String(job.accountCode), job.cashPay || '', String(line.expense || (line.classification === 'Labor' ? settings.laborExpense : settings.partsExpense)), String(job.invoiceNumber), job.usingArea, String(settings.spreadsheetPO)
  ]));
}
export function reconcile(jobs, settings, pkg) {
  let parts=0,labor=0,sourceTax=0,sourceTotal=0;
  const issues=[];
  if (!jobs.length) issues.push({ key:'empty',message:'Select at least one invoice.' });
  for (const job of jobs) {
    const review = jobIssues(job); parts+=review.parts; labor+=review.labor;
    issues.push(...review.issues.map(issue => ({...issue, jobId:job.id})));
    const originalTax=job.source?.tax !== '' && job.source?.tax != null ? job.source.tax : job.tax;
    const originalTotal=job.source?.total !== '' && job.source?.total != null ? job.source.total : job.total;
    if (originalTax !== '' && originalTax != null) sourceTax+=cents(originalTax);
    if (originalTotal !== '' && originalTotal != null) sourceTotal+=cents(originalTotal);
  }
  const monthlyTax = new Decimal(parts).mul(settings.taxRate).toDecimalPlaces(0,Decimal.ROUND_HALF_UP).toNumber();
  const selectedTax = pkg.taxMethod === 'monthly' ? monthlyTax : pkg.taxMethod === 'manual' ? cents(pkg.manualTax) : sourceTax;
  const total=parts+labor+selectedTax;
  const exportSubtotal=jobs.reduce((sum,job)=>sum+job.lines.filter(l=>l.classification!=='Informational'&&l.quantity!==''&&l.rate!=='').reduce((n,l)=>n+lineAmount(l),0),0);
  const exportDifference=exportSubtotal-parts-labor;
  if(exportDifference!==0 && !pkg.taxDecision?.reason) issues.push({key:'export-amount',message:'Spreadsheet quantities/rates differ from source extended amounts; explicitly review this consequence.',financial:true});
  if ((monthlyTax !== sourceTax || total !== sourceTotal || pkg.taxMethod !== 'source') && !pkg.taxDecision?.reason) issues.push({ key:'tax',message:'Explicitly choose and explain tax/allocation differences.',financial:true });
  if (!settings.remittance?.trim()) issues.push({key:'remittance',message:'Administrator must enter business/remittance information.'});
  return {parts,labor,subtotal:parts+labor,exportSubtotal,exportDifference,sourceTax,monthlyTax,selectedTax,total,sourceTotal,difference:total-sourceTotal,issues};
}
export function timing(jobs) {
  let actual=new Decimal(0), onsite=new Decimal(0), billed=new Decimal(0), actualCoverage=0, onsiteCoverage=0;
  for (const job of jobs) {
    const t=job.timing || {};
    for (const [manual,start,end,target] of [['actualHours','requestAt','completedAt','actual'],['onsiteHours','onsiteStart','onsiteEnd','onsite']]) {
      let value=null;
      if (t[start] && t[end]) { const elapsed=(Date.parse(t[end])-Date.parse(t[start]))/3600000; if (Number.isFinite(elapsed) && elapsed>=0) value=new Decimal(elapsed); }
      else if (t[manual] !== '' && t[manual] != null && t.source) { try { const n=new Decimal(t[manual]); if(n.isFinite() && n.gte(0)) value=n; } catch {} }
      if(value!==null) { if(target==='actual') {actual=actual.add(value);actualCoverage++;} else {onsite=onsite.add(value);onsiteCoverage++;} }
    }
    for(const line of job.lines) if(line.classification==='Labor' && /^(hr|hrs|hour|hours)$/i.test(line.unit)) billed=billed.add(line.quantity || 0);
  }
  return {jobs:jobs.length,actualHours:actualCoverage?actual.toFixed(2):null,onsiteHours:onsiteCoverage?onsite.toFixed(2):null,billedTechnicianHours:billed.toFixed(2),actualCoverage,onsiteCoverage};
}
