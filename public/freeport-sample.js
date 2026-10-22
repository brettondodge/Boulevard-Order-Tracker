// Synthetic preview data for the Freeport shell. Invoice and order numbers are
// made up. Replaced by saved records in build step 2.

export const settings = {
  poNumber: 'ZD00000669',
  contractNumber: '33282200158-001',
  companyCode: '1328',
  taxRate: '9.1',
  partsExpense: '61040078',
  laborExpense: '61120032',
  usingAreaName: 'Mine Maintenance',
  businessName: 'Boulevard Glass LLC',
  businessAddress: '1709 W Thatcher Blvd\nSafford, AZ 85546',
  businessPhone: '(928) 428-1180',
  rocNumber: '216266',
  vendorId: '000019814',
  billTo: 'Freeport McMoRan - Safford\nAccounts Payable\nP.O. Box 25109\nPhoenix, AZ 85002-5109'
};

export const accountCodes = [
  { code: '1060201328', name: 'Mine Maintenance - Drill', group: 'Mine' },
  { code: '1060301328', name: 'Mine Maintenance - Shovel', group: 'Mine' },
  { code: '1060401328', name: 'Mine Maintenance - Truck', group: 'Mine' },
  { code: '1060601328', name: 'Mine Maintenance - Lube', group: 'Mine' },
  { code: '1060701328', name: 'Mine Maintenance - Light Vehicle', group: 'Mine' },
  { code: '1060901328', name: 'Mine Maintenance - Miscellaneous', group: 'Mine' },
  { code: '1063001328', name: 'Mine Maintenance - Electrical', group: 'Mine' },
  { code: '1090601328', name: 'Mine Administration', group: 'Mine' },
  { code: '2041101328', name: 'Mobile Equipment', group: 'Crush Convey' },
  { code: '2041301328', name: 'Maintenance Admin', group: 'Crush Convey' },
  { code: '2500001328', name: 'Leaching Operations', group: 'Leaching' },
  { code: '2601601328', name: 'Sulf Burner - Maintenance', group: 'Acid Plant' },
  { code: '2615301328', name: 'Hydr-General/Administration', group: 'SX-EW' },
  { code: '7100101328', name: 'General Maintenance', group: 'Admin' }
];

// Draft list for the preview; the real list gets confirmed in step 2.
export const items = [
  { sku: '.090 Clear Laminate', description: '24 x 48 (.090 Clr Lami)', unit: 'ea', type: 'Parts', price: '199.52' },
  { sku: '.090 Clear Laminate', description: '36 x 48 (.090 Clr Lami)', unit: 'ea', type: 'Parts', price: '299.28' },
  { sku: '.090 Clear Laminate', description: '48 x 48 (.090 Clr Lami)', unit: 'ea', type: 'Parts', price: '399.04' },
  { sku: '.090 Clear Laminate', description: '60 x 48 (.090 Clr Lami)', unit: 'ea', type: 'Parts', price: '498.80' },
  { sku: '.090 Clear Laminate', description: '72 x 48 (.090 Clr Lami)', unit: 'ea', type: 'Parts', price: '598.56' },
  { sku: 'Urethane', description: 'Urethane', unit: 'ea', type: 'Parts', price: '85.00' },
  { sku: 'Primer', description: 'Primer', unit: 'ea', type: 'Parts', price: '25.00' },
  { sku: 'Silicone', description: 'Silicone', unit: 'ea', type: 'Parts', price: '18.50' },
  { sku: 'Self-Locking Gasket', description: 'Self-Locking Gasket', unit: 'ea', type: 'Parts', price: '6.00' },
  { sku: 'After Hours', description: 'After Hours Call-Out Fee', unit: 'ea', type: 'Parts', price: '200.00' },
  { sku: 'Labor', description: 'Tech Labor - Straight', unit: 'hr', type: 'Labor', price: '125.00' },
  { sku: 'Overtime Labor', description: 'Tech Labor - Overtime', unit: 'hr', type: 'Labor', price: '185.00' },
  { sku: 'Holiday Work', description: 'Tech Labor - Holiday Work', unit: 'hr', type: 'Labor', price: '250.00' }
];

const line = (sku, quantity, rate) => ({ sku, quantity, rate });

export const invoices = [
  {
    number: '90001', omegaDate: '2026-09-04', installDate: '2026-09-03', month: '2026-09',
    orderNumber: '100000900101', accountCode: '1060401328', status: 'Ready',
    lines: [line('.090 Clear Laminate', '1', '299.28'), line('Silicone', '1', '18.50'), line('Labor', '2', '125.00'), line('Labor', '2', '125.00')]
  },
  {
    number: '90002', omegaDate: '2026-09-11', installDate: '2026-09-10', month: '2026-09',
    orderNumber: '100000900102', accountCode: '1060201328', status: 'Ready',
    lines: [line('.090 Clear Laminate', '1', '598.56'), line('Urethane', '1', '85.00'), line('Primer', '1', '25.00'), line('Labor', '3', '125.00')]
  },
  {
    number: '90003', omegaDate: '2026-09-18', installDate: '2026-09-14', month: '2026-09',
    orderNumber: '100000900103', accountCode: '1060701328', status: 'Ready',
    lines: [line('.090 Clear Laminate', '1', '199.52'), line('Silicone', '1', '18.50'), line('After Hours', '1', '200.00'), line('Overtime Labor', '3.5', '185.00'), line('Overtime Labor', '3.5', '185.00')]
  },
  {
    number: '90004', omegaDate: '2026-09-25', installDate: '2026-09-22', month: '2026-09',
    orderNumber: '100000900104', accountCode: '1060901328', status: 'Needs review',
    lines: [line('.090 Clear Laminate', '1', '450.00'), line('Primer', '1', '25.00'), line('Labor', '2.5', '125.00')]
  },
  {
    number: '90005', omegaDate: '2026-10-06', installDate: '2026-09-29', month: '2026-09',
    orderNumber: '100000900105', accountCode: '1060301328', status: 'Needs review',
    lines: [line('.090 Clear Laminate', '1', '399.04'), line('Window Film', '1', '40.00'), line('After Hours', '1', '200.00'), line('Overtime Labor', '4', '185.00'), line('Overtime Labor', '4', '185.00')]
  },
  {
    number: '89901', omegaDate: '2026-08-12', installDate: '2026-08-11', month: '2026-08',
    orderNumber: '100000890101', accountCode: '1060401328', status: 'Ready',
    lines: [line('.090 Clear Laminate', '1', '498.80'), line('Urethane', '1', '85.00'), line('Labor', '2', '125.00'), line('Labor', '2', '125.00')]
  },
  {
    number: '89902', omegaDate: '2026-08-27', installDate: '2026-08-26', month: '2026-08',
    orderNumber: '100000890102', accountCode: '1060901328', status: 'Ready',
    lines: [line('Silicone', '2', '18.50'), line('Labor', '1.5', '125.00')]
  }
];

export const months = {
  '2026-08': { status: 'Sent', sentOn: '2026-09-02', revision: 0 },
  '2026-09': { status: 'Open', revision: 0 }
};
