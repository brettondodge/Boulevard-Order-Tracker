import { createHash } from 'node:crypto';

const normalized = value => String(value || '').trim().toLowerCase();

export function supplierCleanupPlan(suppliers, orders, includeHistorical = false) {
  const inactive = suppliers.filter(row => Number(row.active) === 0).sort((a, b) => a.id.localeCompare(b.id));
  const byId = new Map(inactive.map(row => [row.id, row]));
  const activeNames = new Set(suppliers.filter(row => Number(row.active) !== 0).map(row => normalized(row.name)));
  const byName = new Map();
  for (const row of inactive) {
    // An ID-free historical name must not also identify an active supplier.
    if (!activeNames.has(normalized(row.name))) byName.set(normalized(row.name), row);
  }
  const counts = new Map(inactive.map(row => [row.id, 0]));
  const knownNames = new Set(suppliers.map(row => normalized(row.name)));
  const historical = new Map();
  const selected = orders.filter(order => {
    const supplier = order.supplier_id ? byId.get(order.supplier_id) : byName.get(normalized(order.supplier));
    if (supplier) {
      counts.set(supplier.id, counts.get(supplier.id) + 1);
      return true;
    }
    const name = normalized(order.supplier);
    if (!includeHistorical || order.supplier_id || !name || knownNames.has(name)) return false;
    if (!historical.has(name)) historical.set(name, { name: order.supplier.trim(), order_count: 0 });
    historical.get(name).order_count += 1;
    return true;
  }).sort((a, b) => a.id.localeCompare(b.id));
  return {
    suppliers: inactive.map(row => ({ id: row.id, name: row.name, order_count: counts.get(row.id) })),
    supplier_count: inactive.length,
    historical_suppliers: [...historical.values()].sort((a, b) => a.name.localeCompare(b.name)),
    historical_supplier_count: historical.size,
    order_count: selected.length,
    order_ids: selected.map(row => row.id),
    fingerprint: createHash('sha256').update(JSON.stringify({ includeHistorical, suppliers: inactive, orders: selected })).digest('hex')
  };
}

export function requireUnchangedCleanup(plan, expectedFingerprint) {
  if (!expectedFingerprint || plan.fingerprint !== expectedFingerprint) {
    const error = new Error('The suppliers or linked orders changed. Preview the cleanup again.');
    error.code = 'CLEANUP_CHANGED';
    throw error;
  }
}
