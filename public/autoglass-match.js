// Matching scanned parts to the Omega schedule. Shared by the page and the tests.

// Part numbers compare without spaces, dashes or case: "dw02842-gtyn" is DW02842GTYN.
export const partKey = text => String(text ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// Glass matches on its NAGS number: D or F, a letter, then five digits
// (DW02842). The letters after it (GTYN, GBY) are the version and are ignored.
// It's found anywhere in a scan, so a barcode with extra characters still works.
export const glassNumber = text => partKey(text).match(/[DF][A-Z]\d{5}/)?.[0] || '';

// Other parts (mouldings, adhesive) match on the whole number, or a barcode
// that contains it (6 characters or more).
const samePart = (scanKey, skuKey) => scanKey === skuKey || (skuKey.length >= 6 && scanKey.includes(skuKey));

// The work orders that need the scanned part, each with the SKU it matched.
export function scheduleMatches(partNumber, jobs) {
  const glass = glassNumber(partNumber);
  const key = partKey(partNumber);
  if (!key) return [];
  const matches = sku => (glass ? glassNumber(sku) === glass : samePart(key, partKey(sku)));
  return jobs.flatMap(job => {
    const part = job.parts.find(matches);
    return part ? [{ ...job, part }] : [];
  });
}

// Glass on the schedule that no scan has the NAGS number of yet.
export function unscannedGlass(jobs, partNumbers) {
  const scanned = new Set(partNumbers.map(glassNumber).filter(Boolean));
  return jobs.flatMap(job => job.parts
    .filter(sku => glassNumber(sku) && !scanned.has(glassNumber(sku)))
    .map(sku => ({ ...job, part: sku, glass: glassNumber(sku) })));
}
