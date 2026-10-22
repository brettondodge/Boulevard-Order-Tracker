// Starting configuration, inserted once when the Freeport tables are empty.
// Everything here is editable afterwards in Freeport Admin.

export const defaultSettings = {
  poNumber: 'ZD00000669',
  contractNumber: '33282200158-001',
  companyCode: '1328',
  taxRate: '9.1',
  partsExpense: '61040078',
  laborExpense: '61120032',
  businessName: 'Boulevard Glass LLC',
  businessAddress: '1709 W Thatcher Blvd\nSafford, AZ 85546',
  businessPhone: '(928) 428-1180',
  rocNumber: '216266',
  vendorId: '000019814',
  billTo: 'Freeport McMoRan - Safford\nAccounts Payable\nP.O. Box 25109\nPhoenix, AZ 85002-5109',
  footerNote: '1.5% Late Fee will be applied against all balances past due.'
};

export const defaultAccounts = [
  ['1060201328', 'Mine Maintenance - Drill', 'Mine'],
  ['1060301328', 'Mine Maintenance - Shovel', 'Mine'],
  ['1060401328', 'Mine Maintenance - Truck', 'Mine'],
  ['1060601328', 'Mine Maintenance - Lube', 'Mine'],
  ['1060701328', 'Mine Maintenance - Light Vehicle', 'Mine'],
  ['1060901328', 'Mine Maintenance - Miscellaneous', 'Mine'],
  ['1063001328', 'Mine Maintenance - Electrical', 'Mine'],
  ['1090601328', 'Mine Administration', 'Mine'],
  ['2041101328', 'Mobile Equipment', 'Crush Convey'],
  ['2041301328', 'Maintenance Admin', 'Crush Convey'],
  ['2500001328', 'Leaching Operations', 'Leaching'],
  ['2601601328', 'Sulf Burner - Maintenance', 'Acid Plant'],
  ['2615301328', 'Hydr-General/Administration', 'SX-EW'],
  ['7100101328', 'General Maintenance', 'Admin']
].map(([code, name, group]) => ({ code, name, group, usingAreaName: 'Mine Maintenance', active: true }));

// Built from the January–September 2026 Freeport billing sheet: the items billed
// every month at a fixed price, plus per-line description items for one-off parts
// (each windshield, moulding or crating fee has its own description and price).
// Known Omega SKUs are used; the rest use the description and can be edited in Admin.
export const defaultItems = [
  ['Labor', 'Tech Labor - Straight', 'hr', 'Labor', 12500],
  ['Overtime Labor', 'Tech Labor - Overtime', 'hr', 'Labor', 18500],
  ['Holiday Work', 'Tech Labor - Holiday Work', 'hr', 'Labor', 25000],
  ['24 x 48 (.090 Clr Lami)', '24 x 48 (.090 Clr Lami)', 'ea', 'Parts', 19952],
  ['36 x 48 (.090 Clr Lami)', '36 x 48 (.090 Clr Lami)', 'ea', 'Parts', 29928],
  ['48 x 48 (.090 Clr Lami)', '48 x 48 (.090 Clr Lami)', 'ea', 'Parts', 39904],
  ['60 x 48 (.090 Clr Lami)', '60 x 48 (.090 Clr Lami)', 'ea', 'Parts', 49880],
  ['72 x 48 (.090 Clr Lami)', '72 x 48 (.090 Clr Lami)', 'ea', 'Parts', 59856],
  ['Urethane', 'Urethane', 'ea', 'Parts', 8500],
  ['Primer', 'Primer', 'ea', 'Parts', 2500],
  ['Silicone', 'Silicone', 'ea', 'Parts', 1850],
  ['Self-Locking Gasket', 'Self-Locking Gasket', 'ea', 'Parts', 600],
  ['After Hours', 'After Hours Call-Out Fee', 'ea', 'Parts', 20000],
  ['After Hours - Holiday', 'After Hours - Holiday Call Out Fee', 'ea', 'Parts', 40000],
  ['Recal-Dynamic', 'Recal-Dynamic', 'ea', 'Parts', 10000],
  ['Windshield', 'Windshield (type part # and name)', 'ea', 'Parts', 28500, true],
  ['Special-order part', 'Special-order part (type description)', 'ea', 'Parts', 0, true],
  ['Freight / crating', 'Freight / crating (type description)', 'ea', 'Parts', 0, true]
].map(([sku, description, unit, type, priceCents, customDescription = false]) => ({ sku, description, unit, type, priceCents, customDescription, active: true }));

// Synthetic invoices for local preview databases only (PREVIEW_MODE). Numbers are made up.
const line = (sku, quantity, rateCents, description = '') => ({ sku, quantity, rateCents, description });
export const previewInvoices = [
  {
    number: '90001', omegaDate: '2026-09-04', installDate: '2026-09-03', orderNumber: '100000900101', accountCode: '1060401328', status: 'Ready',
    lines: [line('36 x 48 (.090 Clr Lami)', '1', 29928), line('Silicone', '1', 1850), line('Labor', '2', 12500), line('Labor', '2', 12500)]
  },
  {
    number: '90002', omegaDate: '2026-09-11', installDate: '2026-09-10', orderNumber: '100000900102', accountCode: '1060201328', status: 'Ready',
    lines: [line('Windshield', '1', 28500, 'DW02153GTYN Windshield'), line('Urethane', '1', 8500), line('Primer', '1', 2500), line('Labor', '3', 12500)]
  },
  {
    number: '90003', omegaDate: '2026-09-18', installDate: '2026-09-14', orderNumber: '100000900103', accountCode: '1060701328', status: 'Ready',
    lines: [line('24 x 48 (.090 Clr Lami)', '1', 19952), line('Silicone', '1', 1850), line('After Hours', '1', 20000), line('Overtime Labor', '3.5', 18500), line('Overtime Labor', '3.5', 18500)]
  },
  {
    number: '90004', omegaDate: '2026-09-25', installDate: '2026-09-22', orderNumber: '100000900104', accountCode: '1060901328', status: 'Needs review',
    lines: [line('60 x 48 (.090 Clr Lami)', '1', 45000), line('Primer', '1', 2500), line('Labor', '2.5', 12500)]
  },
  {
    number: '90005', omegaDate: '2026-10-06', installDate: '2026-09-29', orderNumber: '100000900105', accountCode: '1060301328', status: 'Needs review',
    lines: [line('48 x 48 (.090 Clr Lami)', '1', 39904), line('Window Film', '1', 4000), line('After Hours', '1', 20000), line('Overtime Labor', '4', 18500), line('Overtime Labor', '4', 18500)]
  },
  {
    number: '89901', omegaDate: '2026-08-12', installDate: '2026-08-11', orderNumber: '100000890101', accountCode: '1060401328', status: 'Ready',
    lines: [line('60 x 48 (.090 Clr Lami)', '1', 49880), line('Urethane', '1', 8500), line('Labor', '2', 12500), line('Labor', '2', 12500)]
  }
];
