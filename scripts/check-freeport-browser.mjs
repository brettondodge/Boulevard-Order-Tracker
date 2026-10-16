// Synthetic browser acceptance only; never opens a production database.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { PDFDocument } from 'pdf-lib';

const dir=await mkdtemp(path.join(tmpdir(),'freeport-browser-'));
let child,browser,log='';
const base='http://127.0.0.1:4318';
const source=await PDFDocument.create();
for(const text of ['Invoice # B9001\nInvoice Date: 2026-09-01\nGlass  1 ea 100.00 100.00','Invoice # B9001\nLabor  2 hr 125.00 250.00\nLabor  2 hr 125.00 250.00\nSubtotal 600.00\nTax 9.10\nTotal 609.10','Invoice # B9002\nGlass  1 ea 50.00 50.00']) { const p=source.addPage();p.drawText(text,{x:30,y:750,size:12,lineHeight:18}); }
const sourcePath=path.join(dir,'synthetic-omega.pdf');await writeFile(sourcePath,await source.save());
try {
  child=spawn(process.execPath,['src/server.js'],{env:{...process.env,NODE_ENV:'test',RENDER:'false',SQLITE_DATA_DIR:dir,PREVIEW_MODE:'false',APP_PORT:'4318',ADMIN_USERNAME:'admin',ADMIN_PASSWORD:'synthetic-admin',SESSION_SECRET:'synthetic-browser-secret'},stdio:['ignore','pipe','pipe']});child.stderr.on('data',c=>log+=c);
  for(let i=0;i<100;i++){try{if((await fetch(base+'/healthz')).ok)break;}catch{}await delay(100);}
  browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1050},acceptDownloads:true});
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base+'/');await page.locator('#username').fill('mary');await page.locator('#password').fill('staff123');await page.locator('button[type="submit"]').click();await page.waitForURL(base+'/');
  await page.getByRole('link',{name:/Order Tracker/}).click();await page.waitForURL('**/app');await page.getByRole('link',{name:'Tools Home'}).click();await page.getByRole('link',{name:/Freeport Billing/}).click();await page.waitForURL('**/freeport');await page.getByText('Saved workspace loaded.',{exact:false}).waitFor();
  await page.locator('#month').fill('2026-09');await page.locator('#pdf').setInputFiles(sourcePath);await page.getByText('Import saved:',{exact:false}).waitFor();assert.equal(await page.locator('#jobs tr').count(),2);
  await page.getByRole('button',{name:'B9001',exact:true}).click();await page.locator('#editor').waitFor();
  for(const [key,value] of Object.entries({month:'2026-09',orderNumber:'000400019000001',accountCode:'1060901328',usingArea:'Mine Maintenance'}))await page.locator(`#jobFields [data-field="${key}"]`).fill(value);
  assert.equal(await page.locator('#lines tr').count(),3,await page.locator('#sourceText').textContent());
  for(let i=0;i<3;i++){await page.locator(`[data-line="${i}"][data-key="classification"]`).selectOption(i?'Labor':'Parts');await page.locator(`[data-line="${i}"][data-key="mappingReviewed"]`).check();}
  await page.locator('#reviewed').check();await page.getByRole('button',{name:'Save invoice',exact:true}).click();await page.locator('#jobSave').getByText('Saved',{exact:true}).waitFor();await page.getByRole('button',{name:'Close',exact:true}).click();
  await page.locator('#settings').click();await page.locator('#adminUser').fill('admin');await page.locator('#adminPassword').fill('synthetic-admin');await page.getByRole('button',{name:'Unlock',exact:true}).click();await page.getByText('Administrator gate unlocked.').waitFor();
  const settings=JSON.parse(await page.locator('#settingsJson').inputValue());settings.remittance='Synthetic browser verification address';await page.locator('#settingsJson').fill(JSON.stringify(settings,null,2));await page.locator('#saveSettings').click();await page.locator('#adminMessage').getByText('Saved',{exact:true}).waitFor();await page.locator('#closeAdmin').click();
  await page.locator('#newPackage').click();await page.getByText('Draft package created.',{exact:false}).waitFor();await page.getByRole('checkbox',{name:'Include invoice B9001',exact:true}).check();await page.locator('#packageStatus').selectOption('Ready for Review');await page.locator('#savePackage').click();await page.getByText('Package selection and review saved.').waitFor();
  await page.screenshot({path:path.join(dir,'review-desktop.png'),fullPage:true});
  page.once('dialog',d=>d.accept());await page.locator('#finalize').click();await page.getByText('Package finalized.',{exact:false}).waitFor();
  for(const type of ['xlsx','invoice','detail','supporting','allocation']){const pending=page.waitForEvent('download');await page.getByRole('link',{name:`Download ${type}`,exact:true}).click();const download=await pending;assert.equal(await download.failure(),null);await download.saveAs(path.join(dir,download.suggestedFilename()));}
  await page.reload();await page.getByText('Saved workspace loaded.',{exact:false}).waitFor();assert.equal(await page.locator('#jobs tr').count(),2);
  await page.screenshot({path:path.join(dir,'finalized-desktop.png'),fullPage:true});await page.setViewportSize({width:820,height:1180});await page.screenshot({path:path.join(dir,'tablet.png'),fullPage:true});
  assert.deepEqual(errors,[]);console.log(JSON.stringify({result:'passed',checks:['login and dashboard cards','tracker navigation','Freeport refresh','combined PDF import','charge editing and save','admin settings','package selection and finalization','all five downloads','desktop/tablet screenshots'],artifactDirectory:dir}));
} catch(error){console.error(log);throw error;}finally{await browser?.close();if(child&&child.exitCode===null){const done=once(child,'exit');child.kill();await done;}}
