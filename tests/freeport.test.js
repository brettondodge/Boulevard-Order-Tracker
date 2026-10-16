import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { parsePages, extractPages } from '../src/freeport/parser.js';
import { cents, money, monthEnd, lineAmount, jobIssues, reconcile, exportRows, columns, timing } from '../src/freeport/model.js';
import { spreadsheet, detailPDF, invoicePDF } from '../src/freeport/exports.js';
import { defaultSettings } from '../src/freeport/catalog.js';

function sample() {return {sourceSystem:'ELMO',sourceCompany:'Boulevard Glass LLC',invoiceNumber:'10239160',documentType:'Invoice',invoiceDate:'2026-09-01',month:'2026-09',po:'400019169711',orderNumber:'400019169711',accountCode:'1060901328',usingArea:'Mine Maintenance',reviewed:true,manualSourceReason:'Synthetic acceptance fixture; original PDF not supplied.',subtotal:'817.78',tax:'28.92',total:'846.70',timing:{},decisions:{},lines:[
  {name:'.090 Clear Laminated',description:'36 x 48 (.090 clr Lami)',exportDescription:'36 x 48 (.090 Clr Lami)',quantity:'1',unit:'ea',rate:'299.28',amount:'299.28',classification:'Parts',mappingReviewed:true},
  {name:'Silicone',description:'Silicone',exportDescription:'Silicone',quantity:'1',unit:'ea',rate:'18.50',amount:'18.50',classification:'Parts',mappingReviewed:true},
  ...Array.from({length:2},()=>({name:'Labor',description:'Per Man',exportDescription:'Tech Labor - Straight',quantity:'2',unit:'hr',rate:'125',amount:'250',classification:'Labor',mappingReviewed:true}))]};}
const defaults={...defaultSettings,remittance:'Synthetic remittance address for testing only'};

test('decimal rounding, source prices, distinct equal labor, unknown mappings and item variants',()=>{
  const job=sample();const review=jobIssues(job);assert.equal(review.parts,31778);assert.equal(review.labor,50000);assert.equal(review.issues.length,0);
  assert.equal(cents('1.005'),101);assert.equal(lineAmount({quantity:'0.3',rate:'0.1'}),3);assert.equal(money(84670),'846.70');
  assert.equal(exportRows([job],defaults).length,4);assert.equal(exportRows([job],defaults)[0][4],299.28);
  assert.equal(defaultSettings.catalog.filter(c=>c.name==='.090 Clear Laminated').length,4);
  job.lines[0].unit='';job.lines[0].classification='';assert.ok(jobIssues(job).issues.some(i=>i.key==='line-1-unit'));assert.ok(jobIssues(job).issues.some(i=>i.key==='line-1-mapping'));
  assert.throws(()=>cents('NaN'));assert.throws(()=>cents(''));
});
test('September one-cent difference is visible and requires explicit decision',()=>{
  // Synthetic rows deliberately reproduce verified totals, without pretending to
  // reconstruct the absent 21 source PDFs or 96 historical spreadsheet rows.
  const job={...sample(),lines:[{...sample().lines[0],rate:'7998.02',amount:'7998.02'},{...sample().lines[2],quantity:'1',rate:'14082.50',amount:'14082.50'}],subtotal:'22080.52',tax:'727.81',total:'22808.33'};
  let result=reconcile([job],defaults,{taxMethod:'source'});assert.equal(result.sourceTax,72781);assert.equal(result.monthlyTax,72782);assert.equal(result.total,2280833);assert.ok(result.issues.some(i=>i.key==='tax'));
  result=reconcile([job],defaults,{taxMethod:'monthly',taxDecision:{reason:'Reproduce historical consolidated monthly calculation.'}});assert.equal(result.total,2280834);assert.equal(result.difference,1);assert.equal(result.issues.length,0);
});
test('Phoenix calendar month ends and leap years; timing never becomes person-hours',()=>{
  assert.equal(monthEnd('2028-02'),'2028-02-29');assert.equal(monthEnd('2026-02'),'2026-02-28');assert.equal(monthEnd('2026-09'),'2026-09-30');assert.throws(()=>monthEnd('2026-13'));
  const job=sample();job.timing={requestAt:'2026-09-01T08:00:00-07:00',completedAt:'2026-09-01T12:00:00-07:00',onsiteHours:'1.5',source:'Work notes',people:'2'};
  assert.deepEqual(timing([job,{...sample(),timing:{}}]),{jobs:2,actualHours:'4.00',onsiteHours:'1.50',billedTechnicianHours:'8.00',actualCoverage:1,onsiteCoverage:1});
});
test('multi-page grouping preserves identical rows; quote stays separate; scanned fallback',()=>{
  const pages=['Invoice # 123\nPO # 400019169711\nLabor  2 hr 125.00 250.00','Invoice # 123\nLabor  2 hr 125.00 250.00\nSubtotal 500.00\nTax 0.00\nTotal 500.00','Quote # Q2\nGlass  1 ea 200.00 200.00'];
  const docs=parsePages(pages);assert.equal(docs.length,2);assert.deepEqual(docs[0].pages,[1,2]);assert.equal(docs[0].lines.length,2);assert.deepEqual(docs[0].lines.map(l=>l.sourcePage),[1,2]);assert.equal(docs[0].lines[0].rate,'125.00');assert.equal(docs[0].subtotal,'500.00');assert.equal(docs[1].documentType,'Quote');assert.match(parsePages([''])[0].parserNotice,/Scanned PDF/);
});
test('XLSX has exact headings, numeric quantities, text identifiers, blanks and separate labor rows; PDFs paginate',async()=>{
  const snapshot={jobs:[sample()],settings:defaults,month:'2026-09',invoiceDate:'2026-09-30',reference:'FMI-2026-09-TEST',totals:reconcile([sample()],defaults,{taxMethod:'source'})};
  const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(await spreadsheet(snapshot));const sheet=workbook.worksheets[0];assert.deepEqual(sheet.getRow(1).values.slice(1),columns);assert.equal(sheet.rowCount,5);assert.equal(sheet.getCell('H2').value,'400019169711');assert.equal(sheet.getCell('M2').value,'10239160');assert.equal(sheet.getCell('C2').value,1);assert.equal(sheet.getCell('E4').value,125);assert.equal(sheet.getCell('B2').value,'');assert.equal(sheet.getCell('I2').value,'');assert.equal(sheet.getCell('A4').value,sheet.getCell('A5').value);
  assert.equal((await PDFDocument.load(await invoicePDF(snapshot))).getPageCount(),1);
  const large={...snapshot,jobs:Array.from({length:35},()=>sample())};assert.ok((await PDFDocument.load(await detailPDF(large))).getPageCount()>1);
  const extracted=await extractPages(await detailPDF(snapshot));assert.match(extracted[0],/SUPPLIER/);assert.match(extracted[0],/10239160/);
});

async function fixturePDF(){const pdf=await PDFDocument.create();const font=await pdf.embedFont(StandardFonts.Courier);for(const content of ['Invoice # 9001\nInvoice Date: 2026-09-01\nGlass  1 ea 99.00 99.00','Invoice # 9001\nLabor  2 hr 125.00 250.00\nLabor  2 hr 125.00 250.00\nSubtotal 599.00\nTax 9.01\nTotal 608.01','Quote # Q9002\nGlass  1 ea 20.00 20.00']){const page=pdf.addPage();page.drawText(content,{x:30,y:750,size:12,font,lineHeight:18});}return Buffer.from(await pdf.save());}

test('integrated SQLite lifecycle: protected routes, import/conflicts, optimistic edits, concurrent claims, snapshots, revision, files and restart', {timeout:60000}, async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'freeport-integration-'));let child,output='';let cookie='';
  const base='http://127.0.0.1:4317';
  async function start(){child=spawn(process.execPath,['src/server.js'],{env:{...process.env,NODE_ENV:'test',RENDER:'false',PREVIEW_MODE:'false',SQLITE_DATA_DIR:dir,APP_PORT:'4317',SESSION_SECRET:'synthetic-freeport-secret',ADMIN_USERNAME:'admin',ADMIN_PASSWORD:'synthetic-admin'},stdio:['ignore','pipe','pipe']});child.stderr.on('data',c=>output+=c);for(let i=0;i<100;i++){if(child.exitCode!==null)throw new Error(output);try{if((await fetch(base+'/healthz')).ok)return;}catch{}await delay(100);}throw new Error('Startup timeout '+output);}
  async function stop(){if(child&&child.exitCode===null){const done=once(child,'exit');child.kill();await done;}}
  async function req(url,method='GET',body){const r=await fetch(base+url,{method,redirect:'manual',headers:{...(cookie?{Cookie:cookie}:{}),...(body instanceof FormData?{}:{'Content-Type':'application/json'})},body:body===undefined?undefined:body instanceof FormData?body:JSON.stringify(body)});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];const type=r.headers.get('content-type')||'';return {status:r.status,body:type.includes('json')?await r.json():await r.arrayBuffer(),headers:r.headers};}
  async function ok(url,method,body,status=200){const r=await req(url,method,body);assert.equal(r.status,status,JSON.stringify(r.body)+output);return r.body;}
  async function login(){await ok('/api/login','POST',{username:'mary',password:'staff123'});}
  try{
    await start();assert.equal((await req('/')).status,302);assert.equal((await req('/freeport/deep')).status,302);assert.equal((await req('/freeport.html')).status,302);assert.equal((await req('/api/freeport/jobs')).status,401);assert.equal((await req('/api/freeport/files/missing')).status,401);await login();
    const home=await req('/');assert.match(Buffer.from(home.body).toString(),/Your tools/);assert.deepEqual((await ok('/api/tools')).map(t=>t.path),['/app','/freeport']);assert.equal((await req('/app?view=received')).status,200);assert.equal((await req('/freeport/deep')).status,200);assert.equal((await req('/freeport.js')).status,200);assert.equal((await req('/api/orders')).status,200);
    const db=new Database(path.join(dir,'boulevard_orders.db'));const usersBefore=db.prepare('SELECT * FROM users').all();db.prepare("INSERT INTO orders(id,customer_name,supplier,date_ordered,created_at,updated_at) VALUES ('sentinel','Preserved synthetic tracker','Test','2026-09-01','2026-09-01','2026-09-01')").run();db.close();
    let defaults=await ok('/api/freeport/settings');assert.equal((await req('/api/freeport/settings','PUT',{...defaults,remittance:'Synthetic test address'})).status,401);
    await ok('/api/admin/login','POST',{username:'admin',password:'synthetic-admin'});defaults=await ok('/api/freeport/settings','PUT',{...defaults,remittance:'Synthetic test address'});
    const originalBytes=await fixturePDF();const form=new FormData();form.append('file',new Blob([originalBytes],{type:'application/pdf'}),'synthetic.pdf');const imported=await ok('/api/freeport/imports','POST',form);assert.equal(imported.results.length,2);
    const dupe=await ok('/api/freeport/imports','POST',form);assert.ok(dupe.results.every(r=>r.status==='duplicate'));
    let importedJobs=await ok('/api/freeport/jobs');const invoice=importedJobs.find(j=>j.documentType==='Invoice');assert.equal(invoice.lines.length,3,JSON.stringify(invoice.source));assert.deepEqual(invoice.pages,[1,2]);assert.equal((await req(`/api/freeport/files/${imported.file.id}`)).status,200);
    const quote=importedJobs.find(j=>j.documentType==='Quote');assert.equal((await req(`/api/freeport/jobs/${quote.id}`,'PUT',{...quote,documentType:'Invoice'})).status,400);
    const changedPDF=await PDFDocument.create();const changedPage=changedPDF.addPage();changedPage.drawText('Invoice # 9001\nGlass  1 ea 98.00 98.00',{x:30,y:700,size:12});const changedForm=new FormData();changedForm.append('file',new Blob([await changedPDF.save()]),'changed.pdf');const changed=await ok('/api/freeport/imports','POST',changedForm);assert.equal(changed.results[0].status,'conflict');const conflicts=await ok('/api/freeport/conflicts');await ok(`/api/freeport/conflicts/${conflicts[0].id}/resolve`,'POST',{action:'keep',reason:'Synthetic change declined',jobVersion:invoice.version});
    let job=await ok('/api/freeport/jobs','POST',sample(),201);job=await ok(`/api/freeport/jobs/${job.id}`,'PUT',{...job,reviewed:true});assert.equal((await req(`/api/freeport/jobs/${job.id}`,'PUT',{...job,version:1})).status,409);
    assert.equal((await req(`/api/freeport/jobs/${job.id}`,'PUT',{...job,total:'999.00'})).status,400);
    assert.equal(timing([{...sample(),timing:{}}]).actualHours,null);
    const attachment=new FormData();attachment.append('file',new Blob([await fixturePDF()]),'work-order.pdf');attachment.append('version',job.version);job=await ok(`/api/freeport/jobs/${job.id}/attachments`,'POST',attachment);
    assert.equal((await req('/api/freeport/jobs','POST',sample())).status,409);
    const a=await ok('/api/freeport/packages','POST',{month:'2026-09'},201),b=await ok('/api/freeport/packages','POST',{month:'2026-09'},201);
    const ready=async p=>ok(`/api/freeport/packages/${p.id}`,'PUT',{...p,status:'Ready for Review',jobIds:[job.id],taxMethod:'source'});
    const pa=await ready(a),pb=await ready(b);
    const attempts=await Promise.all([req(`/api/freeport/packages/${a.id}/finalize`,'POST',{version:pa.version}),req(`/api/freeport/packages/${b.id}/finalize`,'POST',{version:pb.version})]);assert.deepEqual(attempts.map(r=>r.status).sort(),[200,409]);let finalized=attempts.find(r=>r.status===200).body;
    assert.equal((await req(`/api/freeport/jobs/${job.id}`,'PUT',job)).status,409);
    const bytes=await req(`/api/freeport/packages/${finalized.id}/download/xlsx`);assert.equal(bytes.status,200);const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(bytes.body);assert.equal(workbook.worksheets[0].rowCount,5);
    assert.equal((await req(`/api/freeport/packages/${finalized.id}/download/invoice`)).status,200);assert.equal((await req(`/api/freeport/packages/${finalized.id}/download/detail`)).status,200);assert.equal((await req(`/api/freeport/packages/${finalized.id}/download/supporting`)).status,422);
    defaults=await ok('/api/freeport/settings','PUT',{...defaults,companyCode:'9999'});const frozen=await ok(`/api/freeport/packages/${finalized.id}`);assert.equal(frozen.preview.settings.companyCode,'1328');assert.equal((await ok(`/api/freeport/packages/${finalized.id}/download/allocation`)).unallocatedDifference,'0.00');
    finalized=await ok(`/api/freeport/packages/${finalized.id}/state`,'POST',{version:finalized.version,action:'payment',reference:'Synthetic check'});assert.match(finalized.payment.notice,/not verified/);
    finalized=await ok(`/api/freeport/packages/${finalized.id}/state`,'POST',{version:finalized.version,action:'revise',reason:'Synthetic revision'});assert.equal(finalized.history.length,1);assert.equal((await req(`/api/freeport/packages/${finalized.id}/download/invoice?revision=0`)).status,200);
    await stop();cookie='';await start();await login();assert.equal((await ok('/api/freeport/jobs')).length,3);assert.equal((await ok('/api/freeport/packages')).length,2);
    const restored=new Database(path.join(dir,'boulevard_orders.db'));assert.equal(restored.prepare("SELECT customer_name FROM orders WHERE id='sentinel'").get().customer_name,'Preserved synthetic tracker');assert.deepEqual(restored.prepare('SELECT * FROM users').all(),usersBefore);restored.close();
    const manual = await ok('/api/freeport/jobs','POST',{...sample(),invoiceNumber:'MANUAL-PDF'},201);
    const original = new FormData(); original.append('file',new Blob([originalBytes]),'source.pdf'); original.append('version',manual.version); original.append('purpose','Original invoice PDF');
    const manualWithPDF=await ok(`/api/freeport/jobs/${manual.id}/attachments`,'POST',original);
    assert.deepEqual(manualWithPDF.pages,[1,2,3]);assert.equal(manualWithPDF.fileId,imported.file.id);
    const protectedURL=`/api/freeport/packages/${finalized.id}/download/invoice?revision=0`;await ok('/api/logout','POST',{});assert.equal((await req(protectedURL)).status,401);
  }finally{await stop();}
});


test('additive migration preserves representative tracker records and staff identities', async()=>{
  const db=new Database(':memory:');
  db.exec("CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT,password_hash TEXT); CREATE TABLE orders(id TEXT PRIMARY KEY,customer_name TEXT,status TEXT); INSERT INTO users VALUES ('staff-id','synthetic-staff','preserved-hash'); INSERT INTO orders VALUES ('order-id','Synthetic job','Received')");
  const beforeUsers=db.prepare('SELECT * FROM users').all(), beforeOrders=db.prepare('SELECT * FROM orders').all();
  const migration=await readFile(new URL('../migrations/002-freeport.sql',import.meta.url),'utf8');
  db.transaction(()=>db.exec(migration))();db.transaction(()=>db.exec(migration))();
  assert.deepEqual(db.prepare('SELECT * FROM users').all(),beforeUsers);assert.deepEqual(db.prepare('SELECT * FROM orders').all(),beforeOrders);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM freeport_records').get().n,0);db.close();
});
