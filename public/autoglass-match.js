// Matching scanned parts to the Omega schedule. Shared by the page and the tests.

// Part numbers compare without spaces, dashes or case: "dw02842-gtyn" is DW02842GTYN.
export const partKey = text => String(text ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// NAGS glass numbers start with two letters and five digits (DW02842); the
// letters after that are the version (tint, features).
export const glassBase = key => key.match(/^[A-Z]{2}\d{5}/)?.[0] || '';
export const isGlassPart = sku => Boolean(glassBase(partKey(sku)));

// A barcode can carry the part number with extra characters around it, so a
// scan that contains a scheduled SKU (6 characters or more) counts as that part.
const sameKey = (scanKey, skuKey) => scanKey === skuKey || (skuKey.length >= 6 && scanKey.includes(skuKey));

// Work orders that need the scanned part (exact), or the same glass in another
// version (close). Each job is listed once, with the SKU it matched.
export function scheduleMatches(partNumber, jobs) {
  const key = partKey(partNumber);
  const exact = [];
  const close = [];
  if (!key) return { exact, close };
  const base = glassBase(key);
  for (const job of jobs) {
    const exactPart = job.parts.find(sku => sameKey(key, partKey(sku)));
    const closePart = !exactPart && base && job.parts.find(sku => glassBase(partKey(sku)) === base);
    if (exactPart) exact.push({ ...job, part: exactPart });
    else if (closePart) close.push({ ...job, part: closePart });
  }
  return { exact, close };
}

// Glass on the schedule that no scan matches exactly yet.
export function unscannedGlass(jobs, partNumbers) {
  const keys = partNumbers.map(partKey).filter(Boolean);
  return jobs.flatMap(job => job.parts
    .filter(sku => isGlassPart(sku) && !keys.some(key => sameKey(key, partKey(sku))))
    .map(sku => ({ ...job, part: sku })));
}
