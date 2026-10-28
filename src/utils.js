export const PHOENIX_TIMEZONE = 'America/Phoenix';
export const ORDER_CATEGORIES = ['Windows', 'Flat Glass', 'Showers', 'Storefront'];
export const GROUP_LABELS = {
  'Windows / Flat Glass': ['Windows', 'Flat Glass'],
  'Heavy Glass / Storefront': ['Showers', 'Storefront']
};

export function todayPhoenixString() {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: PHOENIX_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });

  const parts = formatter.formatToParts(new Date());
  const map = {};

  for (const part of parts) {
    if (part.type !== 'literal') {
      map[part.type] = part.value;
    }
  }

  return `${map.year}-${map.month}-${map.day}`;
}

export function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeDate(value) {
  const text = normalizeText(value);
  if (!text) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  return '';
}

export function normalizeCategory(value) {
  const text = normalizeText(value);
  return ORDER_CATEGORIES.includes(text) ? text : '';
}

export function getOrderGroup(category) {
  const normalized = normalizeCategory(category);
  if (!normalized) return '';

  if (GROUP_LABELS['Windows / Flat Glass'].includes(normalized)) {
    return 'Windows / Flat Glass';
  }

  if (GROUP_LABELS['Heavy Glass / Storefront'].includes(normalized)) {
    return 'Heavy Glass / Storefront';
  }

  return '';
}

export function statusFromOrder(order) {
  if (!order) return 'Ordered';
  return order.date_received ? 'Received' : 'Ordered';
}

export function isOrderOverdue(order) {
  if (!order || order.status !== 'Ordered') {
    return false;
  }

  if (!order.expected_delivery_date) {
    return false;
  }

  return order.expected_delivery_date < todayPhoenixString();
}

// Furthest step an order has reached: ordered (or overdue), received,
// scheduled, complete. Complete is the last step (done), even if this
// order's Received box was never ticked.
export function orderStage(order) {
  if (Number(order.job_completed)) return 'complete';
  if (!order.date_received) return isOrderOverdue({ ...order, status: 'Ordered' }) ? 'overdue' : 'ordered';
  if (Number(order.job_scheduled)) return 'scheduled';
  return 'received';
}

export const PROGRESS_FIELDS = ['job_scheduled', 'scheduled_date', 'schedule_note', 'job_completed', 'completed_date'];

// Job progress from a request. Marking a job complete without a date uses
// today, unless restoring saved values exactly (fillCompletedDate: false).
export function normalizeProgressInput(payload = {}, { fillCompletedDate = true } = {}) {
  const flag = value => (value === true || value === 1 || value === '1' || value === 'true' ? 1 : 0);
  const scheduled = flag(payload.job_scheduled);
  const completed = flag(payload.job_completed);
  return {
    job_scheduled: scheduled,
    scheduled_date: scheduled ? normalizeDate(payload.scheduled_date) : '',
    schedule_note: normalizeText(payload.schedule_note),
    job_completed: completed,
    completed_date: completed ? (normalizeDate(payload.completed_date) || (fillCompletedDate ? todayPhoenixString() : '')) : ''
  };
}

export function normalizeOrderInput(payload = {}) {
  const customerName = normalizeText(payload.customer_name);
  const supplier = normalizeText(payload.supplier);
  const orderedBy = normalizeText(payload.ordered_by);
  const orderedById = normalizeText(payload.ordered_by_id);
  const supplierId = normalizeText(payload.supplier_id);
  const dateOrdered = normalizeDate(payload.date_ordered) || todayPhoenixString();
  const expectedDelivery = normalizeDate(payload.expected_delivery_date);
  const receivedDate = normalizeDate(payload.date_received);
  const category = normalizeCategory(payload.category);

  return {
    customer_name: customerName,
    supplier,
    supplier_id: supplierId,
    category,
    combined_group: getOrderGroup(category),
    housecall_job_number: normalizeText(payload.housecall_job_number),
    housecall_job_link: normalizeText(payload.housecall_job_link),
    po_number: normalizeText(payload.po_number),
    date_ordered: dateOrdered,
    expected_delivery_date: expectedDelivery,
    date_received: receivedDate,
    ordered_by: orderedBy,
    ordered_by_id: orderedById,
    shop_location: normalizeText(payload.shop_location),
    notes: typeof payload.notes === 'string' ? payload.notes.trim() : ''
  };
}

export function isoNow() {
  return new Date().toISOString();
}
