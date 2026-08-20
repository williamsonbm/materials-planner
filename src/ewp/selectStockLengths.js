// =============================================================
// selectStockLengths — the OUTER search over stock-length sets
// =============================================================
// optimizeCuts answers "given these allowed lengths, how do I cut them?".
// This answers the inverse purchasing question:
//
//   "I'm willing to order at most N distinct stock lengths for these jobs —
//    which N minimize what I have to buy?"
//
// The engine is NOT modified to support this. Everything runs through options
// optimizeCuts already accepts, so the existing golden suite remains the
// regression net for the packing itself:
//
//   * opts.ijoistLengthsByDepth — purchaseLengthsFor() is the single precedence
//     point for the allowed set; we hand it one candidate set per iteration.
//   * opts.purchaseLengthsByCat — what the supplier will sell for LVL/RimBoard.
//     SET, not searched: the engine already picks the cheapest allowed length
//     per board, so widening the list is enough to capture the benefit.
//   * specialOrderInventoryStubs() — zero-qty inventory rows. This is the
//     GREENFIELD trick: a stub makes `g.sizeKey in inventoryBySize` true, so
//     the no_inventory_match warning (which would otherwise block every job in
//     a stock-free batch) never fires, while fillPack's `onHand[l] > 0` filter
//     means the stub contributes no actual stock. Every piece becomes a
//     purchase, which is exactly the question being asked.
//
// SCOPE — the SEARCH covers I-Joist only, matching the existing "Board sizes"
// preset mechanism. LVL and RimBoard are planned and counted, and their buyable
// lengths are settable, but they don't vary between candidates.
//
// ONE SET PER PRODUCT — see productsOf() and analyzeBatch(). An earlier version
// of this comment claimed per-depth choice would be C(19,3)^8 candidates; that
// was wrong. The problem SEPARATES (boards are never shared between cut groups),
// so the cost is additive, and lengths differ by product anyway.
// =============================================================
// RANKING — I-Joist TRUE WASTE.
//
// Three deliberate choices, all learned from a real bug report (job 33844J
// reported "144 ft of waste" at 5 allowed lengths, which looked broken):
//
//   1. TRUE waste, not raw remainder. The cut items carry raw
//      `stockLength - sum(cuts)`, which ignores the design rule that an LVL
//      remainder at/above the drop threshold returns to stock. All 144 ft of
//      33844J was recoverable LVL drops; its true waste was ZERO. We classify
//      via the engine's own exported classifyRemainder so there is one rule.
//
//   2. I-JOIST only. LVL and RimBoard sourcing does not vary with the I-Joist
//      length count, so including them adds the same constant to every
//      candidate — it cannot change the ranking, but it does hide the point at
//      which extra lengths stop helping.
//
//   3. Waste, not feet purchased. Under greenfield they're equivalent orderings
//      (waste = bought - fixed demand), but waste is the number the office
//      actually judges a job by, so it's the one that gets ranked and reported.
// =============================================================
// COST — C(19,3) = 969 candidates, C(19,4) = 3876. packGroup runs heuristicPack
// TWICE per cut group, each bounded by the LNS budget, so brute force at the
// default budget is hours. Two stages instead:
//
//   Stage 1 (sweep)     — every candidate at lnsMaxIters:0, i.e. the
//                         deterministic best-fill seed + retighten, no search.
//                         Milliseconds each, and machine-independent (no wall
//                         clock is consulted when the loop never runs).
//   Stage 2 (finalists) — the top `topN` re-run at the full default budget.
//
// Both stages rank by the same scalar, so stage 2 only ever reorders finalists;
// it cannot promote a candidate the sweep discarded. That is the accuracy
// trade-off being made, and it is why topN defaults to 10 rather than 1.
// =============================================================

const {
  optimizeCuts, IJOIST_LENGTH_MENU, KNOWN_DEPTHS,
  classifyRemainder, DEFAULT_LVL_DROP_MIN_FT,
} = require('./optimizeCuts.js');
const { specialOrderInventoryStubs } = require('./dbAdapters.js');
const { normalizeSize } = require('./normalizeSize.js');
const { extractDepth } = require('./extractDepth.js');

const DEFAULT_MAX_LENGTHS = 3;
const DEFAULT_TOP_N = 10;
// A length count counts as "no better" than a bigger one when it's within this
// many feet of the best achievable waste. One foot: below the resolution anyone
// makes a purchasing decision at.
const DEFAULT_KNEE_TOLERANCE_FT = 1;
// Above this many candidate sets, `auto` switches from the exhaustive sweep to
// greedy forward-selection. The supplier set at cap 5 is 218 sets (~50s on four
// jobs) and stays exact; the full 19-length menu at cap 5 is 16,663 (~299s) and
// goes greedy. Tuned so the everyday case is never approximated.
const GREEDY_ABOVE_SETS = 400;

const round3 = (n) => parseFloat(n.toFixed(3));

// ---- combinations ----------------------------------------------------------
// Every k-subset of `pool`, each emitted in descending order. Deterministic:
// pool order in, lexicographic-by-index out.
function combinations(pool, k) {
  const out = [];
  const cur = [];
  (function rec(start) {
    if (cur.length === k) { out.push(cur.slice()); return; }
    // Prune branches that can't reach length k.
    for (let i = start; i <= pool.length - (k - cur.length); i++) {
      cur.push(pool[i]);
      rec(i + 1);
      cur.pop();
    }
  })(0);
  return out;
}

// ---- scoring ---------------------------------------------------------------
// Fold the emitted cut items into one score for the batch. We read the BOARDS
// (kind:"cut"), not the summaries: a board is the thing that gets bought, and
// its cuts[] is the thing that gets cut. Committed rows would be one row per cut
// piece and would multiply-count a board carrying several cuts.
function scoreOutput(items, lvlDropMinFt = DEFAULT_LVL_DROP_MIN_FT) {
  const byCategory = {};
  const purchases = new Map();
  let feetPurchased = 0, boardsPurchased = 0, boards = 0;

  for (const it of items) {
    if (!it || it.kind !== 'cut') continue;
    const cat = it.category;
    const c = byCategory[cat] ||
      (byCategory[cat] = { boards: 0, feet: 0, waste: 0, drops: 0, rawRemainder: 0 });

    const { raw, waste, drop } = classifyRemainder(it.stockLength, it.cuts, cat, lvlDropMinFt);
    c.boards++;
    c.feet += it.stockLength;
    c.waste += waste;
    c.drops += drop;
    c.rawRemainder += raw;
    boards++;

    if (it.cutFrom === 'purchase') {
      feetPurchased += it.stockLength;
      boardsPurchased++;
      const key = `${cat}|${it.size}|${it.stockLength}`;
      if (!purchases.has(key)) {
        purchases.set(key, { category: cat, size: it.size, stockLength: it.stockLength, qty: 0 });
      }
      purchases.get(key).qty++;
    }
  }

  for (const c of Object.values(byCategory)) {
    c.feet = round3(c.feet);
    c.waste = round3(c.waste);
    c.drops = round3(c.drops);
    c.rawRemainder = round3(c.rawRemainder);
  }

  // One buy list for the batch — a buyer orders once, not once per job.
  const purchaseList = [...purchases.values()].sort(
    (a, b) =>
      a.category.localeCompare(b.category) ||
      a.size.localeCompare(b.size) ||
      b.stockLength - a.stockLength
  );

  // Which I-Joist lengths the plan ACTUALLY bought. A candidate set is an
  // allow-list, not an order: asking for 5 lengths and being told the best plan
  // only opens 2 is a real answer, not a rounding artifact.
  const lengthsUsed = [
    ...new Set(purchaseList.filter((p) => p.category === 'I-Joist').map((p) => p.stockLength)),
  ].sort((a, b) => b - a);

  const sum = (k) => round3(Object.values(byCategory).reduce((s, c) => s + c[k], 0));

  return {
    ijoistWaste: byCategory['I-Joist'] ? byCategory['I-Joist'].waste : 0,
    trueWaste: sum('waste'),
    recoverableDrops: sum('drops'),
    rawRemainder: sum('rawRemainder'),
    feetPurchased: round3(feetPurchased),
    ijoistFeetPurchased: byCategory['I-Joist'] ? byCategory['I-Joist'].feet : 0,
    boardsPurchased,
    boards,
    byCategory,
    lengthsUsed,
    purchaseList,
  };
}

function isInfeasible(items) {
  return items.some((i) => i && i.kind === 'warning' && i.warningType === 'unfulfillable_cut');
}

// Add a constant (LVL + RimBoard) score onto a searched (I-Joist) score.
// `ijoistWaste` deliberately comes from the searched side alone — see the
// ranking note in the header.
function mergeScores(searched, constant) {
  if (!constant) return searched;
  const byCategory = { ...searched.byCategory };
  for (const [cat, c] of Object.entries(constant.byCategory)) {
    byCategory[cat] = byCategory[cat]
      ? {
          boards: byCategory[cat].boards + c.boards,
          feet: round3(byCategory[cat].feet + c.feet),
          waste: round3(byCategory[cat].waste + c.waste),
          drops: round3(byCategory[cat].drops + c.drops),
          rawRemainder: round3(byCategory[cat].rawRemainder + c.rawRemainder),
        }
      : { ...c };
  }
  return {
    ...searched,
    byCategory,
    trueWaste: round3(searched.trueWaste + constant.trueWaste),
    recoverableDrops: round3(searched.recoverableDrops + constant.recoverableDrops),
    rawRemainder: round3(searched.rawRemainder + constant.rawRemainder),
    feetPurchased: round3(searched.feetPurchased + constant.feetPurchased),
    boardsPurchased: searched.boardsPurchased + constant.boardsPurchased,
    boards: searched.boards + constant.boards,
    purchaseList: [...searched.purchaseList, ...constant.purchaseList].sort(
      (a, b) =>
        a.category.localeCompare(b.category) ||
        a.size.localeCompare(b.size) ||
        b.stockLength - a.stockLength
    ),
  };
}

// Total ordering over candidates. I-Joist true waste first (the stated
// objective), then total feet bought, then fewest boards to handle, then the
// length list itself so the result is stable across runs and machines rather
// than depending on the order the sweep happened to visit ties.
function compareCandidates(a, b) {
  if (Math.abs(a.ijoistWaste - b.ijoistWaste) > 1e-9) return a.ijoistWaste - b.ijoistWaste;
  if (Math.abs(a.feetPurchased - b.feetPurchased) > 1e-9) return a.feetPurchased - b.feetPurchased;
  if (a.boardsPurchased !== b.boardsPurchased) return a.boardsPurchased - b.boardsPurchased;
  return a.lengths.join(',').localeCompare(b.lengths.join(','));
}

// ---- input shaping ---------------------------------------------------------
// Greenfield stubs for EVERY distinct size in the batch — all categories, not
// just I-Joist. LVL and RimBoard sizes need stubs too or their cut groups trip
// no_inventory_match and (via detectWarnings) would block the batch for a
// caller running this through the pipeline.
function greenfieldStubs(cutItems) {
  const sizes = cutItems
    .filter((i) => i.kind === 'material' && i.category !== 'Hanger' && i.size)
    .map((i) => i.size);
  return specialOrderInventoryStubs(sizes);
}

// The longest I-Joist piece in the batch. A candidate set with no length >= this
// can never be feasible, so it's pruned before paying for an engine run.
function longestIjoistCut(cutItems) {
  let max = 0;
  for (const i of cutItems) {
    if (i.kind !== 'material' || i.category !== 'I-Joist') continue;
    if (Number.isFinite(i.decimalFeet) && i.decimalFeet > max) max = i.decimalFeet;
  }
  return max;
}

// Sentinel: the constant (LVL/Rim) half of the batch cannot be built at all.
const INFEASIBLE = Symbol('infeasible-constant');

// Pack the non-I-Joist part of a batch once. Returns null when there is nothing
// to pack, INFEASIBLE when it cannot be built, else { score, items }.
function packConstant(constantItems, headers, engineOpts = {}) {
  if (!constantItems.length) return null;
  const { lvlDropMinFt } = engineOpts;
  const items = optimizeCuts(
    [...headers, ...constantItems, ...greenfieldStubs(constantItems)],
    engineOpts
  );
  if (isInfeasible(items)) return INFEASIBLE;
  return { score: scoreOutput(items, lvlDropMinFt), items };
}

// Split a batch into the part the search varies and the part it doesn't.
function splitBatch(cutItems) {
  return {
    headers: cutItems.filter((i) => i.kind === 'header'),
    ijoistItems: cutItems.filter((i) => i.kind === 'material' && i.category === 'I-Joist'),
    constantItems: cutItems.filter(
      (i) => i.kind === 'material' && i.category !== 'I-Joist' && i.category !== 'Hanger'),
  };
}

// The I-Joist half, split into independent SOURCING UNITS — one per product, keyed
// the way the engine keys its cut groups (normalizeSize).
//
// Product, not depth: 11 7/8" PJI-40 and 11 7/8" TJI 560 share a depth but are
// different SKUs and can be stocked in different lengths (Blake 2026-08-02).
//
// These really are independent problems. optimizeCuts builds one cut group per
// category|normalizeSize(size) and never shares a board between groups — a 16"
// board cannot hold an 11 7/8" cut — so total waste is the SUM of each product's
// waste and one product's plan is unaffected by another's allowed lengths.
// Verified: two depths optimized together produce 26+8=34 ft, exactly their
// separate totals, with byte-identical boards.
//
// The practical consequence is that searching per product costs
// `sum over products of C(pool, N)` — additive, not multiplied.
function productsOf(ijoistItems) {
  const byKey = new Map();
  for (const it of ijoistItems) {
    const key = normalizeSize(it.size);
    if (!byKey.has(key)) {
      byKey.set(key, { key, size: it.size, depth: extractDepth(it.size), items: [] });
    }
    byKey.get(key).items.push(it);
  }
  for (const p of byKey.values()) {
    p.pieces = p.items.reduce((s, i) => s + (i.qty || 0), 0);
    p.feet = round3(p.items.reduce((s, i) => s + (i.qty || 0) * (i.decimalFeet || 0), 0));
  }
  return [...byKey.values()];
}

// ---- main ------------------------------------------------------------------
/**
 * @param {Array}  cutItems   parseJobCsv-shaped items (headers + materials).
 * @param {Object} opts
 *   maxLengths           {number}   max DISTINCT I-Joist stock lengths (default 3)
 *   menu                 {number[]} I-Joist candidate pool (default IJOIST_LENGTH_MENU)
 *   require              {number[]} lengths that must appear in every candidate
 *   topN                 {number}   finalists re-run at full budget (default 10)
 *   purchaseLengthsByCat {Object}   e.g. { LVL:[48,44,40] } — set, not searched
 *   lvlDropMinFt         {number}   drop threshold (default 8, the engine default)
 * @returns {{best, ranked, cutPlan, evaluated, skipped, maxLengths, menu}}
 */
function selectStockLengths(cutItems, opts = {}) {
  const maxLengths = opts.maxLengths ?? DEFAULT_MAX_LENGTHS;
  const menu = (opts.menu ?? IJOIST_LENGTH_MENU).slice().sort((a, b) => b - a);
  const required = (opts.require ?? []).slice();
  const topN = opts.topN ?? DEFAULT_TOP_N;
  const purchaseLengthsByCat = opts.purchaseLengthsByCat ?? null;
  const lvlDropMinFt = opts.lvlDropMinFt ?? DEFAULT_LVL_DROP_MIN_FT;

  for (const r of required) {
    if (!menu.includes(r)) {
      throw new Error(`required length ${r} is not in the candidate menu (${menu.join(', ')})`);
    }
  }
  if (required.length > maxLengths) {
    throw new Error(`require lists ${required.length} lengths but maxLengths is ${maxLengths}`);
  }

  // ---- split the batch: SEARCHED (I-Joist) vs CONSTANT (LVL, RimBoard)
  //
  // LVL and RimBoard sourcing does not depend on the I-Joist candidate set, so
  // re-packing them for every candidate recomputes an identical answer. That is
  // not a small waste: measured on job 33844J, one optimizeCuts call costs
  // ~606 ms, of which LVL is ~493 ms and I-Joist is ~1 ms. LVL is expensive
  // because heuristicPack's seedOptimal() returns false for LVL unconditionally
  // (zero waste does not imply fewest boards, its primary key), so LVL always
  // burns the full LNS budget while I-Joist early-exits on an exact fit.
  //
  // So: pack the constant part ONCE, search the I-Joist part, add the two.
  // Boards are per-job in the engine, so splitting by category cannot merge
  // material across jobs that would not otherwise have been merged.
  const { headers, ijoistItems, constantItems } = splitBatch(cutItems);

  // How long the engine may spend IMPROVING a plan after its first pass (the
  // large-neighborhood search: tear a few boards apart, repack, keep if better).
  // Undefined values are dropped so the engine's own defaults apply — passing
  // `{ lnsMaxMs: undefined }` would still be `??`-safe, but building the object
  // cleanly keeps the "unset means default" contract obvious at the call sites.
  const budget = {};
  if (opts.lnsMaxMs !== undefined) budget.lnsMaxMs = opts.lnsMaxMs;
  if (opts.lnsMaxIters !== undefined) budget.lnsMaxIters = opts.lnsMaxIters;

  // opts.constantPlan lets a caller that runs MANY searches over the same batch
  // (analyzeLengthCount sweeps N=1..max) pay for the LVL/Rim pack once overall
  // instead of once per search. Same insight, one level up.
  const constant = opts.constantPlan !== undefined
    ? opts.constantPlan
    : packConstant(constantItems, headers, { purchaseLengthsByCat, lvlDropMinFt, ...budget });
  if (constant === INFEASIBLE) {
    // No I-Joist choice can rescue an unbuildable LVL/Rim piece.
    return { best: null, ranked: [], cutPlan: [], evaluated: 0, skipped: 0, maxLengths, menu };
  }
  const constantScore = constant ? constant.score : null;
  const constantCutItems = constant ? constant.items : [];

  const input = [...headers, ...ijoistItems, ...greenfieldStubs(ijoistItems)];
  const minLength = longestIjoistCut(cutItems);

  // Candidates = required lengths + every (maxLengths - required.length) subset
  // of the rest. maxLengths is an "at most", but only EXACTLY k is enumerated.
  //
  // KNOWN BUG — this comment used to claim that was harmless, on the grounds
  // that a k-set containing a k-1 optimum "scores identically, because the
  // packer simply never opens the unused length." It does open them. On 33844J
  // the k=2 winner [36,32] buys 69 boards; no 5-subset can reproduce it, because
  // every 5-set holding 36 and 32 also holds three shorter lengths the packer
  // takes up — so k=5 returns 77 boards for the same footage and the same zero
  // waste. compareCandidates would break that tie on board count, but the better
  // plan is never in the candidate list to be compared.
  // Covered by the skipped test at the end of test/ewp-select-lengths.test.js.
  // The fix is to enumerate subsets of size <= k, or to consolidate onto fewer
  // long boards once waste hits zero — deliberately not attempted here, since
  // this ranking is regression-locked against the inventory app.
  //
  // `lengthsUsed` on the result reports which lengths actually got bought, so a
  // 5-length answer that only needs 2 does say so.
  // opts.candidateSets short-circuits enumeration with an explicit list. Used by
  // the "would an unstocked length help?" check, which needs to try a handful of
  // targeted sets rather than every combination of a 19-length menu.
  const rest = menu.filter((l) => !required.includes(l));
  const k = maxLengths - required.length;
  const sets = opts.candidateSets
    ? opts.candidateSets.map((s) => [...s].sort((a, b) => b - a))
    : combinations(rest, k).map((c) => [...required, ...c].sort((a, b) => b - a));

  const evaluate = (lengths, engineOpts) => {
    const byDepth = {};
    for (const d of KNOWN_DEPTHS) byDepth[d] = lengths;
    const items = optimizeCuts(input, {
      // Caller-supplied improvement budget FIRST, so the per-stage override
      // below (lnsMaxIters:0 for the sweep) still wins where it must.
      ...budget,
      ...engineOpts,
      ijoistLengthsByDepth: byDepth,
      ijoistPresetName: `search:[${lengths.join(',')}]`,
      purchaseLengthsByCat,
      lvlDropMinFt,
    });
    if (isInfeasible(items)) return null;
    const merged = mergeScores(scoreOutput(items, lvlDropMinFt), constantScore);
    return { score: { lengths, ...merged }, items };
  };

  // ---- stage 1: sweep, seed-only budget
  let skipped = 0;
  const swept = [];
  for (const lengths of sets) {
    if (minLength > 0 && !lengths.some((l) => l >= minLength - 1e-6)) { skipped++; continue; }
    const r = evaluate(lengths, { lnsMaxIters: 0 });
    if (!r) { skipped++; continue; }
    swept.push(r.score);
  }
  swept.sort(compareCandidates);

  // ---- stage 2: finalists at the full default budget. Keep the winner's cut
  // items — that's the actual per-piece cut plan the shop needs to see.
  const finalists = [];
  const itemsByKey = new Map();
  for (const s of swept.slice(0, topN)) {
    const r = evaluate(s.lengths, {});
    if (!r) continue;
    finalists.push(r.score);
    itemsByKey.set(r.score.lengths.join(','), r.items);
  }
  finalists.sort(compareCandidates);

  const ranked = finalists.concat(swept.slice(topN));
  const best = ranked[0] || null;
  const bestItems = best ? itemsByKey.get(best.lengths.join(',')) : null;

  return {
    best,
    ranked,
    // Stitch the searched and constant halves back together so the cut sheet
    // shows the whole job, not just its I-Joist.
    cutPlan: bestItems
      ? buildCutPlan([...bestItems, ...constantCutItems], lvlDropMinFt)
      : [],
    // The winning plan's RAW engine items. A caller running several independent
    // searches (one per product) needs these to build ONE cut sheet across all of
    // them, rather than a per-product sheet each renumbering from #1.
    bestItems: bestItems || [],
    evaluated: swept.length,
    skipped,
    maxLengths,
    menu,
  };
}

// ---- the actual pieces -----------------------------------------------------
// Regroup the winning plan's boards into job → category/size → boards. Every
// field here already exists on the emitted cut items; this only reshapes them
// so the UI can render a cut sheet instead of just a buy list.
//
// Boards are per-JOB by construction — optimizeCuts builds cutGroups inside its
// per-job loop — so a stock piece never carries cuts for two different jobs.
function buildCutPlan(items, lvlDropMinFt = DEFAULT_LVL_DROP_MIN_FT) {
  const jobs = new Map();

  for (const it of items) {
    if (!it || it.kind !== 'cut') continue;
    if (!jobs.has(it.jobNumber)) {
      jobs.set(it.jobNumber, {
        jobNumber: it.jobNumber, jobName: it.jobName, deliveryDate: it.deliveryDate,
        groups: new Map(),
      });
    }
    const job = jobs.get(it.jobNumber);
    const key = `${it.category}|${it.size}`;
    if (!job.groups.has(key)) {
      job.groups.set(key, { category: it.category, size: it.size, boards: [] });
    }
    const { raw, waste, drop } = classifyRemainder(it.stockLength, it.cuts, it.category, lvlDropMinFt);
    job.groups.get(key).boards.push({
      stockPieceNumber: it.stockPieceNumber,
      stockLength: it.stockLength,
      cutFrom: it.cutFrom,
      cuts: it.cuts.map((c) => ({ label: c.label, length: c.length })),
      remainder: round3(raw),
      waste: round3(waste),
      drop: round3(drop),
    });
  }

  // Renumber boards sequentially within each job. The engine's own
  // stockPieceNumber is a counter across one optimizeCuts call, and the planner
  // stitches TWO calls together (searched I-Joist + constant LVL/Rim), so those
  // counters collide. A per-job sequence is also what a cut sheet wants.
  return [...jobs.values()].map((j) => {
    let seq = 0;
    return {
      jobNumber: j.jobNumber, jobName: j.jobName, deliveryDate: j.deliveryDate,
      groups: [...j.groups.values()].map((g) => {
        const boards = g.boards
          .sort((a, b) => b.stockLength - a.stockLength ||
                          a.stockPieceNumber - b.stockPieceNumber)
          .map((b) => ({ ...b, stockPieceNumber: ++seq }));
        return {
          category: g.category, size: g.size, boards,
          boardCount: boards.length,
          feet: round3(boards.reduce((s, b) => s + b.stockLength, 0)),
          waste: round3(boards.reduce((s, b) => s + b.waste, 0)),
          drops: round3(boards.reduce((s, b) => s + b.drop, 0)),
        };
      }),
    };
  });
}

// ---- how many lengths should I buy? ----------------------------------------
// The question behind the question. Running the search once at N=5 tells you the
// best 5-set; it does NOT tell you that N=2 was just as good, which is the thing
// a buyer actually needs. This runs N = 1..maxLengths and reports the curve plus
// the knee — the smallest N that is within `tolerance` of the best achievable
// I-Joist waste.
/**
 * @returns {{curve, recommended, best, cutPlan, suggestions}}
 */
function analyzeLengthCount(cutItems, opts = {}) {
  const maxLengths = opts.maxLengths ?? DEFAULT_MAX_LENGTHS;
  const tolerance = opts.kneeToleranceFt ?? DEFAULT_KNEE_TOLERANCE_FT;
  const menu = (opts.menu ?? IJOIST_LENGTH_MENU).slice().sort((a, b) => b - a);

  // The curve refines exactly ONE candidate per N (topN:1) rather than the
  // caller's full topN. Measured on job 33844J:
  //
  //   topN:0 (sweep only)  0.7s   waste by N -> 68, 28, 24, 24, 24   WRONG
  //   topN:1               4.6s   waste by N -> 68,  0,  0,  0,  0   correct
  //   topN:2              11.7s   waste by N -> 68,  0,  0,  0,  0   no better
  //
  // So the seed-only sweep is a fine RANKER but a poor ESTIMATOR — it reported
  // 28 ft where the refined plan finds an exact fit, which moved the knee from
  // 2 lengths to 3 and would have had a buyer order a length they don't need.
  // One refinement per N is the cheapest budget that gets the knee right.
  //
  // KNOWN LIMIT: the curve is therefore an UPPER BOUND on waste, not the exact
  // optimum — the winning N is re-refined at the caller's full topN below and
  // can come out lower than its own curve row (measured: 26 -> 12 ft on a
  // three-job batch). Since refinement only ever improves, the knee can in
  // principle sit one N later than a fully-refined curve would put it. Raising
  // topN here trades seconds for closing that gap.
  //
  // The other dial is opts.lnsMaxMs — how long the engine may spend improving
  // each plan (default 1500ms per material per job). Measured on a FOUR-job
  // batch at lengths [40,36,32,28], one full engine call:
  //
  //   default 1500ms   4224ms   I-Joist waste 54 ft
  //   600ms            2405ms                 58 ft
  //   250ms            1003ms                 58 ft
  //   100ms             403ms                 58 ft
  //   seed only (0)       6ms                 94 ft
  //
  // So 250ms is ~4x faster for +4 ft on a ~5000 ft batch, and seed-only is far
  // too lossy. RTW's call is to keep the full 1500ms and the best plan; the dial
  // exists for anyone who would rather have the seconds.
  //
  // (An earlier revision of this comment claimed capping made no difference.
  // It did not: opts.lnsMaxMs was never threaded into the engine, so every
  // measurement behind that claim was a no-op. See `budget` in
  // selectStockLengths.)

  // Pack LVL + RimBoard ONCE for the whole analysis. Every search below reuses
  // it; see packConstant's rationale (LVL alone is ~493 ms of a ~606 ms call).
  const { headers, constantItems } = splitBatch(cutItems);
  const constantPlan = packConstant(constantItems, headers, {
    purchaseLengthsByCat: opts.purchaseLengthsByCat ?? null,
    lvlDropMinFt: opts.lvlDropMinFt ?? DEFAULT_LVL_DROP_MIN_FT,
    ...(opts.lnsMaxMs !== undefined ? { lnsMaxMs: opts.lnsMaxMs } : {}),
    ...(opts.lnsMaxIters !== undefined ? { lnsMaxIters: opts.lnsMaxIters } : {}),
  });

  // ---- how the candidate sets for each N are generated
  //
  // EXHAUSTIVE tries every C(pool, N) combination — exact, but it explodes with
  // the pool. Measured on a four-job batch:
  //
  //   supplier set (8 lengths), cap 5 ->    218 sets ->  50s
  //   ALL lengths (19),         cap 5 -> 16,663 sets -> 299s
  //
  // GREEDY grows the set one length at a time: try every single length, keep the
  // best; then try adding each remaining length to that, keep the best; and so
  // on. That is |pool| + (|pool|-1) + ... ≈ N x |pool| evaluations — 95 instead
  // of 16,663 for the full menu at cap 5.
  //
  // Greedy also makes the curve NESTED, which is what a buyer actually asks:
  // "if I add one more length, which one?" The exhaustive curve can jump to a
  // completely different set between N and N+1.
  //
  // It is a heuristic, so `auto` only switches to it when exhaustive would be
  // punishing, and ewp-select-lengths.test.js pins greedy against exhaustive on
  // pools small enough to check exactly.
  const strategy = opts.strategy ?? 'auto';
  const exhaustiveCost = (n) => {
    let t = 0;
    for (let k = 1; k <= n; k++) {
      let c = 1;
      for (let i = 0; i < k; i++) c = c * (menu.length - i) / (i + 1);
      t += Math.round(c);
    }
    return t;
  };
  const useGreedy = strategy === 'greedy' ||
    (strategy === 'auto' && exhaustiveCost(Math.min(maxLengths, menu.length)) > GREEDY_ABOVE_SETS);

  const curve = [];
  const runs = new Map();
  const setsUsed = new Map();            // N -> the candidate list that N searched
  let seed = null;                       // greedy: the winning set from N-1
  for (let n = 1; n <= Math.min(maxLengths, menu.length); n++) {
    // Greedy at N>1 only considers "the previous winner plus one more length".
    const candidateSets = !useGreedy ? undefined
      : n === 1 ? menu.map((l) => [l])
      : (seed || []).length === n - 1
        ? menu.filter((l) => !seed.includes(l)).map((l) => [...seed, l])
        : undefined;
    setsUsed.set(n, candidateSets);

    const run = selectStockLengths(cutItems, {
      ...opts, maxLengths: n, menu, topN: 1, constantPlan, candidateSets,
    });
    if (run.best) seed = run.best.lengths;
    runs.set(n, run);
    curve.push({
      n,
      feasible: !!run.best,
      lengths: run.best ? run.best.lengths : null,
      lengthsUsed: run.best ? run.best.lengthsUsed : null,
      ijoistWaste: run.best ? run.best.ijoistWaste : null,
      trueWaste: run.best ? run.best.trueWaste : null,
      recoverableDrops: run.best ? run.best.recoverableDrops : null,
      feetPurchased: run.best ? run.best.feetPurchased : null,
      boardsPurchased: run.best ? run.best.boardsPurchased : null,
    });
  }

  const feasible = curve.filter((c) => c.feasible);
  if (!feasible.length) {
    return { curve, recommended: null, best: null, cutPlan: [], strategy: useGreedy ? 'greedy' : 'exhaustive', suggestions: [
      { kind: 'infeasible', text:
        'No allowed length set can produce every cut. Check for a piece longer than the ' +
        'longest length in the pool.' },
    ] };
  }

  const bestWaste = Math.min(...feasible.map((c) => c.ijoistWaste));
  const knee = feasible.find((c) => c.ijoistWaste <= bestWaste + tolerance + 1e-9);

  // Now refine ONLY the winning count at the full budget, and report that plan.
  // The full budget can only improve on the sweep, so the curve's numbers are an
  // upper bound on waste and the refined winner is what gets shown.
  // Refine the winner at the caller's full topN — but WITHIN THE SAME CANDIDATE
  // SPACE the curve searched. Re-running this exhaustively under a greedy curve
  // let it return an unrelated set, which broke the nesting the greedy curve
  // promises (measured: N=2 chose [48,32], then the refine dropped 48 at N=3).
  const chosen = selectStockLengths(cutItems, {
    ...opts, maxLengths: knee.n, menu, constantPlan,
    candidateSets: setsUsed.get(knee.n),
  });
  const refined = curve.find((c) => c.n === knee.n);
  if (chosen.best && refined) {
    Object.assign(refined, {
      lengths: chosen.best.lengths,
      lengthsUsed: chosen.best.lengthsUsed,
      ijoistWaste: chosen.best.ijoistWaste,
      trueWaste: chosen.best.trueWaste,
      recoverableDrops: chosen.best.recoverableDrops,
      feetPurchased: chosen.best.feetPurchased,
      boardsPurchased: chosen.best.boardsPurchased,
    });
    knee.ijoistWaste = chosen.best.ijoistWaste;
  }

  return {
    curve,
    // Exhaustive is exact; greedy is a heuristic that can give up a little waste
    // for a large speedup. Callers surface this — an approximate answer must not
    // be presented as the best one.
    strategy: useGreedy ? 'greedy' : 'exhaustive',
    recommended: knee.n,
    best: chosen.best,
    cutPlan: chosen.cutPlan,
    bestItems: chosen.bestItems,
    // Alternatives AT the recommended count — the "what else could I have
    // ordered instead" list, which only makes sense against a fixed N.
    ranked: chosen.ranked,
    evaluated: chosen.evaluated,
    skipped: chosen.skipped,
    suggestions: buildSuggestions({ curve, knee, feasible, maxLengths, menu, cutItems, opts }),
  };
}

// Concrete, actionable advice — not a "waste is high" banner. Each suggestion
// names the thing to do and what it's worth.
function buildSuggestions({ curve, knee, feasible, maxLengths, menu, cutItems, opts }) {
  const out = [];
  const best = feasible.find((c) => c.n === knee.n);
  const ft = (l) => `${l}'`;

  // 0. The headline verdict when the plan is perfect — say so plainly, because
  //    "0 ft waste" next to a large recoverable-drop figure is exactly the case
  //    that got misread as a bug.
  if (knee.ijoistWaste <= 1e-9) {
    out.push({
      kind: 'clean',
      text: `Zero I-Joist waste — every board is an exact fill. ` +
            `Buy ${best.lengthsUsed.map(ft).join(' and ')} and nothing is left over.`,
    });
  }

  // 1. You allowed more lengths than the plan can use.
  if (best.lengthsUsed && best.lengthsUsed.length < maxLengths) {
    out.push({
      kind: 'fewer_lengths',
      text: `You allowed ${maxLengths} length${maxLengths === 1 ? '' : 's'}, but the best plan ` +
            `only opens ${best.lengthsUsed.length} — ${best.lengthsUsed.map(ft).join(', ')}. ` +
            `Ordering more distinct lengths buys nothing here.`,
    });
  }

  // 2. The knee: only worth saying when the extra lengths actually bought
  //    something, i.e. there IS a trade-off to describe.
  const last = feasible[feasible.length - 1];
  const gain = round3(knee.ijoistWaste - last.ijoistWaste);
  if (last.n > knee.n && gain > 1e-9) {
    out.push({
      kind: 'knee',
      text: `${knee.n} length${knee.n === 1 ? '' : 's'} gets you to ${knee.ijoistWaste} ft of ` +
            `I-Joist waste; allowing ${last.n} saves only ${gain} ft more.`,
    });
  }

  // 3. The trade-off in the other direction: what does ONE FEWER length cost?
  //    This is the actual purchasing question when the recommendation is to buy
  //    several — "is a 4th length on the PO worth 44 ft of material?" is a call
  //    only the office can make, but it can't make it without the number.
  const prev = feasible.find((c) => c.n === knee.n - 1);
  if (prev) {
    const cost = round3(prev.ijoistWaste - knee.ijoistWaste);
    out.push({
      kind: 'tradeoff',
      text: `Dropping to ${prev.n} length${prev.n === 1 ? '' : 's'} ` +
            `(${prev.lengthsUsed.map(ft).join(', ')}) costs ${cost} ft more waste ` +
            `— ${round3(prev.feetPurchased - knee.feetPurchased)} ft more material bought.`,
    });
  }

  // 4. Is the POOL the constraint — would a length the supplier doesn't stock
  //    help? This used to re-run the whole search over the full 19-length menu:
  //    C(19,4) = 3876 candidates, ~34 SECONDS, for one sentence of advice — over
  //    a third of the total wait on a four-job batch.
  //
  //    Instead, ask the narrower question the buyer actually has: "swap ONE of
  //    my lengths for one I can't currently get." That is
  //    |winning| x |unstocked| candidate sets — 4 x 11 = 44 here — evaluated by
  //    the cheap sweep, with only the leader refined, and only when it wins.
  //    Same answer, same named length, ~0.5s instead of 34s.
  if (menu.length < IJOIST_LENGTH_MENU.length && knee.ijoistWaste > 1e-9 && best.lengths) {
    const unstocked = IJOIST_LENGTH_MENU.filter((l) => !menu.includes(l));
    const seen = new Set();
    const candidateSets = [];
    for (const L of unstocked) {
      for (let i = 0; i < best.lengths.length; i++) {
        const set = best.lengths.map((x, j) => (j === i ? L : x));
        if (new Set(set).size !== set.length) continue;          // swap collided
        const key = [...set].sort((a, b) => b - a).join(',');
        if (seen.has(key)) continue;
        seen.add(key);
        candidateSets.push(set);
      }
    }
    if (candidateSets.length) {
      const wide = selectStockLengths(cutItems, {
        ...opts, maxLengths: knee.n, menu: IJOIST_LENGTH_MENU, candidateSets, topN: 1,
      });
      if (wide.best && wide.best.ijoistWaste < knee.ijoistWaste - 1e-9) {
        const extra = wide.best.lengths.filter((l) => !menu.includes(l));
        out.push({
          kind: 'wider_pool',
          text: `Swapping in ${extra.map(ft).join(', ')} — a length your pool doesn't include — ` +
                `would cut I-Joist waste from ${knee.ijoistWaste} ft to ${wide.best.ijoistWaste} ft ` +
                `(saves ${round3(knee.ijoistWaste - wide.best.ijoistWaste)} ft) using ` +
                `${wide.best.lengths.map(ft).join(', ')}. Worth asking the supplier.`,
          lengths: wide.best.lengths,
        });
      }
    }
  }

  // 5. Where the remaining waste physically is — usually one odd piece with no
  //    partner, which is a design conversation, not a purchasing one.
  if (knee.ijoistWaste > 1e-9) {
    const chosen = feasible.find((c) => c.n === knee.n);
    out.push({
      kind: 'residual',
      text: `${chosen.ijoistWaste} ft of I-Joist waste remains at ${knee.n} length` +
            `${knee.n === 1 ? '' : 's'}. See the cut plan for the boards carrying it — ` +
            `it is usually one odd piece with no partner to share a board with.`,
    });
  }

  return out;
}

// ---- the whole order -------------------------------------------------------
// analyzeLengthCount answers "how many lengths for THIS material?". A real batch
// can carry several I-Joist products, each with its own supplier availability, so
// this runs that analysis once PER PRODUCT and assembles one order out of the
// results.
//
// Running them separately is not an approximation — see productsOf() for why the
// problem is genuinely separable. Each product gets its own length budget, because
// a 36' 11 7/8" and a 36' 16" are different line items on the PO; "4 lengths"
// spent globally would mean something the buyer never asked for.
/**
 * @param {Array}  cutItems  parseJobCsv-shaped items across every job in the batch
 * @param {Object} opts
 *   maxLengths        {number}  default cap, per product
 *   maxLengthsBySize  {Object}  optional per-product cap override, keyed normalizeSize
 *   poolBySize        {Object}  per-product candidate pool, keyed normalizeSize
 *   menu              {number[]} fallback pool for products with no entry
 *   purchaseLengthsByCat, lvlDropMinFt, topN, kneeToleranceFt — as elsewhere
 * @returns {{products, totals, purchaseList, cutPlan, constant}}
 */
function analyzeBatch(cutItems, opts = {}) {
  const lvlDropMinFt = opts.lvlDropMinFt ?? DEFAULT_LVL_DROP_MIN_FT;
  const { headers, ijoistItems, constantItems } = splitBatch(cutItems);
  const poolBySize = opts.poolBySize || {};
  const capBySize = opts.maxLengthsBySize || {};

  // LVL + RimBoard once for the whole order — they don't vary with any I-Joist
  // choice, and they're the expensive half of an engine call.
  const constant = packConstant(constantItems, headers, {
    purchaseLengthsByCat: opts.purchaseLengthsByCat ?? null,
    lvlDropMinFt,
    ...(opts.lnsMaxMs !== undefined ? { lnsMaxMs: opts.lnsMaxMs } : {}),
    ...(opts.lnsMaxIters !== undefined ? { lnsMaxIters: opts.lnsMaxIters } : {}),
  });
  if (constant === INFEASIBLE) {
    return {
      products: [], totals: null, purchaseList: [], cutPlan: [],
      error: 'Some LVL or Rim Board piece is longer than any purchasable length.',
    };
  }

  const products = [];
  let allItems = constant ? [...constant.items] : [];

  for (const p of productsOf(ijoistItems)) {
    // A product's sub-batch is its own items only; splitBatch inside will find no
    // LVL/Rim, so each analysis is purely this product's I-Joist.
    const sub = [...headers, ...p.items];
    const run = analyzeLengthCount(sub, {
      ...opts,
      maxLengths: capBySize[p.key] ?? opts.maxLengths ?? DEFAULT_MAX_LENGTHS,
      menu: poolBySize[p.key] ?? opts.menu ?? IJOIST_LENGTH_MENU,
      // The per-product pool is expressed through the search's own `menu`, so the
      // engine-level override would be redundant here — but pass it through for
      // any caller that set one directly.
      purchaseLengthsBySize: opts.purchaseLengthsBySize,
      lvlDropMinFt,
    });
    products.push({
      key: p.key, size: p.size, depth: p.depth, pieces: p.pieces, feet: p.feet,
      recommended: run.recommended, curve: run.curve, best: run.best,
      strategy: run.strategy,
      suggestions: run.suggestions, ranked: run.ranked || [],
      evaluated: run.evaluated || 0, skipped: run.skipped || 0,
    });
    if (run.bestItems) allItems = allItems.concat(run.bestItems);
  }

  // ---- assemble one order out of the independent answers
  const totals = scoreOutput(allItems, lvlDropMinFt);
  const infeasible = products.filter((p) => !p.best).map((p) => p.size);

  return {
    products,
    totals,
    purchaseList: totals.purchaseList,
    cutPlan: buildCutPlan(allItems, lvlDropMinFt),
    constant: constant ? constant.score : null,
    error: infeasible.length
      ? `No allowed length set can cut every piece of: ${infeasible.join(', ')}.`
      : null,
  };
}

module.exports = {
  selectStockLengths, analyzeLengthCount, analyzeBatch,
  buildCutPlan, combinations, scoreOutput, productsOf, splitBatch,
};
