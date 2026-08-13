// optimizeCuts.js — ported from source-to-port/optimizeCuts.txt
// optimizeCuts-060326 revision. Last verified: 2026-05-25
// Regression-locked by test/ewp-golden.test.js against job 34120J. NOTE: the
// old header note here ("produces 41 rows") was a snapshot against a since-
// replaced inventory and is NOT the golden — board count is inventory-dependent
// and is deliberately not asserted. The stable goldens are 51 COMMITTED ROWS
// (one per cut piece) over a 43-board plan; see ewp-golden.test.js's header.
// =============================================================
// optimizeCuts — inventory-aware bin packing
// =============================================================
// INPUT: merged stream of two item types, discriminated by `source`:
//
//   Cut requirement items (source: "cuts"):
//     { source: "cuts", kind: "material",
//       category: "I-Joist" | "LVL" | "RimBoard",
//       size: "11 7/8\" PJI-40", qty: 11, decimalFeet: 47.4583,
//       label: "J48", jobNumber, jobName, deliveryDate }
//
//   On-hand inventory items (source: "inventory"):
//     { source: "inventory", depth, item, span, qty, threshold? }
//
//   Header items (source: "cuts", kind: "header") pass through.
//   Hanger items (category: "Hanger") pass through without optimization.
//
// OUTPUT: ordered cut plan (one item per stock piece used) + header
// passthrough + hanger passthrough + a trailing summary item.
// =============================================================
// PORT: `const allItems = $input.all().map(i => i.json);` is now a function
// parameter; `return output.map(i => ({ json: i }));` is now `return output;`.
// The in-file extractDepth + KNOWN_DEPTHS were extracted to ./extractDepth.js
// (single source of truth). The algorithm body is unchanged. LNS_SEED is kept
// so output stays deterministic for a given machine + budget (see the LNS
// budget block below for the wall-clock caveat).
// =============================================================

const { extractDepth, KNOWN_DEPTHS } = require('./extractDepth.js');
const { normalizeSize } = require('./normalizeSize.js');

// Packing is done against NOMINAL stock length with NO blade kerf and NO
// stock bonus: real sticks run slightly long, so the saw kerf is absorbed by
// the over-length and never surfaces in planning. A board of length L holds
// cuts summing to <= L exactly; remainder = L - sum(cuts).
// PURCHASE_LENGTHS and LVL_DROP_MIN_FT are the two knobs Phase 2 parameterizes;
// IJOIST_LENGTHS_BY_DEPTH is the Phase-2.5 third knob — a per-I-Joist-depth
// allow-list of stock lengths (from the editable "Board sizes" presets). I-Joist
// only: LVL/RimBoard sourcing is untouched by it.
// PURCHASE_LENGTHS_OVERRIDE / LVL_DROP_MIN_FT / IJOIST_LENGTHS_BY_DEPTH stay
// module-scoped `let`s and are reset from opts at the top of optimizeCuts() — safe
// because optimizeCuts runs fully synchronously to completion per call, so a call's
// helpers always read the value its own entry set. DEFAULT_* preserve the original
// verified behavior. The resolved per-group allow-list is threaded explicitly
// through packGroup → fillPack → retighten (not read from the module `let`), so
// each cut group packs against its own depth's lengths.
// Purchasable stock lengths are PER CATEGORY — what RTW actually orders (Blake 2026-06-22):
//   I-Joist  — the supplier lengths below (NO 24', no odd lengths).
//   RimBoard — 12' only; a 24' need is TWO 12' boards, never one 24' cut in half.
//   LVL      — 48' only; bought full and cut, the offcut returns to stock per the drop rule.
const DEFAULT_PURCHASE_LENGTHS_BY_CAT = {
  "I-Joist":  [48, 44, 40, 36, 34, 32, 30, 28],
  "RimBoard": [12],
  "LVL":      [48],
};
// Every buyable length across categories — the ceiling for "physically makeable" (maxKnownStock).
const ALL_PURCHASE_LENGTHS = [...new Set(Object.values(DEFAULT_PURCHASE_LENGTHS_BY_CAT).flat())];
// The full menu of lengths a "Board sizes" preset may allow for I-Joist, per depth:
// 12'–48' in 2' increments (descending). This is wider than the default supplier
// set above — a preset can opt into any of these (e.g. a 20' or 38'); the engine
// only buys a length a preset actually allows. Drives the editor grid + validation
// (server reads it from here) and is the intersect base for an active preset.
const IJOIST_LENGTH_MENU = [];
for (let l = 48; l >= 12; l -= 2) IJOIST_LENGTH_MENU.push(l);
// Reset per call from opts.purchaseLengths: [] forces no-buy (on-hand-only mode); an explicit
// non-empty list overrides every category (tests / future config); null = per-category defaults.
let PURCHASE_LENGTHS_OVERRIDE = null;
// Reset per call from opts.ijoistLengthsByDepth: a { "<depth>": number[] } allow-list for
// I-Joist, or null (= per-category defaults). opts.ijoistPresetName names it for messages.
const DEFAULT_IJOIST_LENGTHS_BY_DEPTH = null;
let IJOIST_LENGTHS_BY_DEPTH = DEFAULT_IJOIST_LENGTHS_BY_DEPTH;
let IJOIST_PRESET_NAME = null;
// Reset per call from opts.purchaseLengthsByCat: a { "<category>": number[] } override
// of what the SUPPLIER will sell, per category — e.g. { LVL: [48,44,40] } when LVL is
// available in more than the default 48' only. Distinct from PURCHASE_LENGTHS_OVERRIDE,
// which is global and hits every category at once.
let PURCHASE_LENGTHS_BY_CAT = null;
// Reset per call from opts.purchaseLengthsBySize: a { "<normalizeSize(size)>": number[] }
// override, the FINEST grain — what the supplier sells for one specific PRODUCT.
// Depth is not fine enough: 11 7/8" PJI-40 and 11 7/8" TJI 560 share a depth but are
// different SKUs and can be stocked in different lengths (Blake 2026-08-02).
let PURCHASE_LENGTHS_BY_SIZE = null;

// Purchasable lengths for a (category, depth, size), the SINGLE place precedence is
// decided — most specific wins:
//   1. PURCHASE_LENGTHS_OVERRIDE set (incl. [] for on-hand-only) → use it for every
//      category, unchanged. Preserves on-hand-only and the test override path exactly.
//   2. category I-Joist AND a per-PRODUCT entry exists for normalizeSize(size) → that
//      list. The finest grain, because two products can share a depth and still be
//      stocked in different lengths (11 7/8" PJI-40 vs 11 7/8" TJI 560).
//   3. category I-Joist AND a preset entry exists for `depth` → that list, intersected
//      with the full I-Joist menu (descending) so a stray/forged value can't widen
//      it beyond 12–48 by 2', while honoring any menu length the preset allows.
//   4. a per-CATEGORY override entry exists → that list (descending). Lets a caller say
//      "LVL is buyable at 48/44/40" without touching I-Joist or the global override.
//   5. else → the per-category default (DEFAULT_PURCHASE_LENGTHS_BY_CAT).
// ([] is truthy, so on-hand-only's empty list correctly yields "no purchase length".)
//
// NOTE — dbAdapters.js's purchaseLengthsForReplica() mirrors rungs 1/3/5 for the web
// app's cut-target UI. It does NOT know about rungs 2 or 4, which is safe only because
// the app never passes purchaseLengthsBySize or purchaseLengthsByCat. If the app ever
// starts to, update the replica (or better, delete it and call through to here).
function purchaseLengthsFor(category, depth, size) {
  if (PURCHASE_LENGTHS_OVERRIDE) return PURCHASE_LENGTHS_OVERRIDE;
  if (category === "I-Joist" && PURCHASE_LENGTHS_BY_SIZE && size) {
    const forSize = PURCHASE_LENGTHS_BY_SIZE[normalizeSize(size)];
    if (Array.isArray(forSize)) return [...forSize].sort((a, b) => b - a);
  }
  if (category === "I-Joist" && IJOIST_LENGTHS_BY_DEPTH && depth &&
      Array.isArray(IJOIST_LENGTHS_BY_DEPTH[depth])) {
    const allowed = new Set(IJOIST_LENGTHS_BY_DEPTH[depth]);
    // Intersect against the full menu (descending). The Default preset holds only
    // the supplier set, so it still yields [48,44,40,36,34,32,30,28] — byte-identical
    // to the no-preset default — while a wider preset can include 12–26 / 38 / 42 / 46.
    return IJOIST_LENGTH_MENU.filter((l) => allowed.has(l));
  }
  if (PURCHASE_LENGTHS_BY_CAT && Array.isArray(PURCHASE_LENGTHS_BY_CAT[category])) {
    return [...PURCHASE_LENGTHS_BY_CAT[category]].sort((a, b) => b - a);
  }
  return DEFAULT_PURCHASE_LENGTHS_BY_CAT[category] || ALL_PURCHASE_LENGTHS;
}

// LVL remainder >= this many feet is a recoverable DROP that returns to stock,
// so the optimizer treats it as zero-cost when choosing a plan. (Design rule:
// LVL drops at/above the threshold return to stock; I-Joist and RimBoard
// remainders are always true waste regardless of size.) Default 8 keeps the
// golden fixture green; the app feeds ewp_config.lvl_drop_threshold_ft (10) at
// runtime in Phase 3.
const DEFAULT_LVL_DROP_MIN_FT = 8;
let LVL_DROP_MIN_FT = DEFAULT_LVL_DROP_MIN_FT;

// Large-neighborhood search budget. The packer is deterministic (seeded RNG)
// and bounded by BOTH an iteration cap and a wall-clock cap per cut group.
//
// CAVEAT — the wall-clock cap makes a plan machine-speed dependent: LNS_SEED
// guarantees the same plan on the same machine, NOT across machines. A slower
// box completes fewer iterations before DEFAULT_LNS_MAX_MS bites and can settle
// on a different (still valid, possibly worse) plan. Both caps are therefore
// overridable per call so a caller can ask for a machine-independent budget
// (lnsMaxMs: Infinity) or skip the search entirely (lnsMaxIters: 0 — the
// deterministic best-fill seed + retighten only, which is what the stock-length
// sweep in selectStockLengths.js uses to evaluate hundreds of candidates).
const DEFAULT_LNS_MAX_ITERS = 20000;
const DEFAULT_LNS_MAX_MS    = 1500;
let LNS_MAX_ITERS = DEFAULT_LNS_MAX_ITERS;
let LNS_MAX_MS    = DEFAULT_LNS_MAX_MS;
const LNS_SEED    = 0x5eed1;

function optimizeCuts(allItems, opts = {}) {
  // Two-mode + drop-threshold knobs (see the const block above). `??` preserves an
  // explicit [] (on-hand-only mode), else null → the per-category purchase defaults.
  PURCHASE_LENGTHS_OVERRIDE = opts.purchaseLengths ?? null;
  LVL_DROP_MIN_FT  = opts.lvlDropMinFt    ?? DEFAULT_LVL_DROP_MIN_FT;
  IJOIST_LENGTHS_BY_DEPTH = opts.ijoistLengthsByDepth ?? DEFAULT_IJOIST_LENGTHS_BY_DEPTH;
  IJOIST_PRESET_NAME = opts.ijoistPresetName ?? null;
  PURCHASE_LENGTHS_BY_CAT = opts.purchaseLengthsByCat ?? null;
  PURCHASE_LENGTHS_BY_SIZE = opts.purchaseLengthsBySize ?? null;
  // `??` so an explicit 0 (seed-only, no search) is honored rather than falling
  // back to the default the way `||` would.
  LNS_MAX_ITERS = opts.lnsMaxIters ?? DEFAULT_LNS_MAX_ITERS;
  LNS_MAX_MS    = opts.lnsMaxMs    ?? DEFAULT_LNS_MAX_MS;

  // ---- Sort input into buckets
  const headers   = allItems.filter(i => i.kind === "header");
  const warnings  = allItems.filter(i => i.kind === "warning");  // from parseCSV
  const hangers   = allItems.filter(i => i.category === "Hanger");
  const cuts      = allItems.filter(i => i.source === "cuts" && i.kind === "material"
                                         && i.category !== "Hanger");
  const inventory = allItems.filter(i => i.source === "inventory");

  // ---- normalizeSize is now imported from ./normalizeSize.js (shared with
  // the inventory-impact report so both use the identical match key).

  // ---- Build inventory index: { normalizedSize: { stockLen: qtyAvailable } }
  const inventoryBySize = {};
  for (const inv of inventory) {
    const key = normalizeSize(inv.item);
    if (!inventoryBySize[key]) inventoryBySize[key] = {};
    inventoryBySize[key][inv.span] = (inventoryBySize[key][inv.span] || 0) + (inv.qty || 0);
  }

  // Build threshold index and original item names for display
  const thresholdBySize = {};
  const originalItemBySizeKey = {};
  for (const inv of inventory) {
    const key = normalizeSize(inv.item);
    const t = Number(inv.threshold);
    if (t > 0) {
      if (!thresholdBySize[key]) thresholdBySize[key] = {};
      thresholdBySize[key][inv.span] = t;
    }
    if (!originalItemBySizeKey[key]) originalItemBySizeKey[key] = inv.item;
  }
  // ---- Initial inventory snapshot (for threshold breach calculation after all jobs)
  const initialInventoryQty = {};
  for (const sizeKey in inventoryBySize) {
    initialInventoryQty[sizeKey] = { ...inventoryBySize[sizeKey] };
  }

  // ---- Group headers and cuts by jobNumber, preserving first-seen order
  const jobOrder = [];
  const headerByJob = new Map();
  const cutsByJob = new Map();
  for (const h of headers) {
    const jn = h.jobNumber || "Unknown";
    if (!headerByJob.has(jn)) { headerByJob.set(jn, h); jobOrder.push(jn); }
  }
  for (const c of cuts) {
    const jn = c.jobNumber || "Unknown";
    if (!cutsByJob.has(jn)) {
      cutsByJob.set(jn, []);
      if (!headerByJob.has(jn)) { jobOrder.push(jn); headerByJob.set(jn, {}); }
    }
    cutsByJob.get(jn).push(c);
  }

  // Measure "physically makeable" against the FULL purchase ceiling, not the mode's
  // PURCHASE_LENGTHS — so cut_exceeds_max_stock still means "can't make even by
  // buying" in on-hand-only mode (a buyable-but-not-on-hand piece is a shortfall,
  // surfaced as unfulfillable_cut, not a hard error).
  // Any length a per-category override makes buyable is, by definition, "known stock" —
  // fold it in or allowing LVL at 60' would flag a 55' cut as physically impossible.
  // The I-Joist preset path needs no such fold: it can only ever narrow the menu.
  const overrideLengths = [
    ...(PURCHASE_LENGTHS_BY_CAT ? Object.values(PURCHASE_LENGTHS_BY_CAT).flat() : []),
    ...(PURCHASE_LENGTHS_BY_SIZE ? Object.values(PURCHASE_LENGTHS_BY_SIZE).flat() : []),
  ].filter(Number.isFinite);
  const maxKnownStock = Math.max(
    ...ALL_PURCHASE_LENGTHS,
    ...overrideLengths,
    ...Object.values(inventoryBySize).flatMap(byLen => Object.keys(byLen).map(Number))
  );

  function boardSig(b) {
    const cutsSig = b.cuts.map(c => `${c.label}:${c.length.toFixed(4)}`).join("|");
    return `${b.stockLength}|${b.cutFrom}|${cutsSig}`;
  }

  const allJobItems = [];
  const allFlaggingWarnings = [];
  const allUnfulfillableWarnings = [];
  let stockPieceNumber = 0;

  for (const jn of jobOrder) {
    const headerInfo   = headerByJob.get(jn) || {};
    const jobNumber    = headerInfo.jobNumber || jn;
    const jobName      = headerInfo.jobName || "Unknown";
    const deliveryDate = headerInfo.deliveryDate || "Unknown";

    const jobCuts = cutsByJob.get(jn) || [];

    // ---- Build per-job cutGroups
    const cutGroups = {};
    for (const c of jobCuts) {
      const key = `${c.category}|${normalizeSize(c.size)}`;
      if (!cutGroups[key]) {
        cutGroups[key] = { category: c.category, size: c.size,
                           sizeKey: normalizeSize(c.size), pieces: [] };
      }
      for (let qi = 0; qi < c.qty; qi++) {
        cutGroups[key].pieces.push({ length: c.decimalFeet, label: c.label });
      }
    }

    // ---- Pre-flight flagging for this job
    const flaggingWarnings = [];
    for (const groupKey in cutGroups) {
      const g = cutGroups[groupKey];
      if (!(g.sizeKey in inventoryBySize)) {
        flaggingWarnings.push({
          kind: "warning", jobNumber, jobName, deliveryDate,
          warningType: "no_inventory_match",
          detail: `No inventory entry found for "${g.size}" (category ${g.category}). ` +
                  `Optimizer would silently treat this as buy-everything. ` +
                  `Either add an inventory row (even qty=0) or fix the size string.`,
          category: g.category, size: g.size, normalizedSize: g.sizeKey, qty: g.pieces.length
        });
      }
      if (g.category !== "Hanger") {
        const depth = extractDepth(g.size);
        if (!depth) {
          flaggingWarnings.push({
            kind: "warning", jobNumber, jobName, deliveryDate,
            warningType: "depth_extraction_failed",
            detail: `Could not extract a known depth from "${g.size}" (category ${g.category}). ` +
                    `Committed sheet would receive a blank depth column. ` +
                    `Known depths: ${KNOWN_DEPTHS.join(", ")}.`,
            category: g.category, size: g.size
          });
        }
      }
      for (const piece of g.pieces) {
        if (piece.length > maxKnownStock + 1e-6) {
          flaggingWarnings.push({
            kind: "warning", jobNumber, jobName, deliveryDate,
            warningType: "cut_exceeds_max_stock",
            detail: `Cut "${piece.label}" requires ${piece.length.toFixed(3)} ft ` +
                    `but longest known stock length is ${maxKnownStock} ft. ` +
                    `Cannot be fulfilled from any inventory or purchase length.`,
            category: g.category, size: g.size, label: piece.label, requiredLength: piece.length
          });
        }
      }
    }
    allFlaggingWarnings.push(...flaggingWarnings);

    // ---- Optimization for this job
    const cutPlan = [];
    const unfulfillable = [];

    for (const groupKey in cutGroups) {
      const group = cutGroups[groupKey];
      const onHandInit = { ...(inventoryBySize[group.sizeKey] || {}) };

      // Resolve the allowed purchase lengths ONCE per cut group (this scope has
      // group.size, hence the depth), then thread the array down through the
      // packers. purchaseLengthsFor decides precedence; everything below just
      // reads the resolved array, so a group always packs against its own depth.
      const groupDepth = extractDepth(group.size);
      const allowedPurchaseLengths = purchaseLengthsFor(group.category, groupDepth, group.size);
      const result = packGroup(group.pieces, onHandInit, group.category, allowedPurchaseLengths);

      const fulfillable   = result.boards.filter(b => b.cutFrom !== "unfulfillable");
      const unfulfilledBs = result.boards.filter(b => b.cutFrom === "unfulfillable");

      const sigFirstSeen = {};
      fulfillable.forEach((b, idx) => {
        const s = boardSig(b); if (!(s in sigFirstSeen)) sigFirstSeen[s] = idx;
      });
      fulfillable.sort((a, b) => {
        if (b.stockLength !== a.stockLength) return b.stockLength - a.stockLength;
        if (a.cutFrom !== b.cutFrom) return a.cutFrom === "on-hand" ? -1 : 1;
        return sigFirstSeen[boardSig(a)] - sigFirstSeen[boardSig(b)];
      });

      const onHandRemaining = { ...onHandInit };
      // A preset that disallows the only fitting supplier length turns a buyable
      // cut into a shortfall here (NOT a hard cut_exceeds_max_stock — that ceiling
      // is the FULL supplier set, untouched). Name the preset + depth so the
      // optimize UI shows *why* the plan can't be made.
      const presetRestricted = group.category === "I-Joist" && IJOIST_LENGTHS_BY_DEPTH &&
        groupDepth && Array.isArray(IJOIST_LENGTHS_BY_DEPTH[groupDepth]);
      for (const b of unfulfilledBs) {
        for (const c of b.cuts) {
          const reason = presetRestricted
            ? `cut needs ${c.length.toFixed(3)} ft; preset ` +
              `'${IJOIST_PRESET_NAME || "active"}' allows only ` +
              `[${allowedPurchaseLengths.join(",")}] at depth ${groupDepth}`
            : `No stock length >= ${c.length.toFixed(3)} ft available`;
          unfulfillable.push({ category: group.category, size: group.size,
                               length: c.length, label: c.label, reason });
        }
      }
      for (const b of fulfillable) {
        stockPieceNumber++;
        let depleted = false;
        if (b.cutFrom === "on-hand") {
          onHandRemaining[b.stockLength]--;
          if (onHandRemaining[b.stockLength] === 0) depleted = true;
        }
        const rawWaste = b.stockLength - b.cuts.reduce((s, c) => s + c.length, 0);
        cutPlan.push({
          kind: "cut", jobNumber, jobName, deliveryDate,
          stockPieceNumber, category: group.category, size: group.size,
          stockLength: b.stockLength, cutFrom: b.cutFrom,
          cuts: b.cuts.map(c => ({ label: c.label, length: parseFloat(c.length.toFixed(4)) })),
          waste: parseFloat(Math.max(0, rawWaste).toFixed(3)),
          inventoryDepleted: depleted
        });
      }
      // Deplete shared inventory so subsequent jobs see reduced quantities
      inventoryBySize[group.sizeKey] = { ...onHandRemaining };
    }

    // ---- Build purchase summary for this job
    const purchaseMap = {};
    for (const p of cutPlan) {
      if (p.cutFrom !== "purchase") continue;
      const key = `${p.category}|${p.size}|${p.stockLength}`;
      if (!purchaseMap[key]) purchaseMap[key] = { category: p.category, size: p.size, stockLength: p.stockLength, qty: 0 };
      purchaseMap[key].qty++;
    }

    // ---- Unfulfillable warnings for this job (deduplicated against pre-flight)
    const unfulfillableWarnings = unfulfillable.map(u => ({
      kind: "warning", jobNumber, jobName, deliveryDate,
      warningType: "unfulfillable_cut",
      detail: `Bin-packer could not place cut "${u.label}" (${u.length.toFixed(3)} ft, ${u.size}): ${u.reason}.`,
      category: u.category, size: u.size, label: u.label, requiredLength: u.length
    }));
    const preflightKeys = new Set(
      flaggingWarnings.filter(w => w.warningType === "cut_exceeds_max_stock")
                      .map(w => `${w.size}|${w.label}|${w.requiredLength}`)
    );
    allUnfulfillableWarnings.push(
      ...unfulfillableWarnings.filter(w => !preflightKeys.has(`${w.size}|${w.label}|${w.requiredLength}`))
    );

    allJobItems.push(
      headerInfo,
      ...cutPlan,
      {
        kind: "summary", jobNumber, jobName, deliveryDate,
        purchaseList: Object.values(purchaseMap),
        totalStockUsed: cutPlan.length,
        totalStockOnHand: cutPlan.filter(p => p.cutFrom === "on-hand").length,
        totalStockToPurchase: cutPlan.filter(p => p.cutFrom === "purchase").length,
        totalWaste: parseFloat(cutPlan.reduce((sum, p) => sum + p.waste, 0).toFixed(3)),
        unfulfillableCuts: unfulfillable,
        thresholdBreaches: []
      }
    );
  }

  // ---- Compute threshold breaches (post-loop; inventoryBySize now reflects all depletion)
  const thresholdBreaches = [];
  for (const sizeKey in thresholdBySize) {
    const thresholdsBySpan = thresholdBySize[sizeKey];
    const remaining    = inventoryBySize[sizeKey] || {};
    const original     = initialInventoryQty[sizeKey] || {};
    const originalItem = originalItemBySizeKey[sizeKey] || sizeKey;
    for (const span in thresholdsBySpan) {
      const threshold    = thresholdsBySpan[span];
      const startQty     = original[Number(span)] || 0;
      const remainingQty = remaining[Number(span)] !== undefined ? remaining[Number(span)] : startQty;
      if (remainingQty < threshold) {
        thresholdBreaches.push({ item: originalItem, span: Number(span),
                                 threshold, remainingQty, startQty,
                                 usedQty: startQty - remainingQty });
      }
    }
  }
  // Attach threshold breaches to the last summary item
  const lastSummary = [...allJobItems].reverse().find(i => i && i.kind === "summary");
  if (lastSummary) lastSummary.thresholdBreaches = thresholdBreaches;

  const allWarnings = [...warnings, ...allFlaggingWarnings, ...allUnfulfillableWarnings];

  const output = [...allJobItems, ...allWarnings, ...hangers];
  return output;
}

// =============================================================
// HELPERS  (kept byte-for-byte from the verified n8n node)
// =============================================================

// ---- Packing engine (large-neighborhood search) ----------------------------
//
// packGroup(pieces, onHandInit, category) -> { boards, iters, ms }
//   boards: [{ stockLength, cutFrom: "on-hand"|"purchase"|"unfulfillable",
//              cuts: [{label,length}] }]
//
// No kerf, no stock bonus: a board of length L holds cuts summing to <= L.

// Deterministic PRNG (mulberry32) so a given job always yields the same plan.
function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function boardUsed(b) {
  return b.cuts.reduce((s, c) => s + c.length, 0);
}
function boardRemainder(b) {
  return b.stockLength == null ? 0 : b.stockLength - boardUsed(b);
}

// Category-aware cost of a single board's remainder.
function remainderCost(stockLength, cuts, category) {
  if (stockLength == null) return 0;
  const r = stockLength - cuts.reduce((s, c) => s + c.length, 0);
  if (r <= 1e-9) return 0;
  if (category === "LVL" && r >= LVL_DROP_MIN_FT - 1e-9) return 0; // recoverable drop
  return r;
}

// Split a board's remainder into TRUE WASTE vs RECOVERABLE DROP — the same rule
// remainderCost applies, but reported rather than costed.
//
// This exists because the emitted cut items carry only RAW remainder
// (`waste: stockLength - sum(cuts)`), which deliberately ignores the drop rule.
// Anything downstream that wants to say "how much did we actually lose?" would
// otherwise re-implement the LVL threshold by hand — and this file already has
// three hand-copies of its logic living elsewhere (purchaseLengthsForReplica in
// dbAdapters.js, clientNormalizeSize in public/optimize-editor.js, and the
// KNOWN_DEPTHS.length coupling in server.js). One more would be a bug waiting.
//
// `lvlDropMinFt` is explicit rather than read from the module `let`, so a caller
// analyzing a finished plan gets the same answer regardless of what the last
// optimizeCuts() call happened to set. Defaults to the engine default.
function classifyRemainder(stockLength, cuts, category, lvlDropMinFt = DEFAULT_LVL_DROP_MIN_FT) {
  if (stockLength == null) return { raw: 0, waste: 0, drop: 0 };
  const raw = stockLength - cuts.reduce((s, c) => s + c.length, 0);
  if (raw <= 1e-9) return { raw: 0, waste: 0, drop: 0 };
  if (category === "LVL" && raw >= lvlDropMinFt - 1e-9) return { raw, waste: 0, drop: raw };
  return { raw, waste: raw, drop: 0 };
}

// Lexicographic objective. Lower is better.
//   I-Joist / RimBoard: (waste, purchases, boards)
//   LVL:                (boards, waste, purchases)
function objectiveOf(boards, category) {
  let w = 0, p = 0;
  for (const b of boards) {
    w += remainderCost(b.stockLength, b.cuts, category);
    if (b.cutFrom === "purchase") p++;
  }
  return { w, p, n: boards.length };
}
function objectiveBetter(a, b, category) {
  if (category === "LVL") {
    if (a.n !== b.n) return a.n < b.n;                       // fewest boards
    if (Math.abs(a.w - b.w) > 1e-9) return a.w < b.w;        // then least waste
    return a.p < b.p;                                        // then fewest purchases
  }
  if (Math.abs(a.w - b.w) > 1e-9) return a.w < b.w;
  if (a.p !== b.p) return a.p < b.p;
  return a.n < b.n;
}

// Derive remaining on-hand inventory implied by a set of boards.
function deriveOnHand(boards, onHandInit) {
  const oh = { ...onHandInit };
  for (const b of boards) {
    if (b.cutFrom === "on-hand" && b.stockLength != null) oh[b.stockLength]--;
  }
  return oh;
}

// Best-subset fill: choose the subset of `items` whose lengths sum as close to
// `len` as possible WITHOUT exceeding it (exact fill preferred). Branch-and-bound
// over items sorted descending, with suffix-sum pruning and a node cap so it stays
// bounded on large piece lists. Returns indices into `items`. This packs each
// board tighter than the old greedy-largest fill — the difference that lets the
// packer fit everything into a scarce on-hand pool instead of stranding a piece.
function bestSubsetFill(items, len) {
  const n = items.length;
  const suffix = new Array(n + 1); suffix[n] = 0;
  for (let i = n - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + items[i].length;
  let bestSum = -1, bestSet = [];
  const cur = [];
  let nodes = 0; const NODE_CAP = 60000;
  function dfs(i, sum) {
    if (sum > bestSum + 1e-9) { bestSum = sum; bestSet = cur.slice(); }
    if (bestSum >= len - 1e-9) return true;               // can't beat an exact fill
    if (i >= n || ++nodes > NODE_CAP) return false;
    if (sum + suffix[i] <= bestSum + 1e-9) return false;  // remaining can't improve
    if (sum + items[i].length <= len + 1e-9) {
      cur.push(i);
      if (dfs(i + 1, sum + items[i].length)) return true;
      cur.pop();
    }
    return dfs(i + 1, sum);
  }
  dfs(0, 0);
  return bestSet;
}

// Slot freed pieces into the gaps of EXISTING boards (best-fit: the board left
// with the smallest remainder), mutating those boards. Returns the pieces that
// found no home. Inserting into a board only shrinks its remainder, so this is
// always non-worsening — it's the move that rescues an otherwise-stranded piece
// into a board the recreate step would never have reopened.
function gapFillKept(boards, freed) {
  const leftover = [];
  for (const p of [...freed].sort((a, b) => b.length - a.length)) {
    let target = null, bestRem = Infinity;
    for (const b of boards) {
      if (b.stockLength == null) continue;
      const rem = b.stockLength - b.cuts.reduce((s, c) => s + c.length, 0);
      if (p.length <= rem + 1e-9 && rem - p.length < bestRem - 1e-9) {
        bestRem = rem - p.length; target = b;
      }
    }
    if (target) target.cuts.push(p);
    else leftover.push(p);
  }
  return leftover;
}

// Best-fill packer: repeatedly OPEN the stock length (on-hand or purchase) that,
// when filled from the remaining pieces, yields the lowest category-aware
// remainder cost. `onHand` is MUTATED as on-hand pieces are consumed. `rnd`
// (optional) enables randomized tie-breaking for the LNS recreate step. `exact`
// (optional) selects best-subset fill (tight seed) over the fast greedy fill.
function fillPack(pieces, onHand, category, rnd, exact, allowed) {
  let remaining = [...pieces].sort((a, b) => b.length - a.length);
  const boards = [];

  function fillInto(len) {
    if (exact) return bestSubsetFill(remaining, len);
    const chosen = [];
    let u = 0;
    for (let i = 0; i < remaining.length; i++) {
      if (u + remaining[i].length <= len + 1e-9) { chosen.push(i); u += remaining[i].length; }
    }
    return chosen;
  }

  while (remaining.length) {
    const largest = remaining[0].length;
    const ohLens = Object.keys(onHand).map(Number)
      .filter(l => onHand[l] > 0 && l >= largest - 1e-9);
    const pLens = allowed.filter(l => l >= largest - 1e-9);

    const cands = [];
    for (const len of ohLens) {
      const chosen = fillInto(len);
      const cuts = chosen.map(i => remaining[i]);
      cands.push({ len, cutFrom: "on-hand", cost: remainderCost(len, cuts, category),
                   chosen, n: chosen.length });
    }
    for (const len of pLens) {
      const chosen = fillInto(len);
      const cuts = chosen.map(i => remaining[i]);
      cands.push({ len, cutFrom: "purchase", cost: remainderCost(len, cuts, category),
                   chosen, n: chosen.length });
    }

    if (!cands.length) {
      // largest piece exceeds every stock length: unfulfillable
      const bad = remaining.shift();
      boards.push({ stockLength: null, cutFrom: "unfulfillable", cuts: [bad] });
      continue;
    }

    // Rank: least cost, then on-hand over purchase, then shorter, then more cuts.
    cands.sort((a, b) => {
      if (Math.abs(a.cost - b.cost) > 1e-9) return a.cost - b.cost;
      if (a.cutFrom !== b.cutFrom) return a.cutFrom === "on-hand" ? -1 : 1;
      if (a.len !== b.len) return a.len - b.len;
      return b.n - a.n;
    });

    let pick = 0;
    if (rnd) {
      // Among near-cost-ties, occasionally take a different candidate to
      // diversify the search.
      const ties = cands.filter(c => Math.abs(c.cost - cands[0].cost) <= 2);
      if (ties.length > 1 && rnd() < 0.5) pick = Math.floor(rnd() * ties.length);
    }
    const c = cands[pick];

    const set = new Set(c.chosen);
    const cuts = remaining.filter((_, i) => set.has(i));
    remaining = remaining.filter((_, i) => !set.has(i));
    if (c.cutFrom === "on-hand") onHand[c.len]--;
    boards.push({ stockLength: c.len, cutFrom: c.cutFrom, cuts });
  }
  return boards;
}

// Shrink each board to the tightest stock length that still holds its cuts and
// does not increase the board's category-aware cost. Also converts a purchase
// board to on-hand when a suitable on-hand length is free. Mutates `onHand`.
function retighten(boards, onHand, category, allowed) {
  for (const b of boards) {
    if (b.stockLength == null) continue;
    const need = boardUsed(b);

    if (b.cutFrom === "on-hand") {
      const shorter = Object.keys(onHand).map(Number)
        .filter(l => onHand[l] > 0 && l >= need - 1e-9 && l < b.stockLength)
        .sort((x, y) => x - y);
      if (shorter.length) {
        const cur = remainderCost(b.stockLength, b.cuts, category);
        const cand = remainderCost(shorter[0], b.cuts, category);
        if (cand <= cur + 1e-9) {
          onHand[b.stockLength]++; onHand[shorter[0]]--; b.stockLength = shorter[0];
        }
      }
    } else if (b.cutFrom === "purchase") {
      const cur = remainderCost(b.stockLength, b.cuts, category);
      // Convert a correctly-bought board to on-hand ONLY when some on-hand length
      // holds these cuts at no greater category-aware cost. Waste-first objective:
      // never trade a right-sized purchase (cost ~0) for a wasteful on-hand board
      // just to avoid a purchase (e.g. a lone 28' cut must not be dumped into an
      // on-hand 34'). Among eligible on-hand lengths, prefer the lowest cost, then
      // the shorter board. LVL is unaffected in spirit: an on-hand board whose
      // remainder is a recoverable drop is cost-0, so it still gets used.
      const ohBest = Object.keys(onHand).map(Number)
        .filter(l => onHand[l] > 0 && l >= need - 1e-9)
        .sort((x, y) => {
          const cx = remainderCost(x, b.cuts, category);
          const cy = remainderCost(y, b.cuts, category);
          if (Math.abs(cx - cy) > 1e-9) return cx - cy;
          return x - y;
        });
      if (ohBest.length && remainderCost(ohBest[0], b.cuts, category) <= cur + 1e-9) {
        onHand[ohBest[0]]--; b.stockLength = ohBest[0]; b.cutFrom = "on-hand";
      } else {
        const pc = allowed
          .filter(l => l >= need - 1e-9 && l < b.stockLength)
          .sort((x, y) => x - y);
        if (pc.length) {
          const cand = remainderCost(pc[0], b.cuts, category);
          if (cand <= cur + 1e-9) b.stockLength = pc[0];
        }
      }
    }
  }
}

// Heuristic packer (best-fill seed + large-neighborhood search). Fast, always
// returns a complete plan. Used both as the answer for instances the exact solver
// can't close in budget, and as the exact solver's warm-start upper bound.
function heuristicPack(pieces, onHandInit, category, exactSeed, allowed) {
  const t0 = Date.now();
  const rnd = makeRng(LNS_SEED);

  // Seed plan (deterministic best-fill). `exactSeed` chooses tight best-subset
  // fill (wins on scarce pools) vs fast greedy fill (wins on others) — packGroup
  // runs both and keeps the better.
  let best = fillPack(pieces, { ...onHandInit }, category, null, !!exactSeed, allowed);
  retighten(best, deriveOnHand(best, onHandInit), category, allowed);
  let bestObj = objectiveOf(best, category);

  let iters = 0;
  // Early-exit when the objective's PRIMARY key is already provably optimal:
  //   I-Joist / RimBoard — primary is waste; zero waste can't be beaten.
  //   LVL — primary is board count; zero waste does NOT imply fewest boards
  //         (two zero-cost drops vs one consolidated board), so don't bail on
  //         waste. Run the bounded budget; it's cheap at this scale.
  const seedOptimal = () => (category === "LVL" ? false : bestObj.w <= 1e-9);
  while (iters < LNS_MAX_ITERS && (Date.now() - t0) < LNS_MAX_MS && !seedOptimal()) {
    iters++;

    // RUIN: dissolve a random 1..k subset of boards, freeing their pieces. Bias
    // toward boards that carry waste, and ALWAYS seed an unfulfillable (stranded)
    // board when one exists — rescuing a stranded piece needs the search to free
    // a board it can actually fit on, which only happens if it's in the ruin set.
    const k = 1 + Math.floor(rnd() * Math.min(6, best.length));
    const idxs = new Set();
    const unfilledIdxs = [], dropIdxs = [];
    best.forEach((b, i) => {
      if (b.stockLength == null) unfilledIdxs.push(i);
      else if (remainderCost(b.stockLength, b.cuts, category) > 1e-9) dropIdxs.push(i);
    });
    if (unfilledIdxs.length) idxs.add(unfilledIdxs[Math.floor(rnd() * unfilledIdxs.length)]);
    else if (dropIdxs.length && rnd() < 0.8) idxs.add(dropIdxs[Math.floor(rnd() * dropIdxs.length)]);
    while (idxs.size < k) idxs.add(Math.floor(rnd() * best.length));

    const kept = [];
    const freed = [];
    best.forEach((b, i) => {
      if (idxs.has(i)) { for (const c of b.cuts) freed.push(c); }
      else kept.push({ stockLength: b.stockLength, cutFrom: b.cutFrom,
                       cuts: b.cuts.map(c => ({ ...c })) });
    });
    if (!freed.length) continue;

    // RECREATE: first slot freed pieces into existing board gaps (rescues pieces a
    // fresh repack would strand), then open new boards for the rest (randomized).
    const leftover = gapFillKept(kept, freed);
    const ohNow = deriveOnHand(kept, onHandInit);
    const recreated = fillPack(leftover, ohNow, category, rnd, false, allowed);
    const trial = kept.concat(recreated);
    retighten(trial, deriveOnHand(trial, onHandInit), category, allowed);

    const o = objectiveOf(trial, category);
    if (objectiveBetter(o, bestObj, category)) { best = trial; bestObj = o; }
  }

  return best;
}

// packGroup: run two heuristic seeds and keep the better plan. The greedy and
// tight (best-subset) seeds win on different pool shapes — scarce on-hand pools
// favor the tight seed, others the greedy — so trying both and keeping the
// lower-objective result strictly dominates either alone.
function packGroup(pieces, onHandInit, category, allowed) {
  const t0 = Date.now();
  let best = heuristicPack(pieces, onHandInit, category, false, allowed);
  let bestObj = objectiveOf(best, category);
  const tight = heuristicPack(pieces, onHandInit, category, true, allowed);
  const tightObj = objectiveOf(tight, category);
  if (objectiveBetter(tightObj, bestObj, category)) { best = tight; bestObj = tightObj; }

  return { boards: best, ms: Date.now() - t0 };
}

// DEFAULT_PURCHASE_LENGTHS_BY_CAT is the single source of truth for the supplier
// length menu — server.js + the Board-sizes UI read I-Joist's list from here
// rather than re-typing it. KNOWN_DEPTHS re-exported for the same reason.
// classifyRemainder is exported so nothing downstream has to re-implement the LVL
// drop rule to tell true waste from a recoverable drop (see its own comment).
module.exports = {
  optimizeCuts, DEFAULT_PURCHASE_LENGTHS_BY_CAT, KNOWN_DEPTHS, IJOIST_LENGTH_MENU,
  classifyRemainder, DEFAULT_LVL_DROP_MIN_FT,
};
