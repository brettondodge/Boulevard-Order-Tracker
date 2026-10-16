import ExcelJS from 'exceljs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { columns, exportRows, money } from './model.js';
export async function spreadsheet(snapshot) {
  const workbook=new ExcelJS.Workbook();
  const sheet=workbook.addWorksheet('Billing');sheet.addRow(columns);
  for(const row of exportRows(snapshot.jobs,snapshot.settings)) sheet.addRow(row);
  sheet.views=[{state:'frozen',ySplit:1}];
  sheet.getRow(1).font={bold:true};
  sheet.columns.forEach((col,i)=>{col.width=i===0?44:Math.max(columns[i].length+2,18);if(![2,4].includes(i)) col.numFmt='@';});
  sheet.getColumn(3).numFmt='0.####';sheet.getColumn(5).numFmt='0.00####';
  return Buffer.from(await workbook.xlsx.writeBuffer());
}
const ascii=text=>String(text??'').replace(/[^\x20-\x7E\n]/g,'?');
function wrap(text,font,size,width) {
  const result=[];
  for(const paragraph of ascii(text).split('\n')) {
    let line='';
    for(const word of paragraph.split(' ')) {
      const candidate=line ? line+' '+word : word;
      if(font.widthOfTextAtSize(candidate,size)<=width){line=candidate;continue;}
      if(line){result.push(line);line='';}
      for(const char of word){if(font.widthOfTextAtSize(line+char,size)>width&&line){result.push(line);line='';}line+=char;}
    }
    result.push(line);
  }
  return result;
}
export async function invoicePDF(s) {
  const pdf=await PDFDocument.create(), font=await pdf.embedFont(StandardFonts.Helvetica), bold=await pdf.embedFont(StandardFonts.HelveticaBold);
  let page=pdf.addPage([612,792]), y=742;
  const write=(text,size=11,strong=false)=>{for(const line of wrap(text,strong?bold:font,size,510)) {if(y<55){page=pdf.addPage([612,792]);y=742;}page.drawText(line,{x:50,y,size,font:strong?bold:font});y-=size+7;}};
  write('INVOICE',28,true);y-=8;write(s.settings.businessName,17,true);write(s.settings.remittance);y-=16;
  write('Freeport McMoRan - Safford',13,true);write('Accounts Payable\nP.O. Box 25109\nPhoenix, AZ 85002-5109');y-=18;
  write(`${s.settings.referenceLabel}: ${s.reference}`,13,true);write(`Invoice date: ${s.invoiceDate}  |  Billing period: ${s.month}`);write(`PO: ${s.settings.consolidatedPO}`);write(`Contract: ${s.settings.contract}`);y-=20;
  for(const [label,key] of [['Parts and Materials','parts'],['Labor','labor'],['Subtotal','subtotal'],['Tax','selectedTax'],['Total Due','total']]) write(`${label}: $${money(s.totals[key])}`,key==='total'?18:13,key==='total');
  y-=18;write(`Supporting detail and ${s.jobs.length} original job invoices accompany this monthly package.`);write('Package reference is separate from the original supplier invoice numbers.',9);
  return Buffer.from(await pdf.save());
}
export async function detailPDF(s) {
  // Large landscape page gives all 15 columns readable space without clipping IDs.
  const pdf=await PDFDocument.create(), font=await pdf.embedFont(StandardFonts.Helvetica),bold=await pdf.embedFont(StandardFonts.HelveticaBold);
  const widths=[220,67,53,60,60,65,65,105,65,87,48,85,91,115,100];
  const size=9,pad=5;let page,y;
  const cell=(text,x,top,width,strong=false)=>{const f=strong?bold:font;const lines=wrap(text,f,size,width-pad*2);lines.forEach((v,i)=>page.drawText(v,{x:x+pad,y:top-pad-size-i*12,size,font:f}));return lines.length*12+pad*2;};
  const start=()=>{page=pdf.addPage([1580,1117]);y=1060;page.drawText(ascii(`${s.reference} | ${s.month} | Monthly billing detail`),{x:35,y,size:15,font:bold});y-=30;let x=35;const h=Math.max(...columns.map((v,i)=>wrap(v,bold,size,widths[i]-pad*2).length))*12+pad*2;columns.forEach((v,i)=>{cell(v,x,y,widths[i],true);x+=widths[i];});y-=h+8;};
  start();
  for(const row of exportRows(s.jobs,s.settings)) {
    const h=Math.max(...row.map((v,i)=>wrap(v,font,size,widths[i]-pad*2).length))*12+pad*2;
    if(y-h<45) start();let x=35;row.forEach((v,i)=>{cell(v,x,y,widths[i]);x+=widths[i];});page.drawLine({start:{x:35,y:y-h},end:{x:1526,y:y-h},thickness:.3,color:rgb(.8,.83,.87)});y-=h;
  }
  return Buffer.from(await pdf.save());
}
export function allocation(s,payment) {return {reference:s.reference,notice:'Internal allocation only. Payment recorded here is not verified paid in Omega.',invoices:s.jobs.map(j=>({invoiceNumber:j.invoiceNumber,sourceSystem:j.sourceSystem,amount:j.source?.total || j.total})),expectedOriginalTotal:money(s.totals.sourceTotal),consolidatedTotal:money(s.totals.total),unallocatedDifference:money(s.totals.difference),exportSubtotal:money(s.totals.exportSubtotal),exportDifference:money(s.totals.exportDifference),reviewedCorrections:s.jobs.filter(j=>j.correction).map(j=>({invoice:j.invoiceNumber,correction:j.correction,decisions:j.decisions})),taxDecision:s.taxDecision,payment:payment||null};}
