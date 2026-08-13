// =============================================================
// ewp-stock.test.js — on-hand stock: reading it, and netting against it.
// Run with: npm test  (node --test)
// =============================================================
// Three things are new and therefore tested here:
//
//   1. readStockCsv — the reader, including every rule that was a real bug in
//      the XLSX original (no de-duping, skip junk rows, clamp negatives).
//   2. inventoryImpact — copied in from the web app, where it is regression-
//      locked against a database pipeline that does not travel, so it arrived
//      here with no tests at all. Its de-dupe-to-distinct-boards step is the
//      subtlety most likely to be reintroduced by a rewrite, so it gets pinned.
//   3. applyStock — the second engine pass, and the guarantee that the
//      greenfield search above it is untouched.
//
// Fixtures: stock-onhand-wide-synthetic.csv is FABRICATED — real quantities do
// not go in a public repo — in the exact 9-column layout of a real export, and
// deliberately mentions no TJI, which is the stub-merge landmine under test
// rather than a gap in the data.
// =============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { parseStockCsv, looksLikeStockCsv } = require('../src/ewp/readStockCsv.js');
const { inventoryImpact } = require('../src/ewp/inventoryImpact.js');
const { applyStock, netBuyList, byDelivery, coverageOf } = require('../src/ewp/applyStock.js');
const { analyzeBatch } = require('../src/ewp/selectStockLengths.js');
const { parseJobCsv } = require('../src/ewp/parseCsv.js');
const { DEFAULT_PURCHASE_LENGTHS_BY_CAT } = require('../src/ewp/optimizeCuts.js');

const FIX = path.join(__dirname, 'ewp-fixtures');
const read = (f) => fs.readFileSync(path.join(FIX, f), 'utf8');
const WIDE = 'stock-onhand-wide-synthetic.csv';
const NARROW = 'stock-inventory-sample-synthetic.csv';

const SUPPLIER = DEFAULT_PURCHASE_LENGTHS_BY_CAT['I-Joist'];

// ---- the reader ------------------------------------------------------------

test('the wide export shape loads, taking quantity from `available`', () => {
  const r = parseStockCsv(read(WIDE));

  assert.equal(r.qtyColumn, 'available');
  assert.equal(r.rowCount, 10);

  // available = on_hand - committed. The 34' line has 10 on hand and 2
  // committed: planning against on_hand would hand two boards to two jobs.
  const l34 = r.items.find((i) => i.item === '11 7/8" PJI-40' && i.span === 34);
  assert.equal(l34.qty, 8);
});

test('item strings survive the quoting that breaks split(",")', () => {
  const r = parseStockCsv(read(WIDE));
  const items = new Set(r.items.map((i) => i.item));
  assert.ok(items.has('11 7/8" PJI-40'));
  assert.ok(items.has('1 1/8" x 11 7/8" APA Rim Board'));
});

test('a negative available clamps to 0 rather than corrupting the baseline', () => {
  const r = parseStockCsv(read(WIDE));
  const over = r.items.find((i) => i.item === '11 7/8" PJI-40' && i.span === 48);
  assert.equal(over.qty, 0);                       // file says -2 (over-committed)
  assert.match(r.warnings.join(' '), /negative/);
});

test('subtotal and spacer rows are skipped, not parsed as stock', () => {
  const r = parseStockCsv(read(WIDE));
  assert.ok(!r.items.some((i) => /total/i.test(i.item)));
  assert.equal(r.skipped.length, 1);               // the "Total on hand" row
  assert.match(r.skipped[0].reason, /span/);
});

test('a blank threshold is absent, not zero', () => {
  const r = parseStockCsv(read(WIDE));
  const lvl22 = r.items.find((i) => i.span === 22);
  assert.equal('threshold' in lvl22, false);
  const rim = r.items.find((i) => i.span === 12);
  assert.equal(rim.threshold, 12);
});

test('the narrow item,span,qty,threshold shape still loads', () => {
  const r = parseStockCsv(read(NARROW));
  assert.equal(r.qtyColumn, 'qty');
  assert.equal(r.rowCount, 11);
  assert.equal(r.items[0].item, '11 7/8" PJI-40');
  assert.equal(r.items[0].qty, 12);
  // A known item with none on hand is a REAL row: it says "we stock this and
  // have none", which is not the same as saying nothing at all.
  assert.ok(r.items.some((i) => i.qty === 0));
});

test('duplicate (item, span) rows are BOTH emitted — de-duping was an undercount bug', () => {
  const r = parseStockCsv([
    'item,span,qty',
    '"11 7/8"" PJI-40",48,5',
    '"11 7/8"" PJI-40",48,7',
  ].join('\n'));
  assert.equal(r.items.length, 2);
  assert.deepEqual(r.items.map((i) => i.qty), [5, 7]);

  // …and the consumer sums them, so the pair reads as 12 on hand.
  const impact = inventoryImpact(r.items, [
    { stockPieceNumber: 1, size: '11 7/8" PJI-40', stockLength: 48, cutFrom: 'on-hand', category: 'I-Joist' },
  ]);
  assert.equal(impact.depletion[0].startQty, 12);
});

test('a file with no recognizable header is rejected by name, not silently empty', () => {
  assert.throws(() => parseStockCsv('a,b,c\n1,2,3\n'), /item.*span|span.*item/i);
  assert.throws(() => parseStockCsv('item,span\n"x",48\n'), /quantity column/i);
});

test('stock and job CSVs are told apart by their header', () => {
  assert.equal(looksLikeStockCsv(read(WIDE)), true);
  assert.equal(looksLikeStockCsv(read(NARROW)), true);
  assert.equal(looksLikeStockCsv(read('33844J-materials.csv')), false);
  assert.equal(looksLikeStockCsv(''), false);
});

// ---- inventoryImpact -------------------------------------------------------
// Copied in from the web app, regression-locked only over there. These are the
// tests the brief asks for.

const inv = (item, span, qty, threshold) => {
  const i = { source: 'inventory', item, span, qty };
  if (threshold != null) i.threshold = threshold;
  return i;
};
const board = (n, size, stockLength, cutFrom, category = 'I-Joist') =>
  ({ stockPieceNumber: n, size, stockLength, cutFrom, category });

test('one board carrying several cuts removes ONE piece from stock', () => {
  // Three committed rows, all off stock piece #1 — that is one board, not three.
  const rows = [
    board(1, '11 7/8" PJI-40', 48, 'on-hand'),
    board(1, '11 7/8" PJI-40', 48, 'on-hand'),
    board(1, '11 7/8" PJI-40', 48, 'on-hand'),
  ];
  const { depletion } = inventoryImpact([inv('11 7/8" PJI-40', 48, 10)], rows);
  assert.equal(depletion.length, 1);
  assert.equal(depletion[0].used, 1);
  assert.equal(depletion[0].remaining, 9);
});

test('purchases are counted per board too, not per cut', () => {
  const rows = [
    board(1, '11 7/8" PJI-40', 36, 'purchase'),
    board(1, '11 7/8" PJI-40', 36, 'purchase'),
    board(2, '11 7/8" PJI-40', 36, 'purchase'),
  ];
  const { purchases } = inventoryImpact([], rows);
  assert.deepEqual(purchases, [
    { category: 'I-Joist', size: '11 7/8" PJI-40', stockLength: 36, qty: 2 },
  ]);
});

test('threshold breach is measured on what is LEFT after the batch', () => {
  const stock = [inv('11 7/8" PJI-40', 48, 10, 8)];
  const rows = [board(1, '11 7/8" PJI-40', 48, 'on-hand')];
  const one = inventoryImpact(stock, rows).depletion[0];
  assert.equal(one.remaining, 9);
  assert.equal(one.belowThreshold, false);          // 9 >= 8, still fine today

  const many = inventoryImpact(stock,
    [1, 2, 3].map((n) => board(n, '11 7/8" PJI-40', 48, 'on-hand'))).depletion[0];
  assert.equal(many.remaining, 7);
  assert.equal(many.belowThreshold, true);          // 7 < 8 once these jobs ship
});

test('attribution uses normalizeSize, so DF/2.1 noise still matches', () => {
  const stock = [inv('2.1 RigidLam LVL 1-3/4 x 11-7/8', 48, 4)];
  const rows = [board(1, '2.1 RigidLam DF LVL 1-3/4 x 11-7/8', 48, 'on-hand', 'LVL')];
  const d = inventoryImpact(stock, rows).depletion[0];
  assert.equal(d.startQty, 4);
  assert.equal(d.used, 1);
});

// ---- netting ---------------------------------------------------------------

test('netBuyList pairs the two plans and keeps rows only one of them has', () => {
  const rows = netBuyList(
    [{ category: 'I-Joist', size: 'A', stockLength: 36, qty: 10 }],
    [{ category: 'I-Joist', size: 'A', stockLength: 36, qty: 4 },
     { category: 'I-Joist', size: 'A', stockLength: 32, qty: 1 }]
  );
  assert.deepEqual(rows.map((r) => [r.stockLength, r.need, r.covered, r.buy]), [
    [36, 10, 6, 4],
    // Leftover pieces can repack onto a length the greenfield plan never opened.
    // That shows as a negative "covered" rather than being hidden.
    [32, 0, -1, 1],
  ]);
});

test('jobs are ordered by delivery date, so the soonest ship claims scarce boards', () => {
  const h = (jobNumber, deliveryDate) => ({ kind: 'header', jobNumber, deliveryDate });
  const ordered = byDelivery([
    h('C', '7/19/2026'), h('A', '6/22/2026'), h('B', '7/1/2026'), h('D', 'Unknown'),
  ]);
  assert.deepEqual(ordered.map((x) => x.jobNumber), ['A', 'B', 'C', 'D']);
});

test('coverage separates "none on hand" from "the file never mentions it"', () => {
  const cut = parseJobCsv(read('33591J-materials.csv'));
  const stock = parseStockCsv(read(WIDE)).items;
  const cov = coverageOf(cut, stock);

  const tji = cov.find((c) => /TJI/.test(c.size));
  assert.equal(tji.inStockFile, false);

  const rim = cov.find((c) => c.category === 'RimBoard');
  assert.equal(rim.inStockFile, true);
  assert.equal(rim.available, 18);
});

// ---- the second pass -------------------------------------------------------

test('no stock file means no stock view at all', () => {
  const cut = parseJobCsv(read('33844J-materials.csv'));
  assert.equal(applyStock(cut, { products: [], purchaseList: [] }, [], {}), null);
  assert.equal(applyStock(cut, { products: [], purchaseList: [] }, null, {}), null);
});

test('33844J: stock covers part of the order and the rest still gets bought', () => {
  const cut = parseJobCsv(read('33844J-materials.csv'));
  const stock = parseStockCsv(read(WIDE)).items;
  const plan = analyzeBatch(cut, { maxLengths: 2, menu: SUPPLIER, topN: 1 });
  const s = applyStock(cut, plan, stock, {});

  // The search itself is untouched by stock — same recommendation either way.
  assert.deepEqual(plan.products[0].best.lengths,
    analyzeBatch(cut, { maxLengths: 2, menu: SUPPLIER, topN: 1 }).products[0].best.lengths);

  assert.ok(s.totals.boardsFromStock > 0, 'nothing was drawn from the yard');
  assert.ok(s.totals.asPlanned.boardsPurchased < s.totals.greenfield.boardsPurchased);
  assert.ok(s.totals.asPlanned.feetPurchased < s.totals.greenfield.feetPurchased);

  // Every rim board is on hand (18 available, 18 needed), so none is bought.
  const rim = s.buyList.find((r) => r.category === 'RimBoard');
  assert.equal(rim.buy, 0);
  assert.equal(rim.covered, rim.need);

  // …and that empties the line, which is below its reorder point of 12.
  const rimStock = s.depletion.find((d) => /Rim Board/.test(d.item));
  assert.equal(rimStock.remaining, 0);
  assert.equal(rimStock.belowThreshold, true);

  // Boards drawn from stock are tagged for the cut sheet, which is what makes
  // cutList.js badge them on-hand.
  const boards = s.cutPlan.flatMap((j) => j.groups.flatMap((g) => g.boards));
  assert.ok(boards.some((b) => b.cutFrom === 'on-hand'));
  assert.ok(boards.some((b) => b.cutFrom === 'purchase'));
});

test('depletion never draws more of a line than the yard holds', () => {
  const cut = parseJobCsv(read('33844J-materials.csv'));
  const stock = parseStockCsv(read(WIDE)).items;
  const plan = analyzeBatch(cut, { maxLengths: 2, menu: SUPPLIER, topN: 1 });
  const s = applyStock(cut, plan, stock, {});
  for (const d of s.depletion) {
    assert.ok(d.used <= d.startQty, `${d.item} @ ${d.stockLength}: used ${d.used} of ${d.startQty}`);
    assert.ok(d.remaining >= 0);
  }
});

test('a product the stock file never mentions still plans, as a full purchase', () => {
  // 33591J needs TJI® 210 and TJI® 560; the stock file mentions neither. The
  // zero-qty stubs must still be merged in, or the engine's no_inventory_match
  // pre-flight fires for those sizes.
  const cut = parseJobCsv(read('33591J-materials.csv'));
  const stock = parseStockCsv(read(WIDE)).items;
  const plan = analyzeBatch(cut, { maxLengths: 1, menu: [48, 36], topN: 1 });
  const s = applyStock(cut, plan, stock, {});

  const tji = s.buyList.filter((r) => /TJI/.test(r.size));
  assert.ok(tji.length > 0, 'no TJI in the buy list at all');
  for (const r of tji) {
    assert.equal(r.covered, 0);
    assert.equal(r.buy, r.need);
  }
  assert.ok(!s.depletion.some((d) => /TJI/.test(d.item)));
});

test('the answer does not depend on the order the files were dropped', () => {
  const a = parseJobCsv(read('34120J-materials.csv'));
  const b = parseJobCsv(read('34182J-materials.csv'));
  const stock = parseStockCsv(read(WIDE)).items;
  const opts = { maxLengths: 1, menu: [40, 36], topN: 1 };

  const forward = applyStock([...a, ...b], analyzeBatch([...a, ...b], opts), stock, {});
  const reverse = applyStock([...b, ...a], analyzeBatch([...b, ...a], opts), stock, {});

  assert.deepEqual(reverse.buyList, forward.buyList);
  assert.deepEqual(reverse.depletion, forward.depletion);
});
