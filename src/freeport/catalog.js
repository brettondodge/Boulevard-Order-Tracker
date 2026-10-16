const supplied = [
['.090 Clear Laminated','48 x 48 (.090 clr Lami)','399.04'],
['.090 Clear Laminated','36 x 48 (.090 clr Lami)','299.28'],
['.090 Clear Laminated','60 x 48 (.090 clr Lami)','498.80'],
['.090 Clear Laminated','72 x 48 (.090 clr Lami)','598.56'],
['.090 Clear Laminated 5/16"','All with Flat Glass','24.94'],
['.090 Clear Laminated 7/16"','Shovel Glass','38.90'],
['.090 Clear Laminated 7/16"','Shovel W/S 62 3/4 x 72 3/4','1279.38'],
['1/4" Wire Glass','[description not supplied]','42.35'],
['178-8894','CM BULK SEAL','121.50'],
['32% HP Charcoal Tint','36" width price per linear foot','12.66'],
['36" Width AC 4 MIL CLR HC','Safety Film per Linear Foot','12.00'],
['48" Width AC 4 MIL CLR HC','Safety Film per Linear Foot','15.00'],
['793-LDC','Door Conversion Kit-Left door glass-Gasket-Metal frame-Interior cover plate-Bolts & Switch cover-Doe','1552.07'],
['80% XenithIR Ceramic','36" width price per linear foot','24.96'],
['After Hours','Call Out Fee','200.00'],['Clear IGU','Building','12.75'],
['Freeport McMoRan -FMI','Labor','0.00'],['Freeport McMoRan -FMI','Parts and Materials','0.00'],
['Holiday Work','Per Man','0.00'],['HT Door (MR10 Lexan)','30 x 30 (1/4" MR10 Lexan','162.50'],
['Labor','Per Man','0.00'],['Lexan MR10','Haul Truck Door Glass','26.00'],['LowE IGU','Building','15.75'],
['Misc','Misc','0.00'],['Overtime Labor','Per Man','0.00'],['Primer','Equipment with Glue Set Flat Glass','25.00'],
['Self-Locking Gasket','Equipment with Gasket Set Flat Glass','6.00'],['Silicone','[description not supplied]','18.50'],
['Temp Laminated W/Holes','Dozers, Backhoes, Water Trucks','79.25'],['Tinted IGU','1/4" Brz/.090 Clr Lami IGU','0.00'],
['Urethane','Equipment with Glue Set Flat Glass','85.00']
];
export const defaultCatalog = supplied.map(([name, description, price], i) => ({ id: `approved-${i+1}`, name, description, price, category: 'Freeport - FMI', unit: '', treatment: price === '0.00' ? 'Review: variable price or informational' : 'Review source units', review: /not supplied|Doe$|Lexan$/.test(description) }));
export const defaultSettings = {
  id: 'defaults', companyCode: '1328', spreadsheetPO: 'ZD000003NG', consolidatedPO: 'PI-ZD00000669', contract: '33282200158-001',
  referenceLabel: 'Reference Number', partsExpense: '61040078', laborExpense: '61120032', taxRate: '0.091',
  businessName: 'Boulevard Glass LLC', remittance: '', usingArea: '',
  referenceAcceptance: 'Freeport acceptance of the package reference remains to be confirmed.',
  laborReferenceRates: { straight: '125', overtime: '185', holiday: '250', status: 'Sample-derived; awaiting administrative confirmation' },
  accounts: [], catalog: defaultCatalog,
  aliases: [
    { name: 'Labor', description: 'Per Man', classification: 'Labor', exportDescription: 'Tech Labor - Straight' },
    { name: 'Overtime Labor', description: 'Per Man', classification: 'Labor', exportDescription: 'Tech Labor - Overtime' },
    { name: 'Holiday Work', description: 'Per Man', classification: 'Labor', exportDescription: 'Tech Labor - Holiday Work' },
    { name: 'After Hours', description: 'Call Out Fee', classification: 'Parts', exportDescription: 'After Hours Call-Out Fee', expense: '61040078' }
  ]
};
