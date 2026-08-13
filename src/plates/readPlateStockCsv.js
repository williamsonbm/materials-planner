// =============================================================
// readPlateStockCsv.js — plate on-hand CSV → { sku, available, ... }
// =============================================================
// The plate planner's second input: what is already on the yard.
//
// WHY THIS IS NOT src/ewp/readStockCsv.js. That module requires the header to
// carry BOTH `item` AND `span`, and throws by name otherwise — correctly, since
// an EWP board is keyed (item, span) and a stock file that silently parses to
// zero rows is indistinguishable from an empty yard.
//
// Plates have NO span. A plate is keyed by SKU alone; there is no length
// dimension (see hanger-web-app/sql/plate_schema.sql: "PLATE : on_hand =
// SUM(qty), key = sku_norm"). Feeding a plate export to the EWP reader gets it
// rejected, then re-routed to the JOBS pile by looksLikeStockCsv, then rejected
// again as "not an EWP material summary" — two confusing errors for one
// mismatch. Hence a sibling reader rather than a widened one.
//
// The RULES are ported deliberately, each one already paid for once:
//   * reject by name if the header is unrecognizable — never parse to an empty
//     yard, which reads as "nothing in stock" and prices the batch as a buy.
//   * prefer `available` over `on_hand`. available = on_hand − committed, so it
//     excludes plates already promised to another job. Planning against on_hand
//     hands the same plate to two jobs. (ADR 0002 / ADR 0005 in the app repo.)
//   * carry negatives through UNCHANGED in `availableRaw`, and COUNT them for a
//     warning. A negative on-hand is a real data fault (2026-08-12: four plate
//     SKUs at −774 eaches after a count/build ordering error). `available` also
//     exposes a 0-clamped copy, but planPlates deliberately does NOT use it —
//     clamping loses the shortfall already in the ledger and under-orders. See
//     the note above the subtraction in planPlates.js.
//   * skip blank-SKU and non-numeric rows: the subtotal and spacer rows every
//     real export carries.
//
// COLUMNS — by header name, not position. The app's plate export is:
//   sku,on_hand,committed,available,incoming,threshold,flag,last_counted
// `incoming` is READ and carried through, unlike the EWP reader which drops it.
// Plates are ordered in bulk with long lead times, so "already on a PO" is a
// decision the buyer must see. It is never netted out automatically — see
// ADR 0005: hiding the delivery-timing judgement is as wrong as double-ordering.
// =============================================================

const { parseCsv } = require('./parseCsv.js');

// Header aliases, in preference order. First match in the file wins.
const SKU_COLS = ['sku', 'sku_display', 'item', 'product', 'description'];
const QTY_COLS = ['available', 'qty', 'quantity', 'on_hand', 'onhand'];
const ONHAND_COLS = ['on_hand', 'onhand'];
const COMMITTED_COLS = ['committed'];
const INCOMING_COLS = ['incoming'];
const THRESHOLD_COLS = ['threshold', 'min', 'minimum'];
const COUNTED_COLS = ['last_counted', 'counted_at', 'last_count'];

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '_');

// Canonical spelling of the 18-gauge high-strength family. PORTED VERBATIM from
// plate_canon() in the app's sql/016_plate_mt18ahs_reconcile.sql:
//
//   regexp_replace($1, '^MT?18A?HS', 'MT18AHS', 'i')
//
// Four spellings of the same physical plate are in circulation — M18HS, M18AHS,
// MT18HS, MT18AHS — because MT18AHS is the current name and older jobs' material
// summaries carry the older ones. Without this fold, an old job asking for
// "M18AHS 8x10" finds no stock row for the "MT18AHS 8x10" sitting on the shelf
// and the planner reports a full buy for plates you already own.
//
// Deliberately does NOT match M18SHS — that is "18S HS", a different plate, and
// the A? in the pattern cannot swallow the S. Keep it that way.
const plateCanon = (s) => String(s || '').replace(/^MT?18A?HS/i, 'MT18AHS');

// Match key = plate_canon() then norm(), the same two-step the app's SQL applies
// (sku_norm is a STORED generated column over norm(plate_canon(sku_display))).
// norm strips whitespace, dots, slashes, backslashes, dashes and the inch mark,
// then uppercases — so "MT20  1.5x3", "MT20 1.5X3" and "mt20-1.5x3" all collide.
const skuKey = (s) => plateCanon(s).toUpperCase().replace(/[\s./\\"-]/g, '');

function findCol(header, aliases) {
  for (const alias of aliases) {
    const i = header.indexOf(alias);
    if (i !== -1) return i;
  }
  return -1;
}

// Real exports sometimes carry a title line above the header, so scan a few rows.
function findHeader(rows) {
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const header = rows[r].map(norm);
    if (findCol(header, SKU_COLS) !== -1 && findCol(header, QTY_COLS) !== -1) {
      return { row: r, header };
    }
  }
  return null;
}

const numOrNull = (v) => {
  const t = String(v ?? '').trim().replace(/,/g, '');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/**
 * Parse a plate on-hand CSV.
 *
 * @param   {string} text
 * @returns {{ items, bySku, skipped, warnings, qtyColumn, rowCount, negatives, lastCounted }}
 *          items  — [{ sku, key, available, onHand, committed, incoming, threshold }]
 *          bySku  — Map(key → item) for O(1) demand lookup
 * @throws  {Error} when no recognizable header exists.
 */
function parsePlateStockCsv(text) {
  const rows = parseCsv(String(text || ''));
  const found = findHeader(rows);
  if (!found) {
    throw new Error(
      'Not a plate stock CSV: no header row with a SKU column ' +
      `(${SKU_COLS.join('/')}) and a quantity column (${QTY_COLS.join('/')}) was found.`
    );
  }
  const { row: headerRow, header } = found;

  const iSku = findCol(header, SKU_COLS);
  const iQty = findCol(header, QTY_COLS);
  const iOnHand = findCol(header, ONHAND_COLS);
  const iCommitted = findCol(header, COMMITTED_COLS);
  const iIncoming = findCol(header, INCOMING_COLS);
  const iThreshold = findCol(header, THRESHOLD_COLS);
  const iCounted = findCol(header, COUNTED_COLS);

  const items = [];
  const bySku = new Map();
  const skipped = [];
  const warnings = [];
  const negatives = [];
  let lastCounted = null;

  for (let r = headerRow + 1; r < rows.length; r++) {
    const cols = rows[r];
    const line = r + 1;                        // 1-based, matches a text editor
    if (!cols.length || cols.every((c) => !String(c).trim())) continue;

    const sku = String(cols[iSku] ?? '').trim();
    if (!sku) { skipped.push({ line, reason: 'blank sku' }); continue; }

    const qty = numOrNull(cols[iQty]);
    if (qty === null) {
      skipped.push({ line, reason: `quantity is not a number ("${cols[iQty] ?? ''}")` });
      continue;
    }
    if (qty < 0) negatives.push({ sku, qty });

    const counted = iCounted === -1 ? null : String(cols[iCounted] ?? '').trim();
    if (counted && (!lastCounted || counted > lastCounted)) lastCounted = counted;

    const item = {
      sku,
      key: skuKey(sku),
      // Two views of the same number. `availableRaw` is the truth and is what
      // planning uses. `available` is a 0-clamped convenience for any consumer
      // that wants "how many can I actually pull" — NOT for computing a buy
      // quantity, which must see the negative.
      available: Math.max(0, qty),
      availableRaw: qty,
      onHand: iOnHand === -1 ? null : numOrNull(cols[iOnHand]),
      committed: iCommitted === -1 ? null : numOrNull(cols[iCommitted]),
      incoming: iIncoming === -1 ? null : numOrNull(cols[iIncoming]),
      threshold: iThreshold === -1 ? null : numOrNull(cols[iThreshold]),
      lastCounted: counted || null,
    };

    items.push(item);
    // Duplicate SKUs in one export shouldn't happen, but if they do, SUM rather
    // than overwrite — silently keeping the last row is an undercount bug.
    const prev = bySku.get(item.key);
    if (prev) {
      prev.available += item.available;
      prev.availableRaw += item.availableRaw;
      if (prev.incoming != null || item.incoming != null) {
        prev.incoming = (prev.incoming || 0) + (item.incoming || 0);
      }
      warnings.push(`Duplicate SKU "${sku}" appeared more than once; quantities summed.`);
    } else {
      bySku.set(item.key, item);
    }
  }

  if (negatives.length) {
    const total = negatives.reduce((s, n) => s + n.qty, 0);
    warnings.push(
      `${negatives.length} SKU${negatives.length === 1 ? '' : 's'} had NEGATIVE on-hand ` +
      `(${total} eaches total) — treated as 0 for planning. A negative stock figure is a ` +
      `data fault, not an empty shelf; fix it with a physical count before trusting this plan.`
    );
  }
  if (!items.length) warnings.push('No usable stock rows were found in this file.');

  return {
    items, bySku, skipped, warnings, negatives,
    qtyColumn: header[iQty],
    rowCount: items.length,
    lastCounted,
  };
}

// Cheap sniff for routing a dropped file. A MiTek material summary's first
// columns are "Job Name:", "LABEL", "QTY" — no sku+quantity header pair — so
// the two shapes are unambiguous.
function looksLikePlateStockCsv(text) {
  try {
    const rows = parseCsv(String(text || ''));
    return !!findHeader(rows);
  } catch {
    return false;
  }
}

module.exports = { parsePlateStockCsv, looksLikePlateStockCsv, skuKey, plateCanon };
