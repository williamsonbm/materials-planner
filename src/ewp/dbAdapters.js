// =============================================================
// dbAdapters.js — PURE adapters between the ewp_dev tables and the engine.
// =============================================================
// Phase 3b glue. These functions have NO database access — server.js runs the
// SQL (so the queries live next to the other route SQL) and hands the rows here
// to be reshaped into / out of the engine's item shapes. Keeping them pure makes
// them unit-testable without a live Postgres.
//
//   inventoryItemsFromRows(rows)        ewp_optimizer_inventory  → engine inventory items
//   specialOrderInventoryStubs(sizes)   special-order sizes      → zero-qty inventory keys
//   demandToCutItems(rows, jobOrder)    ewp_demand               → engine cut items (+ header per job)
//   mapCutTarget(engineCutFrom, isSO)   engine board sourcing    → {cut_from, status} (plan §3.2)
//   orderJobsByShip(rows, requested)    demand rows + caller order → job numbers, ship-date order
//   fmtDate / isoOrNull                 date helpers
// =============================================================

const { extractDepth } = require('./extractDepth.js');
const { DEFAULT_PURCHASE_LENGTHS_BY_CAT, IJOIST_LENGTH_MENU } = require('./optimizeCuts.js');

// ── ewp_optimizer_inventory rows → engine inventory items ────────────────────
// One engine inventory item per (item, span). qty = available boards. The view
// already nets on_hand − open committed and EXCLUDES special-order series, so we
// only reshape. `item` is the display string resolved by the SQL COALESCE join;
// depth is derived with the engine's own extractDepth (display-only — the solver
// matches on normalizeSize(item)+span, not depth).
//
// available can be negative (a key over-committed against on-hand); we clamp to 0
// so the engine never "draws" a board that isn't there (fillPack only uses qty>0
// anyway, but a negative would corrupt the inventory-impact start counts).
function inventoryItemsFromRows(rows) {
  return rows.map((r) => {
    const item = r.item;
    const it = {
      source: 'inventory',
      depth: extractDepth(item),
      item,
      span: Number(r.span),
      qty: Math.max(0, Number(r.available) || 0),
    };
    if (r.threshold !== null && r.threshold !== undefined) it.threshold = Number(r.threshold);
    return it;
  });
}

// ── special-order series → zero-qty inventory keys ──────────────────────────
// ewp_optimizer_inventory excludes special-order series (PJI-65, design note §7),
// so a job needing one has NO inventory row for it — which would trip the engine's
// `no_inventory_match` pre-flight and BLOCK the whole job. We seed a zero-qty key
// (span 0, never drawn — fillPack requires qty>0 and span>=length) so the engine
// instead routes the piece to `purchase` (allow-buy, commit remaps → special-order)
// or `unfulfillable` (on-hand-only shortfall). Emitted ONLY when special-order
// sizes are actually present, so jobs without them see byte-identical engine input.
function specialOrderInventoryStubs(sizes) {
  return [...new Set(sizes)].map((item) => ({ source: 'inventory', item, span: 0, qty: 0 }));
}

// ── ewp_demand rows → engine cut items (+ one header per job) ────────────────
// Rebuilds the parseJobCsv-shaped array WITHOUT re-parsing the CSV. Jobs are
// emitted in `jobOrder` (ship-date order, caller-ties — see orderJobsByShip),
// which is also the inventory-depletion order optimizeCuts uses for a multi-job
// run, so soonest-ship jobs claim scarce lengths first.
function demandToCutItems(rows, jobOrder) {
  const byJob = new Map();
  for (const r of rows) {
    if (!byJob.has(r.job_number)) byJob.set(r.job_number, []);
    byJob.get(r.job_number).push(r);
  }
  const out = [];
  for (const jn of jobOrder) {
    const jrows = byJob.get(jn);
    if (!jrows || !jrows.length) continue;
    const first = jrows[0];
    const deliveryDate = fmtDate(first.delivery_date);
    out.push({
      kind: 'header', source: 'cuts',
      jobNumber: jn, jobName: first.job_name || 'Unknown', deliveryDate,
    });
    for (const r of jrows) {
      out.push({
        kind: 'material', source: 'cuts',
        jobNumber: jn, jobName: r.job_name || 'Unknown', deliveryDate,
        category: r.category,
        size: r.size_display,
        qty: Number(r.qty),
        decimalFeet: Number(r.required_length),
        label: r.cut_label,
      });
    }
  }
  return out;
}

// ── engine board sourcing → ledger {cut_from, status} (plan §3.2) ────────────
// status is ALWAYS 'committed' at commit time (lifecycle lives on status; sourcing
// on cut_from). The engine only ever emits cutFrom 'on-hand' | 'purchase'. A
// 'purchase' board whose size is a special-order series is routed to special-order
// (never deducts on-hand) instead of awaiting-delivery.
function mapCutTarget(engineCutFrom, isSpecialOrder) {
  if (engineCutFrom === 'on-hand') return { cut_from: 'on-hand', status: 'committed' };
  if (isSpecialOrder)              return { cut_from: 'special-order', status: 'committed' };
  return { cut_from: 'awaiting-delivery', status: 'committed' };  // purchase
}

// ── ship-date ordering with caller tie-break ─────────────────────────────────
// Stable-sorts the requested job numbers by their ship date (soonest first; NULL
// dates last). SAME-DAY TIES preserve the caller's array order (locked w/ Blake
// 2026-06-20: the Optimize tab lets the user arrange same-day jobs). Returns only
// the requested jobs that actually appear in `rows`.
function orderJobsByShip(rows, requestedOrder) {
  const ship = new Map();
  for (const r of rows) if (!ship.has(r.job_number)) ship.set(r.job_number, r.delivery_date);
  return requestedOrder
    .filter((jn) => ship.has(jn))
    .map((jn, i) => {
      const d = ship.get(jn);
      const t = d ? new Date(d).getTime() : Infinity;
      return { jn, i, t: Number.isNaN(t) ? Infinity : t };
    })
    .sort((a, b) => (a.t - b.t) || (a.i - b.i))
    .map((x) => x.jn);
}

// pg returns date columns as JS Date objects; normalize to ISO YYYY-MM-DD for the
// engine (buildPullList sorts on Date.parse(deliveryDate)). 'Unknown' when absent.
function fmtDate(d) {
  if (!d) return 'Unknown';
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d);
}

// MiTek delivery dates arrive as "M/D/YYYY" strings from parseJobCsv; convert to
// an ISO YYYY-MM-DD the date column accepts, or null if unparseable / "Unknown".
function isoOrNull(s) {
  if (!s || s === 'Unknown') return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(s).trim());
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// ── item/size text → engine category (Cut-list editor's Repository panel) ───
// ewp_optimizer_inventory carries no category column (it's keyed on item/span
// only), so the editor-stock route classifies from the display text — the
// same three-way split the client's CUT_SECTIONS test already uses to bucket
// the cut-list UI. Order matters: "Rim Board" text never matches the other
// two, but check it before the broad "joist" fallback regardless.
function classifyEwpCategory(text) {
  const s = String(text || '');
  if (/pji|tji|bci|lpi|i-?joist|i-?shape|joist/i.test(s)) return 'I-Joist';
  if (/lvl|rigidlam|rectangular/i.test(s)) return 'LVL';
  if (/rim/i.test(s)) return 'RimBoard';
  return null;
}

// ── purchaseLengthsFor() precedence, replicated (optimizeCuts.js keeps the
// original un-exported — see design note) ────────────────────────────────
// Mirrors optimizeCuts.js exactly: an active I-Joist preset entry for `depth`
// wins (intersected with the full menu), else the per-category supplier
// default. `ijoistLengthsByDepth` is opts.ijoistLengthsByDepth from
// ewpOptimizeOpts() (null when no active preset row).
function purchaseLengthsForReplica(category, depth, ijoistLengthsByDepth) {
  if (category === 'I-Joist' && ijoistLengthsByDepth && depth &&
      Array.isArray(ijoistLengthsByDepth[depth])) {
    const allowed = new Set(ijoistLengthsByDepth[depth]);
    return IJOIST_LENGTH_MENU.filter((l) => allowed.has(l));
  }
  return DEFAULT_PURCHASE_LENGTHS_BY_CAT[category] || [];
}

module.exports = {
  inventoryItemsFromRows,
  specialOrderInventoryStubs,
  demandToCutItems,
  mapCutTarget,
  orderJobsByShip,
  fmtDate,
  isoOrNull,
  classifyEwpCategory,
  purchaseLengthsForReplica,
};
