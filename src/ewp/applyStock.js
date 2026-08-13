// =============================================================
// applyStock.js — net the greenfield plan against what's on the yard
// =============================================================
// The search in selectStockLengths.js is GREENFIELD on purpose: every piece is
// priced as a purchase, so the recommended lengths and the waste they're ranked
// on mean the same thing this week as last week. Feeding stock into the search
// would make both stock-dependent — see the ranking note at the top of
// selectStockLengths.js.
//
// So stock is applied AFTER: take the lengths the search already chose, re-pack
// the batch with the real yard merged in, and report the difference. Nothing in
// selectStockLengths.js or optimizeCuts.js changes.
//
// Feed stock into the search instead and three things break: waste stops being
// comparable between runs, reported waste and feet-purchased stop being
// equivalent orderings, and every existing ranking test starts asserting
// against a moving target.
// =============================================================
// WHY A SECOND ENGINE PASS, not arithmetic on the buy list.
//
// fillPack builds its on-hand candidates from the inventory itself, INDEPENDENT
// of the allowed purchase lengths (optimizeCuts.js, `ohLens` vs `pLens`). A yard
// holding 99 boards at 28' can therefore cover a 27' cut even though 28' is not
// a length the supplier sells and the search could never have picked it.
// Subtracting stock from the buy list length-by-length would never see those 99
// boards. The engine already knows how to: on-hand before purchase, shortest
// sufficient board first, depleting across jobs as the batch runs.
// =============================================================
// PASSES ARE INDEPENDENT, and that is load-bearing.
//
// Each pass is its own optimizeCuts call with its own inventoryBySize, so stock
// consumed in one is invisible to the others. That is safe ONLY because the
// passes cover disjoint keys: inventory is keyed normalizeSize(item)+span, one
// pass per I-Joist product plus one for the LVL/Rim half, and no two of those
// share a key. Merge two products into one pass and this reasoning stops
// holding.
//
// The flip side is stockPieceNumber, which restarts at 0 in EVERY optimizeCuts
// call. inventoryImpact de-dupes boards by that number (one board can carry
// several cuts but removes only one piece from stock), so concatenating items
// from several passes and calling it once would collapse distinct boards and
// UNDER-report depletion. Call it per pass and concat the results instead —
// disjoint keys mean the rows never need merging.
// =============================================================

const { optimizeCuts, KNOWN_DEPTHS, DEFAULT_LVL_DROP_MIN_FT } = require('./optimizeCuts.js');
const { specialOrderInventoryStubs } = require('./dbAdapters.js');
const { productsOf, splitBatch, scoreOutput, buildCutPlan } = require('./selectStockLengths.js');
const { inventoryImpact } = require('./inventoryImpact.js');
const { normalizeSize } = require('./normalizeSize.js');

const round3 = (n) => parseFloat(n.toFixed(3));

// ---- job order -------------------------------------------------------------
// optimizeCuts derives its job order from the order headers arrive, and that
// order is the order stock gets claimed. Left alone it would be drag-and-drop
// order: re-dropping the same four files differently could change the buy list.
// Soonest delivery first instead — the job that ships first gets the boards,
// which is both how a yard actually allocates and how the web app orders a batch
// (dbAdapters.orderJobsByShip). Unparseable dates sort last; ties keep file
// order, so the result is deterministic either way.
function deliveryTime(h) {
  const t = Date.parse(h && h.deliveryDate);
  return Number.isFinite(t) ? t : Infinity;
}

function byDelivery(headers) {
  return headers
    .map((h, i) => ({ h, i }))
    .sort((a, b) => deliveryTime(a.h) - deliveryTime(b.h) || a.i - b.i)
    .map((x) => x.h);
}

// ---- inventory for one pass ------------------------------------------------
// THE LANDMINE: merge real stock WITH the zero-qty stubs, never
// substitute. A size with no stock row at all trips optimizeCuts'
// no_inventory_match pre-flight — a warning here, but a batch-blocker for any
// caller that runs the output through detectWarnings. A stub is span 0 / qty 0
// and is never drawable (fillPack needs qty > 0 AND span >= length), so adding
// one to a size that DOES have stock costs nothing.
function inventoryFor(items, stockItems) {
  const sizes = items.filter((i) => i.size).map((i) => i.size);
  return [...stockItems, ...specialOrderInventoryStubs(sizes)];
}

const cutsOnly = (items) => items.filter((i) => i && i.kind === 'cut');

/**
 * Re-plan a batch at its already-chosen lengths, with real stock available.
 *
 * @param {Array}  cutItems  parseJobCsv-shaped items for the whole batch
 * @param {Object} plan      analyzeBatch()'s result (for the chosen lengths and
 *                           the greenfield buy list to net against)
 * @param {Array}  stock     parseStockCsv()'s items
 * @param {Object} opts      purchaseLengthsByCat, lvlDropMinFt, lnsMaxMs,
 *                           lnsMaxIters — as passed to analyzeBatch
 * @returns {Object|null}    null when there is no stock to apply
 */
function applyStock(cutItems, plan, stock, opts = {}) {
  if (!stock || !stock.length || !plan || !plan.products) return null;

  const lvlDropMinFt = opts.lvlDropMinFt ?? DEFAULT_LVL_DROP_MIN_FT;
  const purchaseLengthsByCat = opts.purchaseLengthsByCat ?? null;
  const budget = {};
  if (opts.lnsMaxMs !== undefined) budget.lnsMaxMs = opts.lnsMaxMs;
  if (opts.lnsMaxIters !== undefined) budget.lnsMaxIters = opts.lnsMaxIters;

  const { headers, ijoistItems, constantItems } = splitBatch(cutItems);
  const ordered = byDelivery(headers);

  const lengthsByKey = new Map();
  for (const p of plan.products) {
    if (p.best && p.best.lengths) lengthsByKey.set(p.key, p.best.lengths);
  }

  let allItems = [];
  const depletion = [];
  const purchases = [];
  const skipped = [];

  const runPass = (items, engineOpts) => {
    const out = optimizeCuts(
      [...ordered, ...items, ...inventoryFor(items, stock)],
      { purchaseLengthsByCat, lvlDropMinFt, ...budget, ...engineOpts }
    );
    const boards = cutsOnly(out);
    const impact = inventoryImpact(stock, boards);
    allItems = allItems.concat(boards);
    depletion.push(...impact.depletion);
    purchases.push(...impact.purchases);
  };

  // ---- one pass per I-Joist product, pinned to the lengths the search chose
  for (const p of productsOf(ijoistItems)) {
    const lengths = lengthsByKey.get(p.key);
    if (!lengths) { skipped.push(p.size); continue; }   // search found nothing feasible
    const byDepth = {};
    for (const d of KNOWN_DEPTHS) byDepth[d] = lengths;
    runPass(p.items, {
      ijoistLengthsByDepth: byDepth,
      ijoistPresetName: `stock:[${lengths.join(',')}]`,
    });
  }

  // ---- and one for the constant half. The yard holds LVL and rim board too,
  // and they're a large part of a real order.
  if (constantItems.length) runPass(constantItems, {});

  const totals = scoreOutput(allItems, lvlDropMinFt);

  depletion.sort((a, b) =>
    String(a.depth).localeCompare(String(b.depth)) ||
    String(a.item).localeCompare(String(b.item)) ||
    a.stockLength - b.stockLength);

  return {
    // What still has to be bought, next to what the greenfield plan would have
    // bought — the buyer's actual answer.
    buyList: netBuyList(plan.purchaseList || [], totals.purchaseList),
    // What shipping this batch does to the yard, including threshold breaches
    // measured on the REMAINING stock, not on today's.
    depletion,
    // Both waste figures. Greenfield is the number the search ranked on and the
    // one that stays comparable between runs; as-planned is what this batch
    // really costs, given that drawing an odd on-hand length often trades a
    // little waste for a lot less spend.
    totals: {
      greenfield: summarize(plan.totals),
      asPlanned: summarize(totals),
      boardsFromStock: allItems.filter((b) => b.cutFrom === 'on-hand').length,
      feetFromStock: round3(allItems
        .filter((b) => b.cutFrom === 'on-hand')
        .reduce((s, b) => s + b.stockLength, 0)),
    },
    // The plan the shop will actually cut. cutList.js already badges each board
    // on-hand vs purchase, so this renders stock-aware with no UI work.
    cutPlan: buildCutPlan(allItems, lvlDropMinFt),
    coverage: coverageOf(cutItems, stock),
    skipped,
  };
}

function summarize(t) {
  if (!t) return null;
  return {
    trueWaste: t.trueWaste,
    ijoistWaste: t.ijoistWaste,
    recoverableDrops: t.recoverableDrops,
    feetPurchased: t.feetPurchased,
    boardsPurchased: t.boardsPurchased,
  };
}

// ---- netting ---------------------------------------------------------------
// One row per (category, size, length) either plan buys.
//
//   need    what the greenfield plan would have bought
//   buy     what still has to be bought with the yard available
//   covered need - buy
//
// `covered` can go NEGATIVE at a given length, and that is not a bug: on-hand
// boards absorb cuts, and the leftover pieces can repack onto a different
// allowed length than the greenfield plan opened. The totals still fall, which
// is why the summary reports totals separately rather than summing this column.
function netBuyList(greenfield, withStock) {
  const key = (p) => `${p.category}|${p.size}|${p.stockLength}`;
  const rows = new Map();

  for (const p of greenfield) {
    rows.set(key(p), {
      category: p.category, size: p.size, stockLength: p.stockLength,
      need: p.qty, buy: 0,
    });
  }
  for (const p of withStock) {
    const k = key(p);
    if (!rows.has(k)) {
      rows.set(k, {
        category: p.category, size: p.size, stockLength: p.stockLength,
        need: 0, buy: p.qty,
      });
    } else {
      rows.get(k).buy = p.qty;
    }
  }

  return [...rows.values()]
    .map((r) => ({ ...r, covered: r.need - r.buy }))
    .sort((a, b) =>
      a.category.localeCompare(b.category) ||
      a.size.localeCompare(b.size) ||
      b.stockLength - a.stockLength);
}

// ---- coverage --------------------------------------------------------------
// Which materials in the batch the stock file says anything about. A product
// with no rows at all is the case worth naming BEFORE a long plan run: it is
// not "nothing on hand", it is "this file doesn't mention it", and those are
// different conversations with the yard.
function coverageOf(cutItems, stock) {
  const stocked = new Map();
  for (const s of stock) {
    const k = normalizeSize(s.item);
    stocked.set(k, (stocked.get(k) || 0) + (Number(s.qty) || 0));
  }

  const seen = new Map();
  for (const i of cutItems) {
    if (i.kind !== 'material' || i.category === 'Hanger' || !i.size) continue;
    const k = normalizeSize(i.size);
    if (!seen.has(k)) {
      seen.set(k, {
        size: i.size,
        category: i.category,
        inStockFile: stocked.has(k),
        available: stocked.get(k) || 0,
      });
    }
  }
  return [...seen.values()].sort((a, b) =>
    a.category.localeCompare(b.category) || a.size.localeCompare(b.size));
}

module.exports = { applyStock, netBuyList, byDelivery, coverageOf };
