import express from 'express';
import multer from 'multer';
import { randomUUID, createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { transaction, fail } from './store.js';
import { defaultSettings } from './catalog.js';
import { extractPages, parsePages } from './parser.js';
import { normalizeJob, jobIssues, monthEnd, reconcile, timing } from './model.js';
import { spreadsheet, invoicePDF, detailPDF, allocation } from './exports.js';

const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:20*1024*1024,files:1}});
const route=fn=>(req,res,next)=>Promise.resolve().then(()=>fn(req,res,next)).catch(next);
const actor=req=>req.session.user.username;
const safeName=name=>String(name||'document').replace(/[^a-zA-Z0-9._ -]/g,'_').slice(0,100);
const settings=async tx=>{try{return await tx.get('settings','defaults');}catch(e){if(e.status!==404)throw e;return {...structuredClone(defaultSettings),version:0};}};
const reviewFingerprint=s=>createHash('sha256').update(JSON.stringify({jobs:s.jobs.map(j=>[j.id,j.version]),settingsVersion:s.settings.version})).digest('hex');
const jobKey=j=>`${j.sourceSystem}\u0000${j.sourceCompany}\u0000${j.invoiceNumber}`;
const file=async(tx,req)=>{
  if(!req.file)throw fail(400,'Choose a file.');
  const b=req.file.buffer;
  const mime=b.subarray(0,5).toString()==='%PDF-'?'application/pdf':b[0]===137&&b.subarray(1,4).toString()==='PNG'?'image/png':b[0]===255&&b[1]===216?'image/jpeg':null;
  if(!mime)throw fail(400,'Only PDF, PNG and JPEG files are supported.');
  const id=randomUUID(),hash=createHash('sha256').update(b).digest('hex');
  const existing=(await tx.query('SELECT id,name,mime FROM freeport_files WHERE sha256=?',[hash]))[0];
  if(existing)return {...existing,hash};
  await tx.query('INSERT INTO freeport_files VALUES(?,?,?,?,?,?,?)',[id,safeName(req.file.originalname),mime,hash,b.toString('base64'),actor(req),new Date().toISOString()]);
  return {id,name:safeName(req.file.originalname),mime,hash};
};
async function unlocked(tx,jobId) {const claims=await tx.query('SELECT * FROM freeport_invoice_claims WHERE invoice_id=?',[jobId]);if(claims.length)throw fail(409,'Invoice is frozen in an active finalized package. Cancel/revise that package first.');}
export function freeportRouter(requireStaff,requireAdmin) {
  const router=express.Router();router.use(requireStaff);
  router.use((req,res,next)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    if(!['GET','HEAD'].includes(req.method) && req.headers.origin) {
      try{if(new URL(req.headers.origin).host!==req.get('host'))return res.status(403).json({error:'Cross-origin changes are not permitted.'});}catch{return res.status(403).json({error:'Invalid origin.'});}
    }
    next();
  });
  router.get('/settings',route(async(req,res)=>res.json(await transaction(settings))));
  router.put('/settings',requireAdmin,route(async(req,res)=>res.json(await transaction(async tx=>{
    const input=req.body;const current=await settings(tx);
    if(!Array.isArray(input.catalog)||!Array.isArray(input.accounts)||!Array.isArray(input.aliases))throw fail(400,'Catalog, aliases and accounts must be arrays.');
    if(!/^0(?:\.\d+)?$|^1(?:\.0+)?$/.test(String(input.taxRate)))throw fail(400,'Tax rate must be a decimal from 0 to 1.');
    for(const key of ['businessName','companyCode','spreadsheetPO','consolidatedPO','contract','partsExpense','laborExpense','referenceLabel'])if(!String(input[key]||'').trim())throw fail(400,`${key} is required.`);
    if(current.version!==input.version)throw fail(409,'Settings changed; reload first.');
    const saved=await tx.save('settings',{...input,id:'defaults'},input.version);await tx.audit(actor(req),'settings updated','defaults',{before:current,after:saved});return saved;
  }))));
  router.get('/jobs',route(async(req,res)=>res.json(await transaction(async tx=>(await tx.list('job')).map(j=>({...j,review:jobIssues(j)}))))));
  router.post('/jobs',route(async(req,res)=>res.status(201).json(await transaction(async tx=>{
    const job=normalizeJob({...req.body,id:randomUUID(),source:null,fileId:null,pages:[],attachments:[],reviewed:false});
    if((await tx.list('job')).some(j=>jobKey(j)===jobKey(job)))throw fail(409,'That source invoice already exists. Review it instead of adding another.');
    job.source=structuredClone(job);const saved=await tx.save('job',job);await tx.audit(actor(req),'manual invoice created',job.id);return saved;
  }))));
  router.put('/jobs/:id',route(async(req,res)=>res.json(await transaction(async tx=>{
    const old=await tx.get('job',req.params.id);await unlocked(tx,old.id);
    const job=normalizeJob({...req.body,id:old.id},old);
    if (old.source?.documentType === 'Quote' && job.documentType !== 'Quote') throw fail(400, 'A source quote cannot become a billable invoice. Import its issued invoice.');
    if (req.body.pages) {
      if (!Array.isArray(req.body.pages) || !req.body.pages.every(p => Number.isInteger(p) && p > 0) || new Set(req.body.pages).size !== req.body.pages.length) throw fail(400, 'Page numbers must be unique positive integers.');
      job.pages = req.body.pages;
    }
    if(jobKey(job)!==jobKey(old) && !(old.invoiceNumber.startsWith('UNIDENTIFIED-') && old.sourceSystem===job.sourceSystem && old.sourceCompany===job.sourceCompany && req.body.correction?.reason?.trim()))throw fail(400,'Source identity is immutable. An unidentified document may be identified with a review reason.');
    if((await tx.list('job')).some(j=>j.id!==old.id&&jobKey(j)===jobKey(job)))throw fail(409,'Duplicate source invoice.');
    const financial=j=>JSON.stringify({lines:j.lines.map(l=>[l.name,l.description,l.quantity,l.rate,l.amount]),subtotal:j.subtotal,tax:j.tax,total:j.total});
    if(financial(job)!==financial(old)) {
      if(!req.body.correction?.reason?.trim())throw fail(400,'Changing financial/source charge fields requires a correction reason. The original invoice remains unchanged.');
      job.correction={reason:req.body.correction.reason,actor:actor(req),at:new Date().toISOString()};
    }
    else job.correction=old.correction;
    job.decisions=Object.fromEntries(Object.entries(job.decisions||{}).map(([key,d])=>[key,{reason:String(d.reason||'').trim(),actor:actor(req),at:new Date().toISOString()}]));
    const saved=await tx.save('job',job,req.body.version);await tx.audit(actor(req),'invoice reviewed/edited',job.id,{before:old,after:saved});return saved;
  }))));
  router.post('/imports',upload.single('file'),route(async(req,res)=>{
    if(!req.file || req.file.buffer.subarray(0,5).toString()!=='%PDF-')throw fail(400,'Choose an Omega PDF.');
    const docs=parsePages(await extractPages(req.file.buffer),req.body.sourceSystem||'Omega');
    res.json(await transaction(async tx=>{
      const stored=await file(tx,req),existing=await tx.list('job'),results=[];
      for(const doc of docs) {
        doc.fileId=stored.id;
        const old=doc.invoiceNumber&&existing.find(j=>jobKey(j)===jobKey(doc));
        if(old) {
          if(old.importHash===doc.importHash)results.push({status:'duplicate',jobId:old.id});
          else {
            const conflict={id:randomUUID(),jobId:old.id,existingVersion:old.version,incoming:doc,status:'Open'};
            await tx.save('conflict',conflict);results.push({status:'conflict',conflictId:conflict.id,jobId:old.id});
          }
        } else {
          const job={...doc,id:randomUUID(),invoiceNumber:doc.invoiceNumber||`UNIDENTIFIED-${randomUUID().slice(0,8)}`};
          const saved=await tx.save('job',job);existing.push(saved);results.push({status:'created',jobId:job.id});
        }
      }
      await tx.audit(actor(req),'PDF imported',stored.id,{results});return {file:stored,results};
    }));
  }));
  router.get('/conflicts',route(async(req,res)=>res.json(await transaction(tx=>tx.list('conflict')))));
  router.post('/conflicts/:id/resolve',route(async(req,res)=>res.json(await transaction(async tx=>{
    const conflict=await tx.get('conflict',req.params.id);
    if(conflict.status!=='Open')throw fail(409,'Conflict was already resolved.');
    if(!req.body.reason?.trim()||!['keep','replace'].includes(req.body.action))throw fail(400,'Choose keep or replace and explain the decision.');
    const old=await tx.get('job',conflict.jobId);await unlocked(tx,old.id);
    if(old.version!==Number(req.body.jobVersion))throw fail(409,'Invoice changed; reload comparison.');
    if(req.body.action==='replace')await tx.save('job',{...conflict.incoming,id:old.id,attachments:old.attachments,reviewed:false,correction:{reason:req.body.reason,actor:actor(req),at:new Date().toISOString()}},old.version);
    const result=await tx.save('conflict',{...conflict,status:'Resolved',decision:req.body.action,reason:req.body.reason,actor:actor(req)},conflict.version);
    await tx.audit(actor(req),'import conflict resolved',old.id,{...result,previous:old});return result;
  }))));
  router.post('/jobs/:id/attachments',upload.single('file'),route(async(req,res)=>res.json(await transaction(async tx=>{
    const job=await tx.get('job',req.params.id);await unlocked(tx,job.id);
    if(job.version!==Number(req.body.version))throw fail(409,'Invoice changed; reload first.');
    const attachment=await file(tx,req);attachment.purpose=String(req.body.purpose||'Work order');
    let original={};
    if(attachment.purpose==='Original invoice PDF'){
      if(attachment.mime!=='application/pdf')throw fail(400,'Original invoices must be PDF files.');
      if(job.fileId)throw fail(409,'An original source already exists; use the reimport comparison workflow.');
      const pdf=await PDFDocument.load(req.file.buffer);original={fileId:attachment.id,pages:Array.from({length:pdf.getPageCount()},(_,i)=>i+1),reviewed:false};
    }
    const saved=await tx.save('job',{...job,...original,attachments:[...(job.attachments||[]),attachment]},job.version);
    await tx.audit(actor(req),'attachment added',job.id,attachment);return saved;
  }))));
  router.get('/files/:id',route(async(req,res)=>{
    const row=await transaction(async tx=>(await tx.query('SELECT * FROM freeport_files WHERE id=?',[req.params.id]))[0]);
    if(!row)throw fail(404,'File not found.');
    res.type(row.mime).set('Content-Disposition',`inline; filename="${safeName(row.name)}"`).send(Buffer.from(row.bytes_base64,'base64'));
  }));
  router.get('/timing',route(async(req,res)=>res.json(await transaction(async tx=>{
    const month=String(req.query.month||'');monthEnd(month);const [year,m]=month.split('-').map(Number),first=Math.floor((m-1)/3)*3+1;
    const jobs=await tx.list('job'),monthly=jobs.filter(j=>j.month===month),quarterJobs=jobs.filter(j=>j.month?.startsWith(`${year}-`)&&Number(j.month.slice(5))>=first&&Number(j.month.slice(5))<first+3);
    return {month,quarter:`${year} Q${Math.floor((m-1)/3)+1}`,monthly:timing(monthly),quarterly:timing(quarterJobs)};
  }))));
  router.get('/packages',route(async(req,res)=>res.json(await transaction(tx=>tx.list('package')))));
  router.post('/packages',route(async(req,res)=>res.status(201).json(await transaction(async tx=>{
    const month=String(req.body.month||'');monthEnd(month);const id=randomUUID();
    const pkg={id,month,invoiceDate:monthEnd(month),status:'Draft',jobIds:[],taxMethod:'source',taxDecision:null,history:[],payment:null};
    await tx.audit(actor(req),'package created',id);return tx.save('package',pkg);
  }))));
  router.put('/packages/:id',route(async(req,res)=>res.json(await transaction(async tx=>{
    const old=await tx.get('package',req.params.id);
    if(!['Draft','Ready for Review'].includes(old.status))throw fail(409,'Finalized content is frozen; revise explicitly.');
    if(!['Draft','Ready for Review'].includes(req.body.status)||!['source','monthly','manual'].includes(req.body.taxMethod))throw fail(400,'Invalid package state or tax method.');
    const ids=req.body.jobIds;if(!Array.isArray(ids)||new Set(ids).size!==ids.length)throw fail(400,'Invoice list must be unique.');
    for(const id of ids){const job=await tx.get('job',id);if(job.month!==old.month)throw fail(400,'Assign the invoice to this billing month first.');}
    const pkg={...old,status:req.body.status,jobIds:ids,taxMethod:req.body.taxMethod,manualTax:req.body.manualTax||'0',taxDecision:req.body.taxDecision?.reason?.trim()?{reason:req.body.taxDecision.reason,actor:actor(req),at:new Date().toISOString()}:null};
    pkg.reviewFingerprint=reviewFingerprint(await preview(tx,pkg));
    const saved=await tx.save('package',pkg,req.body.version);await tx.audit(actor(req),'package edited',old.id,{before:old,after:saved});return saved;
  }))));
  const preview=async(tx,pkg)=>{
    const jobs=[];for(const id of pkg.jobIds)jobs.push(await tx.get('job',id));
    const sourceOrder=new Map();for(const job of jobs)if(!sourceOrder.has(job.fileId||job.id))sourceOrder.set(job.fileId||job.id,sourceOrder.size);
    jobs.sort((a,b)=>sourceOrder.get(a.fileId||a.id)-sourceOrder.get(b.fileId||b.id)||(a.pages?.[0]||0)-(b.pages?.[0]||0));
    const defaults=await settings(tx);const totals=reconcile(jobs,defaults,pkg);
    const conflicts=await tx.list('conflict');
    for(const job of jobs) {
      if(conflicts.some(c=>c.status==='Open'&&c.jobId===job.id))totals.issues.push({key:'conflict',jobId:job.id,message:'Resolve changed-import conflict.'});
      if(job.month!==pkg.month)totals.issues.push({key:'month',jobId:job.id,message:'Billing month changed; review inclusion.'});
    }
    return {...pkg,jobs,settings:defaults,totals};
  };
  router.get('/packages/:id',route(async(req,res)=>res.json(await transaction(async tx=>{
    const pkg=await tx.get('package',req.params.id);return pkg.snapshot?{...pkg,preview:pkg.snapshot}:{...pkg,preview:await preview(tx,pkg)};
  }))));
  router.post('/packages/:id/finalize',route(async(req,res)=>res.json(await transaction(async tx=>{
    const pkg=await tx.get('package',req.params.id);
    if(pkg.version!==Number(req.body.version))throw fail(409,'Package changed; reload before finalizing.');
    if(pkg.status!=='Ready for Review')throw fail(409,'Mark the package Ready for Review first.');
    const snap=await preview(tx,pkg);
    if(pkg.reviewFingerprint!==reviewFingerprint(snap))throw fail(409,'Invoices or settings changed since package review. Review and save the package again.');
    if(snap.totals.issues.length)throw fail(422,`Resolve review issues: ${snap.totals.issues.map(i=>i.message).join(' ')}`);
    // A source document with uncertain/missing grouping cannot be exported as evidence.
    for(const job of snap.jobs) {
      await unlocked(tx,job.id);
      if(job.fileId) {
        const source=(await tx.query('SELECT * FROM freeport_files WHERE id=?',[job.fileId]))[0];
        const pdf=await PDFDocument.load(Buffer.from(source.bytes_base64,'base64'));
        if(!job.pages?.length||job.pages.some(p=>!Number.isInteger(p)||p<1||p>pdf.getPageCount()))throw fail(422,'Verify source page numbers.');
        for(const other of await tx.list('job'))if(other.id!==job.id&&other.fileId===job.fileId&&other.pages?.some(p=>job.pages.includes(p)))throw fail(422,'Overlapping invoice pages require review before inclusion.');
      } else if(!job.manualSourceReason?.trim())throw fail(422,'Missing supporting invoice: record the manual-source limitation on the job.');
      await tx.query('INSERT INTO freeport_invoice_claims VALUES(?,?)',[job.id,pkg.id]);
    }
    const reference=`FMI-${pkg.month}-${randomUUID().slice(0,8).toUpperCase()}`;
    const snapshot={...snap,reference,finalizedBy:actor(req),finalizedAt:new Date().toISOString()};delete snapshot.history;
    const saved=await tx.save('package',{...pkg,reference,status:'Finalized',snapshot},pkg.version);
    await tx.audit(actor(req),'package finalized',pkg.id,{reference,totals:snap.totals,invoiceIds:pkg.jobIds});return saved;
  }))));
  router.post('/packages/:id/state',route(async(req,res)=>res.json(await transaction(async tx=>{
    const pkg=await tx.get('package',req.params.id);
    if(pkg.version!==Number(req.body.version))throw fail(409,'Package changed; reload first.');
    const action=req.body.action;
    if(!['Finalized','Sent'].includes(pkg.status))throw fail(409,'Only active finalized packages support this action.');
    let next={...pkg};
    if(action==='sent')next.status='Sent';
    else if(action==='payment')next.payment={reference:String(req.body.reference||''),notes:String(req.body.notes||''),recordedBy:actor(req),at:new Date().toISOString(),notice:'Manually recorded; not verified paid in Omega.'};
    else if(['cancel','revise'].includes(action)) {
      if(!req.body.reason?.trim())throw fail(400,'Provide a cancellation/revision reason.');
      next.history=[...(pkg.history||[]),{snapshot:pkg.snapshot,reason:req.body.reason,action,actor:actor(req),at:new Date().toISOString()}];
      await tx.query('DELETE FROM freeport_invoice_claims WHERE package_id=?',[pkg.id]);
      next.status=action==='cancel'?'Cancelled':'Draft';
      if(action==='revise'){next.snapshot=null;next.reference=null;next.taxDecision=null;}
    } else throw fail(400,'Unknown action.');
    const saved=await tx.save('package',next,pkg.version);await tx.audit(actor(req),`package ${action}`,pkg.id,{before:pkg,after:saved});return saved;
  }))));
  router.get('/packages/:id/download/:format',route(async(req,res)=>{
    const pkg=await transaction(tx=>tx.get('package',req.params.id));
    const history=req.query.revision===undefined?null:pkg.history?.[Number(req.query.revision)];
    if(req.query.revision!==undefined&&!history?.snapshot)throw fail(404,'Revision not found.');
    const s=history?.snapshot||pkg.snapshot;if(!s)throw fail(409,'Finalize a package before downloading.');
    const type=req.params.format;let bytes,mime,ext;
    if(type==='xlsx'){bytes=await spreadsheet(s);mime='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';ext='xlsx';}
    else if(type==='invoice'){bytes=await invoicePDF(s);mime='application/pdf';ext='pdf';}
    else if(type==='detail'){bytes=await detailPDF(s);mime='application/pdf';ext='pdf';}
    else if(type==='allocation'){bytes=Buffer.from(JSON.stringify(allocation(s,pkg.payment),null,2));mime='application/json';ext='json';}
    else if(type==='supporting'){
      const pdf=await PDFDocument.create();
      // Iterate included invoices and their page arrays in saved source order.
      for(const job of s.jobs) {
        if(!job.fileId)continue;
        const row=await transaction(async tx=>(await tx.query('SELECT * FROM freeport_files WHERE id=?',[job.fileId]))[0]);
        const source=await PDFDocument.load(Buffer.from(row.bytes_base64,'base64'));
        const pages=await pdf.copyPages(source,job.pages.map(n=>n-1));pages.forEach(p=>pdf.addPage(p));
      }
      if(!pdf.getPageCount())throw fail(422,'No supporting invoice PDF pages were supplied.');
      bytes=Buffer.from(await pdf.save());mime='application/pdf';ext='pdf';
    } else throw fail(404,'Unknown export.');
    res.type(mime).set('Content-Disposition',`attachment; filename="${s.reference}-${type}.${ext}"`).send(bytes);
  }));
  router.get('/audit',requireAdmin,route(async(req,res)=>res.json(await transaction(tx=>tx.query('SELECT * FROM freeport_audit ORDER BY created_at DESC LIMIT 500')))));
  router.use((err,req,res,next)=>{if(res.headersSent)return next(err);res.status(err.status|| (err instanceof multer.MulterError?400:500)).json({error:err.status||err instanceof multer.MulterError?err.message:'Freeport operation failed; no changes were saved.'});if(!err.status)console.error(err);});
  return router;
}
