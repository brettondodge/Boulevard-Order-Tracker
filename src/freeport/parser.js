import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createHash } from 'node:crypto';

export async function extractPages(bytes) {
  const task=getDocument({data:new Uint8Array(bytes),isEvalSupported:false,useSystemFonts:true});
  const pdf=await task.promise;
  try {
    if(pdf.numPages>200) throw new Error('Maximum 200 pages per import.');
    const pages=[];
    for(let n=1;n<=pdf.numPages;n++) {
      const page=await pdf.getPage(n), content=await page.getTextContent();
      const rows=[];
      for(const item of content.items) {
        if(!('str' in item)) continue;
        const y=Math.round(item.transform[5]*2)/2;
        let row=rows.find(r=>Math.abs(r.y-y)<2);
        if(!row) {row={y,items:[]};rows.push(row);}
        row.items.push({x:item.transform[4],text:item.str});
      }
      pages.push(rows.sort((a,b)=>b.y-a.y).map(r=>r.items.sort((a,b)=>a.x-b.x).map(i=>i.text).join('  ')).join('\n'));
    }
    return pages;
  } finally { await task.destroy(); }
}
const amount='(-?\\$?[\\d,]+\\.\\d{2})';
const clean=value=>(value || '').replace(/[$,]/g,'');
function field(text,label) {return text.match(new RegExp(`(?:${label})\\s*[:#]?\\s*([^\\n]+)`,'i'))?.[1]?.trim() || '';}
export function parsePages(pages,sourceSystem='Omega') {
  const documents=[];let current=null;
  pages.forEach((text,index)=>{
    const match=text.match(/\b(Invoice|Quote|Estimate)\s*(?:Number|No\.?|#|:)\s*:?\s*([A-Z0-9-]+)/i);
    if(match) {
      const type=/invoice/i.test(match[1])?'Invoice':'Quote';
      if(!current || current.invoiceNumber!==match[2] || current.documentType!==type) {
        current={sourceSystem,sourceCompany:'Boulevard Glass LLC',documentType:type,invoiceNumber:match[2],pages:[],texts:[]};documents.push(current);
      }
    }
    if(!current) {current={sourceSystem,sourceCompany:'Boulevard Glass LLC',documentType:'Unknown',invoiceNumber:'',pages:[],texts:[]};documents.push(current);}
    current.pages.push(index+1);current.texts.push(text);
  });
  return documents.map(doc=>{
    const sourceRows=doc.texts.flatMap((pageText,i)=>pageText.split('\n').map((row,rowIndex)=>({row,page:doc.pages[i],sourceRow:rowIndex+1})));
    const text=doc.texts.join('\n');delete doc.texts;
    const lines=[];
    for(const {row,page,sourceRow} of sourceRows) {
      // Conservative tabular fallback: description | qty | optional unit | billed
      // unit price | extended amount. Catalog/list/cost headers are never parsed.
      if(/\b(subtotal|tax|total|balance|list price|catalog price|cost)\b/i.test(row)) continue;
      const m=row.match(new RegExp(`^(.+?)\\s+(-?\\d+(?:\\.\\d+)?)\\s+(?:(ea|hr|hrs|sqft|ft|lf|each|hour)\\s+)?${amount}\\s+${amount}\\s*$`,'i'));
      if(m) lines.push({name:m[1].trim(),description:m[1].trim(),quantity:m[2],unit:m[3]||'',rate:clean(m[4]),amount:clean(m[5]),sourcePage:page,sourceRow,classification:'',exportDescription:m[1].trim(),mappingReviewed:false});
    }
    const totals={};
    for(const [key,label] of [['subtotal','subtotal'],['tax','(?:sales\\s+)?tax'],['total','(?:invoice\\s+)?total']]) {
      const matches=[...text.matchAll(new RegExp(`(?:^|\\n)\\s*${label}\\s*:?\\s*${amount}\\s*(?=\\n|$)`,'gi'))];
      totals[key]=clean(matches.at(-1)?.[1]);
    }
    const source={...doc,invoiceDate:field(text,'Invoice Date|Date'),po:field(text,'PO #|P\\.O\\. #'),orderNo:field(text,'ORDER NO\\.'),equipmentNo:field(text,'EQUIPMENT NO\\.'),customer:field(text,'Bill To|Customer'),serviceDate:field(text,'Appointment|Service Date'),make:field(text,'Make'),model:field(text,'Model'),year:field(text,'Year'),vin:field(text,'VIN|Serial'),unitNumber:field(text,'Unit Number|Unit #'),notes:field(text,'Notes'),lines, ...totals,text};
    return {...source,source:structuredClone(source),reviewed:false,orderNumber:'',accountCode:'',usingArea:'',month:'',timing:{},attachments:[],decisions:{},importHash:createHash('sha256').update(JSON.stringify(source)).digest('hex'),parserNotice:!text.trim()?'Scanned PDF: no text found. Local OCR is unavailable; manual entry and source review required.':'Draft extraction only. Verify invoice grouping, every billed row, totals and source fields against the PDF.'};
  });
}
