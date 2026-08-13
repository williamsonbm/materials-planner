// =============================================================
// inventoryImpact.js - "what shipping these committed jobs does to stock".
// =============================================================
// Given the on-hand inventory (readInventory output) and the committed rows
// (shapeCommittedRows output), produce a before/after report:
//
//   depletion[]: one row per on-hand inventory line actually consumed -
//     { depth, item, stockLength, startQty, used, remaining, threshold, belowThreshold }
//     startQty   = pieces on hand now (summed per item+span, no dedup)
//     used       = pieces this batch consumes
//     remaining  = startQty - used  (projected on-hand after shipping)
//     belowThreshold = remaining < threshold (reorder signal)
//
//   purchases[]: new material NOT taken from stock (cutFrom "purchase") -
//     { category, size, stockLength, qty }
//
// CRITICAL: inventory is consumed per BOARD (stockPieceNumber), not per cut.
// One board can yield several cuts (several committed rows share a
// stockPieceNumber) but only removes ONE piece from stock. So we de-dupe to
// distinct boards before tallying - counting rows would overstate depletion.
//
// Attribution uses the SAME key the optimizer matched on:
// normalizeSize(size) + stockLength === normalizeSize(item) + span.
// =============================================================

const { normalizeSize } = require('./normalizeSize.js');

function inventoryImpact(inventory, rows) {
  // Index current inventory by normalized key + span.
  // key -> { item (display), depth, spans: Map(span -> { start, threshold }) }
  const invByKey = new Map();
  for (const inv of inventory) {
    const key = normalizeSize(inv.item);
    if (!invByKey.has(key)) {
      invByKey.set(key, { item: inv.item, depth: inv.depth, spans: new Map() });
    }
    const rec = invByKey.get(key);
    const span = Number(inv.span);
    if (!rec.spans.has(span)) rec.spans.set(span, { start: 0, threshold: null });
    const s = rec.spans.get(span);
    s.start += Number(inv.qty) || 0;   // sum duplicates (matches optimizer)
    const t = Number(inv.threshold);
    if (Number.isFinite(t) && t > 0) s.threshold = t;
  }

  // Reduce committed rows to distinct boards (one inventory piece each).
  const boards = new Map();  // stockPieceNumber -> { size, stockLength, cutFrom, category }
  for (const r of rows) {
    if (r.cutFrom !== 'on-hand' && r.cutFrom !== 'purchase') continue;
    if (!boards.has(r.stockPieceNumber)) {
      boards.set(r.stockPieceNumber, {
        size: r.size,
        stockLength: Number(r.stockLength),
        cutFrom: r.cutFrom,
        category: r.category
      });
    }
  }

  // Tally on-hand consumption and purchases over distinct boards.
  const usedByKeySpan = new Map();   // `${key}@${span}` -> count
  const purchases = new Map();
  for (const b of boards.values()) {
    if (b.cutFrom === 'on-hand') {
      const k = normalizeSize(b.size) + '@' + b.stockLength;
      usedByKeySpan.set(k, (usedByKeySpan.get(k) || 0) + 1);
    } else {
      const k = b.category + '@' + b.size + '@' + b.stockLength;
      if (!purchases.has(k)) {
        purchases.set(k, { category: b.category, size: b.size, stockLength: b.stockLength, qty: 0 });
      }
      purchases.get(k).qty += 1;
    }
  }

  // Build depletion rows (only inventory lines actually touched).
  const depletion = [];
  for (const [k, used] of usedByKeySpan) {
    const at = k.lastIndexOf('@');
    const key = k.slice(0, at);
    const span = Number(k.slice(at + 1));
    const rec = invByKey.get(key);
    const sInfo = rec ? rec.spans.get(span) : null;
    const start = sInfo ? sInfo.start : 0;
    const threshold = sInfo ? sInfo.threshold : null;
    const remaining = start - used;
    depletion.push({
      depth: rec ? rec.depth : '',
      item: rec ? rec.item : key,
      stockLength: span,
      startQty: start,
      used,
      remaining,
      threshold,
      belowThreshold: threshold != null && remaining < threshold
    });
  }

  // Deterministic ordering.
  depletion.sort((a, b) =>
    String(a.depth).localeCompare(String(b.depth)) ||
    String(a.item).localeCompare(String(b.item)) ||
    a.stockLength - b.stockLength);

  const purchaseList = [...purchases.values()].sort((a, b) =>
    String(a.category).localeCompare(String(b.category)) ||
    String(a.size).localeCompare(String(b.size)) ||
    a.stockLength - b.stockLength);

  return { depletion, purchases: purchaseList };
}

module.exports = { inventoryImpact };
