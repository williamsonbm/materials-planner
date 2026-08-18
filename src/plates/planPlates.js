// =============================================================
// planPlates.js — "across these jobs, what plates do we need to buy?"
// =============================================================
// The plate counterpart of selectStockLengths.js, and far simpler, because
// PLATES ARE NOT CUT. There is no packing, no length search, no combinatorics:
// demand is a sum, stock is a subtraction. What the tool actually adds is the
// last step — converting a shortfall in EACHES into something orderable.
//
// THE CONVERSION IS THE POINT. Plates are counted and consumed in eaches but
// PURCHASED in boxes, packs or pallets (plate_pack_factor, 72 rows, covering
// 57/57 stocked SKUs). A box is 32 eaches for some SKUs and 14,100 for others;
// banded plates carry both a 20-each pack and a 22,000-each pallet — units
// 1,100x apart. "You need 400 more" is a demand figure, not an order. Doing that
// arithmetic by hand across a dozen jobs is exactly where an expensive mistake
// happens, which is why this exists rather than a spreadsheet.
//
// WHAT IT DELIBERATELY DOES NOT DO
//   * never writes anything, anywhere. No database, no files. Re-import to
//     re-view. (ADR 0005 in the inventory app repo.)
//   * never nets out `incoming`. Material on an open PO is REPORTED beside the
//     buy figure, never subtracted from it. Double-ordering is the error a
//     purchasing tool most has to avoid; silently hiding a delivery-timing
//     judgement from the buyer is the second. Both are the buyer's call, so
//     both numbers are shown.
//   * never drops a SKU it cannot price. An unrecognised plate goes to
//     `unmatched` where it stays visible — a plate that vanishes from a
//     purchasing review is worse than one flagged "we don't stock this".
//
// BASELINE = `available` (on hand − committed), not on hand. Committed plates
// are promised to other jobs; planning against on-hand hands the same plate out
// twice. Concretely, from live data on 2026-08-12: MT20HS10X12 had 3,600 on hand
// and 4,794 committed. Against on-hand the tool would say "you're fine"; against
// available it says you are already 1,194 short before these jobs exist.
// =============================================================

const { parsePlateSummary } = require('./parsePlateSummary.js');
const { skuKey } = require('./readPlateStockCsv.js');
const PACK_FACTORS = require('./packFactors.json');

// Standard stocked plates list provided by engineering / yard operations.
// Plates outside this set are non-stocked special orders and flagged for redesign.
const STOCKED_PLATES = new Set([
  // M18AHS / MT18AHS (11 SKUs)
  'MT18AHS3X8', 'MT18AHS3X10', 'MT18AHS5X14', 'MT18AHS6X8', 'MT18AHS6X10',
  'MT18AHS6X14', 'MT18AHS7X8', 'MT18AHS7X10', 'MT18AHS8X10', 'MT18AHS8X14',
  'MT18AHS10X10',
  // MT20 (29 SKUs)
  'MT2015X3', 'MT2015X4', 'MT202X4', 'MT203X3', 'MT203X4', 'MT203X6',
  'MT203X8', 'MT203X10', 'MT204X4', 'MT204X5', 'MT204X7', 'MT204X10',
  'MT204X12', 'MT205X5', 'MT205X6', 'MT205X7', 'MT205X8', 'MT205X12',
  'MT206X6', 'MT206X8', 'MT207X8', 'MT207X10', 'MT207X14', 'MT208X8',
  'MT208X14', 'MT2010X10', 'MT2010X14', 'MT2012X12', 'MT2012X14',
  // MT20HS (4 SKUs)
  'MT20HS5X10', 'MT20HS6X12', 'MT20HS7X10', 'MT20HS10X12',
]);

// key → ALL pack factors for that SKU. Built once at require time; the table is
// static reference data and changes only when a supplier changes packaging.
//
// WHY AN ARRAY, NOT A SINGLE ENTRY. 72 rows cover 57 distinct SKUs — 15 of them
// appear TWICE, once banded and once boxed, with the same sku_display and wildly
// different packaging (MT20 4x4 is a 20-each pack with a 15,400 pallet as
// MT20-BAND, and a 330-each box as MT20-BOX). A plain Map keyed on SKU keeps
// whichever row happens to be last and silently prices the other option out of
// existence — caught by test/plates.test.js during the first run of this file.
// Both are genuinely orderable, so both are offered.
const PACK_BY_KEY = new Map();
for (const p of PACK_FACTORS) {
  const k = skuKey(p.sku);
  if (!PACK_BY_KEY.has(k)) PACK_BY_KEY.set(k, []);
  PACK_BY_KEY.get(k).push(p);
}

/**
 * Convert a shortfall in eaches into EVERY orderable option.
 *
 * Always rounds UP — you cannot buy 0.4 of a box — and reports the overshoot so
 * the buyer sees what they are committing to. Nothing is chosen on their behalf:
 * a banded MT20 4x4 shortfall of 506 is 26 packs (14 spare), 2 boxes (154 spare)
 * or 1 pallet (14,894 spare), and which of those is actually orderable is a
 * supplier and price question this tool has no business deciding. It ranks them
 * by overshoot and shows the lot.
 *
 * @param eaches  shortfall
 * @param packs   array of pack-factor rows for this SKU (may be several)
 */
function toPurchaseUnits(eaches, packs) {
  if (!packs || !(eaches > 0)) return null;
  const list = Array.isArray(packs) ? packs : [packs];
  const options = [];

  for (const pack of list) {
    if (!pack) continue;
    if (pack.eaches_per_unit > 0) {
      const units = Math.ceil(eaches / pack.eaches_per_unit);
      options.push({
        unit: pack.unit_label || 'unit',
        productLine: pack.product_line || null,
        eachesPerUnit: pack.eaches_per_unit,
        units,
        totalEaches: units * pack.eaches_per_unit,
        leftover: units * pack.eaches_per_unit - eaches,
      });
    }
    if (pack.pallet_eaches > 0) {
      const units = Math.ceil(eaches / pack.pallet_eaches);
      options.push({
        unit: 'pallet',
        productLine: pack.product_line || null,
        eachesPerUnit: pack.pallet_eaches,
        units,
        totalEaches: units * pack.pallet_eaches,
        leftover: units * pack.pallet_eaches - eaches,
      });
    }
  }
  // Smallest overshoot first — usually the sane default, but all stay visible.
  options.sort((a, b) => a.leftover - b.leftover || a.unit.localeCompare(b.unit));
  return options.length ? options : null;
}

/**
 * @param files  [{ name, text }]  MiTek Material Summary CSVs
 * @param stock  parsePlateStockCsv() result, or null to plan greenfield
 * @returns a report; writes nothing
 */
function planPlates(files, stock) {
  const jobs = [];
  const rejected = [];
  // key → { sku, eaches, byJob: [{job, qty}] }
  const demand = new Map();

  for (const f of files || []) {
    let parsed;
    try {
      parsed = parsePlateSummary(String(f.text || ''));
    } catch (err) {
      rejected.push({ name: f.name, reason: `parse failed: ${err.message}` });
      continue;
    }
    if (!parsed.ok) {
      rejected.push({ name: f.name, reason: parsed.reason || 'not a material summary' });
      continue;
    }
    const meta = parsed.meta || {};
    const job = meta.job_number || f.name;

    // A job with zero plate lines is NOT an error — an EWP-only or hanger-only
    // job legitimately has none. It is listed with 0 so the buyer can see the
    // file was read and considered, rather than wondering if it was dropped.
    jobs.push({
      file: f.name,
      jobNumber: job,
      jobName: meta.job_name || 'Unknown',
      deliveryDate: meta.delivery_date || 'Unknown',
      plateLines: parsed.lines.length,
      eaches: parsed.lines.reduce((s, l) => s + (Number(l.qty) || 0), 0),
      warnings: parsed.warnings || [],
    });

    for (const line of parsed.lines) {
      const qty = Number(line.qty) || 0;
      if (qty <= 0) continue;
      const key = skuKey(line.sku);
      if (!demand.has(key)) demand.set(key, { sku: line.sku, key, eaches: 0, byJob: [] });
      const d = demand.get(key);
      d.eaches += qty;
      d.byJob.push({
        job, jobName: meta.job_name || '', qty,
        deliveryDate: meta.delivery_date || null,
      });
    }
  }

  const bySku = (stock && stock.bySku) || new Map();
  const rows = [];
  const unmatched = [];

  for (const d of demand.values()) {
    const s = bySku.get(d.key) || null;
    const packs = PACK_BY_KEY.get(d.key) || null;

    // Use the RAW figure, negatives included. Clamping to 0 here was a real bug:
    // it hid the shortfall already in the ledger AND discarded genuinely committed
    // plates, so the tool under-ordered. A negative available is a data fault, but
    // "need 488 / have -702 / buy 1,190" is arithmetic the buyer can check at a
    // glance, whereas "have 0 / buy 488" is a number they have to take on trust —
    // and it is too small. Under-ordering is the worse failure: surplus plates can
    // go back on the shelf, a missing plate stops a build. The negative is flagged
    // loudly elsewhere so nobody orders against it without knowing. (Blake, 2026-08-13.)
    const available = s ? s.availableRaw : 0;
    const short = Math.max(0, d.eaches - available);

    const isStocked = STOCKED_PLATES.has(d.key);

    const row = {
      sku: d.sku,
      key: d.key,
      needEaches: d.eaches,
      availableEaches: available,
      isStocked,
      // True when `available` is impossible (below zero) and the buy figure
      // therefore includes an existing ledger shortfall as well as this batch.
      negativeStock: available < 0,
      // The part of `short` that is this batch's own demand, so the UI can show
      // "488 for these jobs + 702 already short" rather than one opaque total.
      shortFromJobs: Math.min(d.eaches, short),
      shortFromLedger: Math.max(0, short - d.eaches),
      shortEaches: short,
      incoming: s ? s.incoming : null,
      threshold: s ? s.threshold : null,
      inStockFile: !!s,
      purchase: toPurchaseUnits(short, packs),
      packKnown: !!packs,
      // Sorted biggest-shortfall-first inside the row too, so expanding a row
      // shows the job driving it at the top.
      byJob: d.byJob.slice().sort((a, b) => b.qty - a.qty),
    };

    // Anything we can't price or can't find is surfaced, never dropped.
    if (!s || !packs) unmatched.push({ sku: d.sku, inStockFile: !!s, packKnown: !!packs });
    rows.push(row);
  }

  // Buy list first, biggest shortfall at the top; covered SKUs after, by name.
  rows.sort((a, b) =>
    (b.shortEaches - a.shortEaches) || a.sku.localeCompare(b.sku));

  const toBuy = rows.filter((r) => r.shortEaches > 0);
  return {
    jobs,
    rejected,
    rows,
    toBuy,
    unmatched,
    totals: {
      jobs: jobs.length,
      skusDemanded: rows.length,
      skusShort: toBuy.length,
      eachesDemanded: rows.reduce((s, r) => s + r.needEaches, 0),
      eachesShort: toBuy.reduce((s, r) => s + r.shortEaches, 0),
    },
    stockInfo: stock
      ? {
        rows: stock.rowCount,
        qtyColumn: stock.qtyColumn,
        lastCounted: stock.lastCounted,
        warnings: stock.warnings,
        negatives: stock.negatives,
      }
      : null,
  };
}

module.exports = { planPlates, toPurchaseUnits, PACK_BY_KEY, STOCKED_PLATES };
