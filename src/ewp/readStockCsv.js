// =============================================================
// readStockCsv.js — on-hand stock CSV → engine inventory items
// =============================================================
// The planner's second input: what is already on the yard. Emits exactly the
// shape optimizeCuts consumes as inventory —
//
//   { source: "inventory", item, depth, span, qty, threshold? }
//
// This is the CSV counterpart of the web app's readInventory.js, which reads
// XLSX via SheetJS. That module is deliberately NOT ported here: adding `xlsx`
// would double this tool's dependency count for a feature specified as CSV.
// Its RULES are ported, though, and each one is a bug that was already paid for
// once:
//
//   * a file counts as stock only if its header carries `item` and `span`
//     (plus a quantity column) — anything else is rejected by name rather than
//     silently misparsed into an empty inventory, which reads as "no stock" and
//     quietly prices the whole batch as a purchase.
//   * DO NOT de-duplicate (item, span) pairs. Emit every row and let the engine
//     sum them with `+=` (optimizeCuts builds inventoryBySize that way).
//     De-duplicating was a real undercount bug.
//   * skip rows with a blank item or a non-numeric span/qty — those are the
//     subtotal and spacer rows every real export carries, not data.
//   * clamp negative quantities to 0 (from dbAdapters.inventoryItemsFromRows).
//     fillPack would never draw a negative, but it WOULD corrupt the startQty
//     baseline in the inventory-impact report.
// =============================================================
// COLUMNS — looked up by header name, not position, because two real shapes
// exist and both must load:
//
//   item,span,qty,threshold                                    (hand-written)
//   item,span,depth,on_hand,committed,available,incoming,threshold,flag
//
// `available` wins over `qty` when both are present. available = on_hand −
// committed, so it excludes boards already promised to another job; planning
// against `on_hand` would hand the same board to two jobs. Same column the web
// app reads (dbAdapters.inventoryItemsFromRows).
//
// IGNORED on purpose: `on_hand`/`committed` (superseded by `available`),
// `incoming` (material on an inbound PO may not land before the job ships, and
// this tool has no way to check), `flag` (a REORDER flag computed against
// TODAY's stock — the useful signal is what drops below threshold AFTER this
// batch ships, which inventoryImpact computes itself), and `depth` (see below).
// =============================================================

const { parseCsv } = require('./parseCsv.js');
const { extractDepth } = require('./extractDepth.js');

// Header aliases, in preference order. First match in the file wins.
const ITEM_COLS = ['item', 'product', 'description'];
const SPAN_COLS = ['span', 'length', 'stock_length', 'stocklength'];
const QTY_COLS = ['available', 'qty', 'quantity', 'on_hand', 'onhand'];
const THRESHOLD_COLS = ['threshold', 'min', 'minimum'];
const DEPTH_COLS = ['depth'];

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '_');

// Index of the first aliased column present in this header row, or -1.
function findCol(header, aliases) {
  for (const alias of aliases) {
    const i = header.indexOf(alias);
    if (i !== -1) return i;
  }
  return -1;
}

// Find the header row. Real exports sometimes carry a title line above it, so
// scan the first few rows rather than assuming row 0.
function findHeader(rows) {
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const header = rows[r].map(norm);
    if (findCol(header, ITEM_COLS) !== -1 && findCol(header, SPAN_COLS) !== -1) {
      return { row: r, header };
    }
  }
  return null;
}

/**
 * Parse an on-hand stock CSV.
 *
 * @param   {string} text
 * @returns {{ items, skipped, warnings, qtyColumn, rowCount }}
 *          items    — engine inventory items, one per DATA ROW (not de-duped)
 *          skipped  — { line, reason } for each row that wasn't data
 *          warnings — file-level notes worth showing the user
 * @throws  {Error}  when the file has no recognizable header. A stock file that
 *                   silently parses to zero rows is indistinguishable from an
 *                   empty yard, which is the worst possible failure here.
 */
function parseStockCsv(text) {
  const rows = parseCsv(String(text || ''));
  const found = findHeader(rows);
  if (!found) {
    throw new Error(
      'Not a stock CSV: no header row with "item" and "span" columns was found.'
    );
  }
  const { row: headerRow, header } = found;

  const iItem = findCol(header, ITEM_COLS);
  const iSpan = findCol(header, SPAN_COLS);
  const iQty = findCol(header, QTY_COLS);
  const iThreshold = findCol(header, THRESHOLD_COLS);
  const iDepth = findCol(header, DEPTH_COLS);

  if (iQty === -1) {
    throw new Error(
      `Stock CSV has no quantity column — expected one of: ${QTY_COLS.join(', ')}.`
    );
  }

  const items = [];
  const skipped = [];
  const warnings = [];
  let negatives = 0;

  for (let r = headerRow + 1; r < rows.length; r++) {
    const cols = rows[r];
    const line = r + 1;                       // 1-based, matches a text editor
    if (!cols.length || cols.every((c) => !String(c).trim())) continue;   // blank

    const item = String(cols[iItem] ?? '').trim();
    if (!item) { skipped.push({ line, reason: 'blank item' }); continue; }

    const span = Number(String(cols[iSpan] ?? '').trim());
    if (!Number.isFinite(span) || span <= 0) {
      skipped.push({ line, reason: `span is not a positive number ("${cols[iSpan] ?? ''}")` });
      continue;
    }

    const rawQty = String(cols[iQty] ?? '').trim();
    const qty = Number(rawQty);
    if (rawQty === '' || !Number.isFinite(qty)) {
      skipped.push({ line, reason: `quantity is not a number ("${rawQty}")` });
      continue;
    }
    if (qty < 0) negatives++;

    // Depth is INFORMATIONAL — the solver matches on normalizeSize(item)+span
    // and never on depth. Prefer the engine's own extractDepth so the report
    // reads the same as everywhere else in the tool; fall back to the file's
    // column when the item string has no recognizable depth token.
    const depth = extractDepth(item) || String(cols[iDepth] ?? '').trim();

    const inv = {
      source: 'inventory',
      item,
      depth,
      span,
      qty: Math.max(0, qty),
    };

    if (iThreshold !== -1) {
      const t = Number(String(cols[iThreshold] ?? '').trim());
      if (Number.isFinite(t) && t > 0) inv.threshold = t;
    }

    items.push(inv);
  }

  if (negatives) {
    warnings.push(
      `${negatives} row${negatives === 1 ? '' : 's'} had a negative quantity; clamped to 0.`
    );
  }
  if (!items.length) {
    warnings.push('No usable stock rows were found in this file.');
  }

  return {
    items,
    skipped,
    warnings,
    qtyColumn: header[iQty],
    rowCount: items.length,
  };
}

// Cheap sniff for routing a dropped file to the right pile. A MiTek material
// summary has no such header (its first columns are "Job Name:", "LABEL",
// "QTY"), so the two are unambiguous.
function looksLikeStockCsv(text) {
  const rows = parseCsv(String(text || ''));
  const found = findHeader(rows);
  return !!found && findCol(found.header, QTY_COLS) !== -1;
}

module.exports = { parseStockCsv, looksLikeStockCsv };
