// =============================================================
// ewp-select-lengths.test.js — the stock-length SELECTION search.
// Run with: npm test  (node --test)
// =============================================================
// selectStockLengths adds no packing logic — it drives optimizeCuts through
// opts.ijoistLengthsByDepth and ranks the results. So these tests cover the
// three things that are actually new:
//   1. the ranking picks the hand-computable winner,
//   2. infeasible candidate sets are EXCLUDED rather than ranked last,
//   3. greenfield stubs stop no_inventory_match from blocking a stock-free batch.
// The packing itself stays covered by ewp-golden / ewp-twomode / ewp-presets.
//
// Every test passes a deliberately SMALL `menu`. The full 19-length menu at
// maxLengths:3 is 969 candidates and takes ~16s — correct, but not something to
// pay for on every `npm test`.
// =============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  selectStockLengths, analyzeLengthCount, combinations,
} = require('../src/ewp/selectStockLengths.js');
const {
  optimizeCuts, DEFAULT_PURCHASE_LENGTHS_BY_CAT, classifyRemainder, DEFAULT_LVL_DROP_MIN_FT,
} = require('../src/ewp/optimizeCuts.js');
const { specialOrderInventoryStubs } = require('../src/ewp/dbAdapters.js');
const { detectWarnings } = require('../src/ewp/detectWarnings.js');
const { parseJobCsv } = require('../src/ewp/parseCsv.js');

const FIX = path.join(__dirname, 'ewp-fixtures');

const SIZE = '11 7/8" PJI-40';   // extractDepth -> "11-78"

// One job's worth of I-Joist cuts, parseJobCsv-shaped.
function job(pieces, { jobNumber = 'T1', size = SIZE } = {}) {
  const items = [{
    kind: 'header', source: 'cuts',
    jobNumber, jobName: 'Test', deliveryDate: '1/1/2026',
  }];
  for (const [qty, decimalFeet, label] of pieces) {
    items.push({
      kind: 'material', source: 'cuts',
      jobNumber, jobName: 'Test', deliveryDate: '1/1/2026',
      category: 'I-Joist', size, qty, decimalFeet, label,
    });
  }
  return items;
}

// ---- combinations ----------------------------------------------------------

test('combinations enumerates every k-subset, deterministically', () => {
  assert.deepEqual(combinations([4, 3, 2, 1], 2),
    [[4, 3], [4, 2], [4, 1], [3, 2], [3, 1], [2, 1]]);
  assert.deepEqual(combinations([1, 2, 3], 0), [[]]);
  assert.equal(combinations([1, 2, 3, 4, 5], 3).length, 10);   // C(5,3)
});

// ---- the ranking picks the hand-computable winner ---------------------------

test('three 16-ft cuts with one allowed length: 48 wins (exact fill, zero waste)', () => {
  // 48 -> one board, 16*3 = 48, waste 0.
  // 32 -> two boards (16+16, then 16), 64 ft bought, waste 16.
  // 34 -> two boards, 68 ft bought, waste 20.
  const r = selectStockLengths(job([[3, 16, 'J16']]), {
    maxLengths: 1, menu: [48, 34, 32],
  });
  assert.deepEqual(r.best.lengths, [48]);
  assert.equal(r.best.feetPurchased, 48);
  assert.equal(r.best.boardsPurchased, 1);
  assert.equal(r.best.ijoistWaste, 0);
  assert.equal(r.best.trueWaste, 0);

  // and the ranking is a total order over the rest, not just a winner
  assert.deepEqual(r.ranked.map((c) => c.lengths[0]), [48, 32, 34]);
});

test('lengthsUsed reports what was actually bought, not what was allowed', () => {
  // Allowed 3 lengths, but a single 48-ft exact fill only ever opens one.
  const r = selectStockLengths(job([[3, 16, 'J16']]), {
    maxLengths: 3, menu: [48, 34, 32, 30, 28],
  });
  assert.equal(r.best.feetPurchased, 48);
  assert.deepEqual(r.best.lengthsUsed, [48], 'only 48 is actually purchased');
  assert.equal(r.best.lengths.length, 3, 'the candidate set still names 3 allowed lengths');
});

test('more allowed lengths never buys more feet (monotone in maxLengths)', () => {
  const pieces = job([[4, 27.5, 'A'], [3, 19.25, 'B'], [2, 41, 'C']]);
  const menu = [48, 44, 40, 36, 34, 32, 30, 28];
  const feet = [1, 2, 3].map(
    (n) => selectStockLengths(pieces, { maxLengths: n, menu, topN: 1 }).best.feetPurchased
  );
  assert.ok(feet[1] <= feet[0], `2 lengths (${feet[1]}) must not beat 1 (${feet[0]})`);
  assert.ok(feet[2] <= feet[1], `3 lengths (${feet[2]}) must not beat 2 (${feet[1]})`);
});

// ---- feasibility -----------------------------------------------------------

test('a candidate set that cannot hold the longest cut is skipped, not ranked', () => {
  // A 40-ft cut cannot come from a 28-ft board, and RimBoard-style "two shorts
  // make a long" is not a thing for a single continuous piece.
  const r = selectStockLengths(job([[1, 40, 'J40']]), {
    maxLengths: 1, menu: [48, 28],
  });
  assert.deepEqual(r.best.lengths, [48]);
  assert.equal(r.evaluated, 1, 'only [48] is feasible');
  assert.equal(r.skipped, 1, '[28] is skipped');
  assert.ok(!r.ranked.some((c) => c.lengths.includes(28) && c.lengths.length === 1),
    '[28] must not appear in the ranking at all');
});

test('an all-infeasible search returns best:null rather than throwing', () => {
  const r = selectStockLengths(job([[1, 47, 'J47']]), { maxLengths: 1, menu: [28, 30] });
  assert.equal(r.best, null);
  assert.deepEqual(r.ranked, []);
  assert.equal(r.skipped, 2);
});

// ---- the `require` knob ----------------------------------------------------

test('require pins a length into every candidate', () => {
  const r = selectStockLengths(job([[2, 15, 'A'], [2, 27, 'B']]), {
    maxLengths: 2, menu: [48, 44, 40, 36, 32, 30], require: [30],
  });
  assert.ok(r.ranked.length > 0);
  for (const c of r.ranked) assert.ok(c.lengths.includes(30), `${c.lengths} must include 30`);
});

test('require validates against the menu and against maxLengths', () => {
  const items = job([[1, 20, 'A']]);
  assert.throws(() => selectStockLengths(items, { menu: [48, 40], require: [26] }),
    /not in the candidate menu/);
  assert.throws(() => selectStockLengths(items, { maxLengths: 1, menu: [48, 40], require: [48, 40] }),
    /maxLengths/);
});

// ---- greenfield stubs ------------------------------------------------------

test('greenfield stubs suppress no_inventory_match so a stock-free batch is not blocked', () => {
  const cuts = job([[2, 20, 'A']]);

  // Without stubs the batch is blocked — this is the app's correct behavior and
  // exactly what the planner has to work around.
  const bare = detectWarnings(optimizeCuts(cuts, {}));
  assert.equal(bare.blocked, true);
  assert.ok(bare.alert.rawWarnings.some((w) => w.warningType === 'no_inventory_match'));

  // With zero-qty stubs it is not. Checked against optimizeCuts + detectWarnings
  // directly rather than through runPipelineFromItems: the pipeline pulls in six
  // more app modules and the xlsx package to reach the same conclusion, none of
  // which the planner ever runs.
  const stubs = specialOrderInventoryStubs([SIZE]);
  const items = optimizeCuts([...cuts, ...stubs], {});
  const gate = detectWarnings(items);
  assert.equal(gate.blocked, false);

  const boards = items.filter((i) => i.kind === 'cut');
  assert.ok(boards.length > 0);
  // The stubs supply no actual stock: every board is a purchase.
  assert.ok(boards.every((b) => b.cutFrom === 'purchase'));
});

// ---- consistency with the engine's own objective ---------------------------

test('ijoistFeetPurchased minus ijoistWaste equals fixed demand for every candidate', () => {
  // Greenfield means every board is bought, so waste = feetBought - feetNeeded.
  // Demand is fixed, so ranking by feet purchased and by waste are the SAME
  // ordering — this is why one scalar is enough.
  const pieces = job([[4, 27.5, 'A'], [3, 19.25, 'B']]);
  const demand = 4 * 27.5 + 3 * 19.25;
  const r = selectStockLengths(pieces, { maxLengths: 2, menu: [48, 40, 36, 32, 28], topN: 1 });
  for (const c of r.ranked) {
    assert.ok(Math.abs((c.ijoistFeetPurchased - c.ijoistWaste) - demand) < 1e-6,
      `[${c.lengths}]: ${c.ijoistFeetPurchased} - ${c.ijoistWaste} != ${demand}`);
  }
});

test('the full supplier set as a single candidate matches an unconstrained run', () => {
  const cuts = job([[4, 27.5, 'A'], [3, 19.25, 'B'], [2, 41, 'C']]);
  const menu = DEFAULT_PURCHASE_LENGTHS_BY_CAT['I-Joist'];
  const r = selectStockLengths(cuts, { maxLengths: menu.length, menu });
  assert.equal(r.evaluated, 1, 'C(8,8) is exactly one candidate');

  // Same inputs straight through the engine with no preset at all.
  const items = optimizeCuts([...cuts, ...specialOrderInventoryStubs([SIZE])], {});
  const summary = items.find((i) => i.kind === 'summary');
  const feet = summary.purchaseList.reduce((s, p) => s + p.stockLength * p.qty, 0);
  assert.equal(r.best.feetPurchased, feet);
});

// ---- determinism -----------------------------------------------------------

test('two searches over the same input are byte-identical', () => {
  const cuts = job([[4, 27.5, 'A'], [3, 19.25, 'B']]);
  // topN:2 so stage 2 (full-budget refinement) is exercised, not skipped.
  const opts = { maxLengths: 2, menu: [48, 40, 36, 32, 28], topN: 2 };
  assert.equal(
    JSON.stringify(selectStockLengths(cuts, opts)),
    JSON.stringify(selectStockLengths(cuts, opts))
  );
});

test('ranking is stable under menu ordering (input order must not leak into results)', () => {
  const cuts = job([[4, 27.5, 'A'], [3, 19.25, 'B']]);
  const a = selectStockLengths(cuts, { maxLengths: 2, menu: [48, 40, 36, 32, 28], topN: 2 });
  const b = selectStockLengths(cuts, { maxLengths: 2, menu: [28, 32, 36, 40, 48], topN: 2 });
  assert.deepEqual(a.ranked.map((c) => c.lengths), b.ranked.map((c) => c.lengths));
});

// ---- multi-job -------------------------------------------------------------

test('multiple jobs combine into one batch buy (real fixtures)', () => {
  const cuts = [
    ...parseJobCsv(fs.readFileSync(path.join(FIX, '34120J-materials.csv'), 'utf8')),
    ...parseJobCsv(fs.readFileSync(path.join(FIX, '34182J-materials.csv'), 'utf8')),
  ];
  // Supplier set only (C(8,2) = 28) to keep this fast.
  const r = selectStockLengths(cuts, {
    maxLengths: 2, menu: DEFAULT_PURCHASE_LENGTHS_BY_CAT['I-Joist'], topN: 1,
  });
  assert.ok(r.best, 'a feasible plan exists for the two sample jobs');
  assert.equal(r.best.lengths.length, 2);

  // The buy list is merged across jobs — one line per (category, size, length).
  const keys = r.best.purchaseList.map((p) => `${p.category}|${p.size}|${p.stockLength}`);
  assert.equal(keys.length, new Set(keys).size, 'purchase lines must be deduplicated');

  // LVL and RimBoard are still planned; the search only varies I-Joist.
  assert.ok(r.best.feetPurchased > r.best.ijoistFeetPurchased,
    'non-I-Joist categories contribute feet too');
});

test('job order does not change a greenfield batch result', () => {
  const a = parseJobCsv(fs.readFileSync(path.join(FIX, '34120J-materials.csv'), 'utf8'));
  const b = parseJobCsv(fs.readFileSync(path.join(FIX, '34182J-materials.csv'), 'utf8'));
  const opts = { maxLengths: 1, menu: DEFAULT_PURCHASE_LENGTHS_BY_CAT['I-Joist'], topN: 1 };
  // With no on-hand stock there is nothing scarce to claim first, so the
  // first-seen depletion order in optimizeCuts becomes irrelevant.
  assert.equal(
    selectStockLengths([...a, ...b], opts).best.feetPurchased,
    selectStockLengths([...b, ...a], opts).best.feetPurchased
  );
});

// ---- job 33844J: the "144 ft of waste" bug report --------------------------
// A buyer allowed 5 lengths, was shown 144 ft of waste, and reasonably called it
// wrong. It WAS wrong — as a label. The I-Joist plan is a perfect fit; all 144 ft
// is LVL offcuts that clear the drop threshold and return to stock. These lock
// both halves of that: the arithmetic, and the naming.

const CSV_33844 = path.join(FIX, '33844J-materials.csv');
const SUPPLIER = DEFAULT_PURCHASE_LENGTHS_BY_CAT['I-Joist'];
const job33844 = () => parseJobCsv(fs.readFileSync(CSV_33844, 'utf8'));

test('33844J: demand is 1480 I-Joist / 240 LVL / 216 Rim ft', () => {
  const mats = job33844().filter((i) => i.kind === 'material');
  const ft = {};
  for (const m of mats) ft[m.category] = (ft[m.category] || 0) + m.qty * m.decimalFeet;
  assert.deepEqual(ft, { 'I-Joist': 1480, LVL: 240, RimBoard: 216 });
});

test('33844J: 5 allowed lengths gives ZERO true waste, and the 144 ft is LVL drops', () => {
  const r = selectStockLengths(job33844(), { maxLengths: 5, menu: SUPPLIER, topN: 1 });

  assert.equal(r.best.ijoistWaste, 0, 'I-Joist is an exact fit');
  assert.equal(r.best.trueWaste, 0, 'nothing is actually wasted');
  assert.equal(r.best.recoverableDrops, 144, 'the reported 144 ft is recoverable drops');
  assert.equal(r.best.rawRemainder, 144, 'raw remainder is what the old code showed');

  // Every foot of it is LVL, and LVL buys exactly 8 boards at 48 ft.
  assert.deepEqual(r.best.byCategory['I-Joist'],
    { boards: 43, feet: 1480, waste: 0, drops: 0, rawRemainder: 0 });
  assert.deepEqual(r.best.byCategory.LVL,
    { boards: 8, feet: 384, waste: 0, drops: 144, rawRemainder: 144 });
  assert.deepEqual(r.best.byCategory.RimBoard,
    { boards: 18, feet: 216, waste: 0, drops: 0, rawRemainder: 0 });
});

test('33844J: the answer is TWO lengths (36 and 32), not five', () => {
  const a = analyzeLengthCount(job33844(), { maxLengths: 5, menu: SUPPLIER, topN: 1 });
  assert.equal(a.recommended, 2);
  assert.deepEqual(a.best.lengthsUsed, [36, 32]);
  assert.equal(a.best.ijoistWaste, 0);

  // Waste must fall then flatten — never rise — as lengths are allowed.
  const waste = a.curve.map((c) => c.ijoistWaste);
  assert.deepEqual(waste, [68, 0, 0, 0, 0]);
  for (let i = 1; i < waste.length; i++) assert.ok(waste[i] <= waste[i - 1]);

  // And the advice says so in words.
  assert.ok(a.suggestions.some((s) => s.kind === 'clean'));
  assert.ok(a.suggestions.some((s) => s.kind === 'fewer_lengths' && /only opens 2/.test(s.text)));
});

test('33844J: the cut plan accounts for every ordered piece, on per-job boards', () => {
  const r = selectStockLengths(job33844(), { maxLengths: 2, menu: SUPPLIER, topN: 1 });
  assert.equal(r.cutPlan.length, 1, 'one job');
  const jobPlan = r.cutPlan[0];
  assert.equal(jobPlan.jobNumber, '33844J');
  assert.equal(jobPlan.jobName, 'Sample Job B');

  // Every category is present — the searched half and the constant half are
  // stitched back together.
  assert.deepEqual(jobPlan.groups.map((g) => g.category).sort(),
    ['I-Joist', 'LVL', 'RimBoard']);

  // Board numbers are a single unbroken per-job sequence across all groups.
  const nums = jobPlan.groups.flatMap((g) => g.boards.map((b) => b.stockPieceNumber));
  assert.deepEqual(nums, Array.from({ length: nums.length }, (_, i) => i + 1));

  // Every cut piece from the CSV appears exactly once, at its ordered length.
  const planned = {};
  for (const g of jobPlan.groups) {
    for (const b of g.boards) for (const c of b.cuts) {
      planned[c.label] = (planned[c.label] || 0) + 1;
      assert.ok(c.length <= b.stockLength + 1e-9, 'a cut never exceeds its board');
    }
  }
  for (const m of job33844().filter((i) => i.kind === 'material')) {
    assert.equal(planned[m.label], m.qty, `${m.label}: planned ${planned[m.label]} of ${m.qty}`);
  }

  // And the boards reconstruct the buy list exactly.
  const fromPlan = jobPlan.groups.reduce((s, g) => s + g.feet, 0);
  const fromList = r.best.purchaseList.reduce((s, p) => s + p.stockLength * p.qty, 0);
  assert.equal(fromPlan, fromList);
  assert.equal(fromList, r.best.feetPurchased);
});

// ---- the drop rule ---------------------------------------------------------

test('classifyRemainder splits raw remainder into waste vs recoverable drop', () => {
  const cuts = (n) => [{ label: 'x', length: n }];
  // LVL at the default 8 ft threshold.
  assert.deepEqual(classifyRemainder(48, cuts(40), 'LVL'), { raw: 8, waste: 0, drop: 8 });
  assert.deepEqual(classifyRemainder(48, cuts(41), 'LVL'), { raw: 7, waste: 7, drop: 0 });
  // I-Joist and RimBoard remainders are ALWAYS waste, however big.
  assert.deepEqual(classifyRemainder(48, cuts(10), 'I-Joist'), { raw: 38, waste: 38, drop: 0 });
  assert.deepEqual(classifyRemainder(12, cuts(2), 'RimBoard'), { raw: 10, waste: 10, drop: 0 });
  // Exact fit and null (unfulfillable) boards.
  assert.deepEqual(classifyRemainder(36, cuts(36), 'I-Joist'), { raw: 0, waste: 0, drop: 0 });
  assert.deepEqual(classifyRemainder(null, cuts(9), 'LVL'), { raw: 0, waste: 0, drop: 0 });
  // The threshold is a parameter, not a constant.
  assert.deepEqual(classifyRemainder(48, cuts(40), 'LVL', 10), { raw: 8, waste: 8, drop: 0 });
  assert.equal(DEFAULT_LVL_DROP_MIN_FT, 8);
});

test('raising the drop threshold reclassifies 33844J drops as true waste', () => {
  const r = selectStockLengths(job33844(),
    { maxLengths: 2, menu: SUPPLIER, topN: 1, lvlDropMinFt: 30 });
  assert.equal(r.best.recoverableDrops, 0);
  assert.equal(r.best.trueWaste, 144, 'the same 144 ft, now counted as loss');
  assert.equal(r.best.ijoistWaste, 0, 'I-Joist is unaffected by the LVL rule');
});

// ---- per-category purchase pool --------------------------------------------

test('purchaseLengthsByCat changes LVL sourcing and leaves I-Joist alone', () => {
  const base = selectStockLengths(job33844(), { maxLengths: 2, menu: SUPPLIER, topN: 1 });
  const wide = selectStockLengths(job33844(), {
    maxLengths: 2, menu: SUPPLIER, topN: 1, purchaseLengthsByCat: { LVL: [48, 44, 40] },
  });
  assert.equal(base.best.byCategory.LVL.feet, 384);
  assert.equal(wide.best.byCategory.LVL.feet, 320, 'shorter LVL boards mean fewer feet bought');
  assert.equal(wide.best.recoverableDrops, 80, 'and a smaller drop pile (was 144)');
  // I-Joist is untouched.
  assert.deepEqual(wide.best.byCategory['I-Joist'], base.best.byCategory['I-Joist']);
  assert.deepEqual(wide.best.lengthsUsed, base.best.lengthsUsed);
});

test('omitting purchaseLengthsByCat reproduces the default plan exactly', () => {
  const a = selectStockLengths(job33844(), { maxLengths: 2, menu: SUPPLIER, topN: 1 });
  const b = selectStockLengths(job33844(), {
    maxLengths: 2, menu: SUPPLIER, topN: 1, purchaseLengthsByCat: null,
  });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

test('a per-category override widens maxKnownStock (no false cut_exceeds_max_stock)', () => {
  // A 52 ft LVL beam is longer than any DEFAULT purchase length (max 48), so it
  // is a hard error normally — but not when the supplier sells LVL at 60.
  const beam = [
    { kind: 'header', source: 'cuts', jobNumber: 'B', jobName: 'x', deliveryDate: 'd' },
    { kind: 'material', source: 'cuts', jobNumber: 'B', category: 'LVL',
      size: 'LVL 1-3/4 x 11-7/8', qty: 1, decimalFeet: 52, label: 'BM52' },
  ];
  const stubs = specialOrderInventoryStubs(['LVL 1-3/4 x 11-7/8']);

  const hard = optimizeCuts([...beam, ...stubs], {});
  assert.ok(hard.some((i) => i.warningType === 'cut_exceeds_max_stock'),
    'unbuyable at the default 48 ft ceiling');

  const ok = optimizeCuts([...beam, ...stubs], { purchaseLengthsByCat: { LVL: [60, 48] } });
  assert.ok(!ok.some((i) => i.warningType === 'cut_exceeds_max_stock'),
    'a 60 ft purchase length raises the ceiling');
  assert.equal(ok.find((i) => i.kind === 'cut').stockLength, 60);
});

// ---- the searched/constant split -------------------------------------------

test('splitting LVL+Rim out of the search does not change the answer', () => {
  // selectStockLengths packs the non-I-Joist half ONCE and adds it as a constant
  // (LVL alone is ~493ms of a ~606ms engine call, and it cannot vary with the
  // I-Joist candidate). This proves the shortcut is exact: the split score must
  // match packing the whole batch together at the same lengths.
  const cuts = job33844();
  const lengths = [36, 32];
  const r = selectStockLengths(cuts, { maxLengths: 2, menu: [36, 32], topN: 1 });

  const byDepth = {};
  for (const d of require('../src/ewp/optimizeCuts.js').KNOWN_DEPTHS) byDepth[d] = lengths;
  const whole = optimizeCuts(
    [...cuts, ...specialOrderInventoryStubs(
      cuts.filter((i) => i.kind === 'material').map((i) => i.size))],
    { ijoistLengthsByDepth: byDepth }
  );
  const cutsOf = whole.filter((i) => i.kind === 'cut');
  const feet = cutsOf.reduce((s, b) => s + b.stockLength, 0);
  const boards = cutsOf.length;

  assert.equal(r.best.feetPurchased, feet, 'same feet bought');
  assert.equal(r.best.boards, boards, 'same board count');
  assert.equal(r.best.byCategory.LVL.feet, 384);
});

test('an unbuildable LVL piece makes the whole batch infeasible', () => {
  const cuts = [
    { kind: 'header', source: 'cuts', jobNumber: 'B', jobName: 'x', deliveryDate: 'd' },
    { kind: 'material', source: 'cuts', jobNumber: 'B', category: 'I-Joist',
      size: SIZE, qty: 1, decimalFeet: 20, label: 'J20' },
    { kind: 'material', source: 'cuts', jobNumber: 'B', category: 'LVL',
      size: 'LVL 1-3/4 x 11-7/8', qty: 1, decimalFeet: 44, label: 'BM44' },
  ];
  // LVL restricted to 40 ft cannot hold a 44 ft beam; no I-Joist choice helps.
  const r = selectStockLengths(cuts, {
    maxLengths: 1, menu: [48], purchaseLengthsByCat: { LVL: [40] },
  });
  assert.equal(r.best, null);
  assert.deepEqual(r.ranked, []);
});

// ---- per-product sourcing --------------------------------------------------
// Lengths differ by PRODUCT, not just by depth: 11 7/8" PJI-40 and 11 7/8" TJI 560
// share a depth but are different SKUs with different availability (Blake,
// 2026-08-02). These lock the finer grain and the separability it relies on.

const { analyzeBatch, productsOf, splitBatch } = require('../src/ewp/selectStockLengths.js');
const { normalizeSize } = require('../src/ewp/normalizeSize.js');

const TJI210 = '11 7/8" TJI® 210';
const TJI560 = '11 7/8" TJI® 560';
const DEEP16 = '16" PJI-40';

function multi(rows) {                       // rows: [[size, qty, ft, label]]
  const items = [{ kind: 'header', source: 'cuts', jobNumber: 'M1', jobName: 'Multi', deliveryDate: '1/1/2026' }];
  for (const [size, qty, decimalFeet, label] of rows) {
    items.push({ kind: 'material', source: 'cuts', jobNumber: 'M1', jobName: 'Multi',
      deliveryDate: '1/1/2026', category: 'I-Joist', size, qty, decimalFeet, label });
  }
  return items;
}

test('productsOf splits on product, not depth', () => {
  const items = multi([[TJI210, 2, 20, 'A'], [TJI560, 3, 20, 'B'], [DEEP16, 1, 20, 'C']]);
  const { ijoistItems } = splitBatch(items);
  const ps = productsOf(ijoistItems);
  assert.equal(ps.length, 3, 'three products');
  // Two of them share a depth — which is exactly why depth is the wrong key.
  assert.equal(ps.filter((p) => p.depth === '11-78').length, 2);
  assert.deepEqual(ps.map((p) => p.pieces), [2, 3, 1]);
  assert.deepEqual(ps.map((p) => p.feet), [40, 60, 20]);
});

test('per-product pools give products at ONE depth different plans', () => {
  // The case a per-depth design cannot express at all.
  const items = multi([[TJI210, 2, 30, 'A'], [TJI560, 2, 30, 'B']]);
  const r = analyzeBatch(items, {
    maxLengths: 1, menu: [48, 32], topN: 1,
    poolBySize: { [normalizeSize(TJI210)]: [32], [normalizeSize(TJI560)]: [48] },
  });
  const byKey = Object.fromEntries(r.products.map((p) => [p.size, p]));
  assert.deepEqual(byKey[TJI210].best.lengthsUsed, [32]);
  assert.deepEqual(byKey[TJI560].best.lengthsUsed, [48]);
  // Each product is its own line on the PO, even at the same depth.
  const lines = r.purchaseList.filter((p) => p.category === 'I-Joist');
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((l) => l.stockLength).sort((a, b) => a - b), [32, 48]);
});

test('products are independent: one product\'s pool cannot move another\'s boards', () => {
  const items = multi([[TJI210, 7, 31, 'A'], [TJI560, 5, 17, 'B']]);
  const key = normalizeSize(TJI210);
  const plan = (otherPool) => {
    const r = analyzeBatch(items, {
      maxLengths: 2, menu: [48, 44, 40, 36, 32, 28], topN: 1,
      poolBySize: { [key]: [36, 32], [normalizeSize(TJI560)]: otherPool },
    });
    return r.products.find((p) => p.size === TJI210);
  };
  const a = plan([48, 44]);
  const b = plan([36, 28]);
  assert.deepEqual(a.best.lengthsUsed, b.best.lengthsUsed);
  assert.equal(a.best.ijoistWaste, b.best.ijoistWaste);
  assert.equal(a.best.feetPurchased, b.best.feetPurchased);
});

test('batch waste is the SUM of the per-product wastes (separability)', () => {
  const items = multi([[TJI210, 7, 31, 'A'], [DEEP16, 6, 26, 'B']]);
  const r = analyzeBatch(items, { maxLengths: 2, menu: [48, 40, 36, 32, 28], topN: 1 });
  const sum = r.products.reduce((s, p) => s + p.best.ijoistWaste, 0);
  assert.ok(Math.abs(r.totals.trueWaste - sum) < 1e-6,
    `batch ${r.totals.trueWaste} != sum of products ${sum}`);
  const feet = r.products.reduce((s, p) => s + p.best.feetPurchased, 0);
  assert.ok(Math.abs(r.totals.feetPurchased - feet) < 1e-6);
});

test('each product gets its OWN length budget, not a shared one', () => {
  const items = multi([[TJI210, 7, 31, 'A'], [DEEP16, 6, 26, 'B']]);
  const r = analyzeBatch(items, { maxLengths: 2, menu: [48, 40, 36, 32, 28], topN: 1 });
  for (const p of r.products) {
    assert.ok(p.best.lengths.length <= 2, `${p.size} exceeded its own cap`);
    assert.ok(p.curve.length >= 1 && p.curve[p.curve.length - 1].n === 2,
      'the curve runs 1..cap for this product alone');
  }
});

test('analyzeBatch keeps LVL and Rim in the totals but out of the search', () => {
  const items = [
    ...multi([[TJI210, 2, 20, 'A']]),
    { kind: 'material', source: 'cuts', jobNumber: 'M1', jobName: 'Multi', deliveryDate: '1/1/2026',
      category: 'LVL', size: 'RigidLam LVL 1-3/4 x 9-1/2', qty: 2, decimalFeet: 30, label: 'BM' },
    { kind: 'material', source: 'cuts', jobNumber: 'M1', jobName: 'Multi', deliveryDate: '1/1/2026',
      category: 'RimBoard', size: '1 1/8" x 11 7/8" APA Rim Board', qty: 4, decimalFeet: 12, label: 'R' },
  ];
  const r = analyzeBatch(items, { maxLengths: 1, menu: [48, 32], topN: 1 });
  assert.equal(r.products.length, 1, 'only I-Joist products are searched');
  assert.deepEqual(Object.keys(r.totals.byCategory).sort(), ['I-Joist', 'LVL', 'RimBoard']);
  assert.equal(r.totals.byCategory.RimBoard.boards, 4);
  // Cut plan covers everything, on one per-job sheet.
  assert.equal(r.cutPlan.length, 1);
  assert.deepEqual(r.cutPlan[0].groups.map((g) => g.category).sort(),
    ['I-Joist', 'LVL', 'RimBoard']);
});

test('one infeasible product is reported without sinking the rest of the order', () => {
  const items = multi([[TJI210, 1, 44, 'LONG'], [TJI560, 2, 16, 'OK']]);
  const r = analyzeBatch(items, {
    maxLengths: 1, menu: [48, 32], topN: 1,
    poolBySize: { [normalizeSize(TJI210)]: [32], [normalizeSize(TJI560)]: [32] },
  });
  const bad = r.products.find((p) => p.size === TJI210);
  const good = r.products.find((p) => p.size === TJI560);
  assert.equal(bad.best, null, '44 ft cannot come off a 32 ft board');
  assert.ok(good.best, 'the other product still gets a plan');
  assert.match(r.error, /TJI® 210/);
});

test('the engine rung: purchaseLengthsBySize beats a per-depth preset', () => {
  const items = multi([[TJI210, 2, 30, 'A'], [TJI560, 2, 30, 'B']]);
  const stubs = specialOrderInventoryStubs([TJI210, TJI560]);
  const byDepth = {};
  for (const d of require('../src/ewp/optimizeCuts.js').KNOWN_DEPTHS) byDepth[d] = [48, 44, 40, 36, 32];

  const out = optimizeCuts([...items, ...stubs], {
    ijoistLengthsByDepth: byDepth,
    purchaseLengthsBySize: { [normalizeSize(TJI560)]: [48] },
  });
  const lens = (size) => out.filter((i) => i.kind === 'cut' && i.size === size)
    .map((b) => b.stockLength);
  assert.deepEqual(lens(TJI560), [48, 48], 'per-product override wins for TJI 560');
  assert.deepEqual(lens(TJI210), [32, 32], 'the other product still follows the depth preset');
});

test('omitting purchaseLengthsBySize leaves the app path byte-identical', () => {
  const items = multi([[TJI210, 2, 30, 'A']]);
  const stubs = specialOrderInventoryStubs([TJI210]);
  const a = optimizeCuts([...items, ...stubs], {});
  const b = optimizeCuts([...items, ...stubs], { purchaseLengthsBySize: null });
  assert.equal(JSON.stringify(a), JSON.stringify(b));
});

// ---- candidate generation: exhaustive vs greedy ----------------------------
// Ticking "all" takes the I-Joist pool from 8 lengths to 19, which turns 218
// candidate sets into 16,663 and a ~50s run into ~5 minutes. Above a threshold
// the search switches to greedy forward-selection — grow the set one length at a
// time — which is ~95 evaluations instead of 16,663. It is a heuristic, so these
// pin it against the exact answer wherever exact is affordable.

test('greedy stays close to exhaustive, and is honestly no better', () => {
  // Greedy IS a heuristic and it does lose sometimes: on this instance it locks
  // 48' in at N=2 and finishes on [48,32,30] (13 ft) where exhaustive finds
  // [40,32,28] (9 ft) — 4 ft on a 344 ft order. That is the trade being made for
  // a ~2x speedup on wide pools, and it is surfaced in the UI rather than hidden.
  const pieces = job([[6, 27.5, 'A'], [4, 19.25, 'B'], [3, 31, 'C']]);
  const menu = [48, 44, 40, 36, 34, 32, 30, 28];
  const ex = analyzeLengthCount(pieces, { maxLengths: 3, menu, topN: 1, strategy: 'exhaustive' });
  const gr = analyzeLengthCount(pieces, { maxLengths: 3, menu, topN: 1, strategy: 'greedy' });

  assert.ok(gr.best.ijoistWaste >= ex.best.ijoistWaste - 1e-9,
    'greedy searches a subset, so it can never beat exhaustive');
  const gap = gr.best.ijoistWaste - ex.best.ijoistWaste;
  assert.ok(gap <= 0.05 * ex.best.feetPurchased,
    `greedy gave up ${gap} ft, more than 5% of the order — too much to hide`);
  assert.equal(gr.strategy, 'greedy');
  assert.equal(ex.strategy, 'exhaustive');
});

test('the greedy curve is NESTED — each step adds one length to the last', () => {
  // This is a feature, not an accident: "if I add one more length, which one?"
  // is the question a buyer asks, and the exhaustive curve can jump to an
  // unrelated set between N and N+1.
  const pieces = job([[6, 27.5, 'A'], [4, 19.25, 'B'], [3, 31, 'C']]);
  const gr = analyzeLengthCount(pieces, {
    maxLengths: 4, menu: [48, 44, 40, 36, 34, 32, 30, 28], topN: 1, strategy: 'greedy',
  });
  const feasible = gr.curve.filter((c) => c.feasible);
  for (let i = 1; i < feasible.length; i++) {
    const prev = feasible[i - 1].lengths, cur = feasible[i].lengths;
    assert.equal(cur.length, prev.length + 1, `N=${feasible[i].n} should add exactly one length`);
    for (const l of prev) {
      assert.ok(cur.includes(l), `N=${feasible[i].n} dropped ${l} from [${prev}]`);
    }
  }
});

test('greedy never reports LESS waste than exhaustive (it is a lower-bound check)', () => {
  // Greedy may tie or lose, never win — exhaustive searches a superset.
  const pieces = job([[5, 23, 'A'], [7, 14.5, 'B'], [2, 37, 'C']]);
  const menu = [48, 44, 40, 36, 32, 28];
  for (const n of [1, 2, 3]) {
    const ex = analyzeLengthCount(pieces, { maxLengths: n, menu, topN: 1, strategy: 'exhaustive' });
    const gr = analyzeLengthCount(pieces, { maxLengths: n, menu, topN: 1, strategy: 'greedy' });
    assert.ok(gr.best.ijoistWaste >= ex.best.ijoistWaste - 1e-9,
      `N=${n}: greedy ${gr.best.ijoistWaste} beat exhaustive ${ex.best.ijoistWaste}, impossible`);
  }
});

test('auto keeps the everyday supplier-set search EXACT', () => {
  // 8 lengths at cap 5 is 218 sets — under the threshold, so nothing is
  // approximated for the case the office actually runs.
  const pieces = job([[6, 27.5, 'A'], [4, 19.25, 'B']]);
  const menu = [48, 44, 40, 36, 34, 32, 30, 28];
  const auto = analyzeLengthCount(pieces, { maxLengths: 3, menu, topN: 1 });
  const ex = analyzeLengthCount(pieces, { maxLengths: 3, menu, topN: 1, strategy: 'exhaustive' });
  assert.equal(JSON.stringify(auto.curve), JSON.stringify(ex.curve));
});

test('auto switches to greedy once the pool makes exhaustive punishing', () => {
  // The full 12–48 menu at cap 3 is 1,159 sets; greedy is 19+18+17 = 54.
  const pieces = job([[6, 27.5, 'A'], [4, 19.25, 'B']]);
  const auto = analyzeLengthCount(pieces, { maxLengths: 3, topN: 1 });   // default menu = full
  const gr = analyzeLengthCount(pieces, { maxLengths: 3, topN: 1, strategy: 'greedy' });
  assert.equal(JSON.stringify(auto.curve), JSON.stringify(gr.curve),
    'auto should have taken the greedy path for the full menu');
  // And it really is cheaper: the N=3 step only considers "winner + one more".
  const n3 = auto.curve.find((c) => c.n === 3);
  assert.ok(n3.feasible);
});
