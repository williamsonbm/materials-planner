// =============================================================
// plates.test.js — the plate purchase planner, end to end.
// =============================================================
// Runs against the REAL (scrubbed) MiTek material summaries in
// test/plate-fixtures/ plus one synthetic stock file built to exercise the
// cases that matter: covered, short, zero, NEGATIVE on-hand, absent-from-stock,
// and a SKU with incoming on a PO.
//
// Every expected number below is hand-computable from the fixture and the pack
// factors — deliberately, so a failure means the code changed rather than that
// someone pasted in whatever the code happened to return. Do not "fix" a
// failing assertion by copying actual output; work out which number is right.
// =============================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { planPlates, toPurchaseUnits } = require('../src/plates/planPlates.js');
const { parsePlateStockCsv, skuKey } = require('../src/plates/readPlateStockCsv.js');

const FIX = path.join(__dirname, 'plate-fixtures');
const read = (f) => ({ name: f, text: fs.readFileSync(path.join(FIX, f), 'utf8') });

const JOB_FILES = [
  read('10001R-materials.csv'),
  read('10004F-materials-fullexport.csv'),
  read('10002J-materials.csv'),        // EWP job: zero plate lines, must not vanish
];
const STOCK = parsePlateStockCsv(read('plate-stock-synthetic.csv').text);
const row = (r, sku) => r.rows.find((x) => x.key === skuKey(sku));

// ── the SKU match key ───────────────────────────────────────────────────────

test('skuKey collapses the spacing/case/punctuation variants that really occur', () => {
  // The exports genuinely contain a DOUBLE space ("MT20  3x3"); the stock file
  // has one. If these ever stop colliding, demand silently finds no stock row
  // and every SKU reads as a full buy.
  assert.strictEqual(skuKey('MT20  3x3'), skuKey('MT20 3x3'));
  assert.strictEqual(skuKey('mt20-3x3'), skuKey('MT20 3X3'));
  assert.strictEqual(skuKey('MT20HS  7x8'), skuKey('MT20HS 7x8'));
  assert.notStrictEqual(skuKey('MT20 3x3'), skuKey('MT20 3x4'));
});

test('the M/MT prefix folds, but MT18HS and MT18AHS stay separate plates', () => {
  // The M/MT prefix is cosmetic — MiTek's own literature spells it both ways —
  // so an old job asking for "M18AHS 8x10" must find the MT18AHS 8x10 on the
  // shelf, or the planner reports a full buy for plates already owned.
  const ahs = skuKey('MT18AHS 8x10');
  for (const variant of ['M18AHS 8x10', 'm18ahs  8X10']) {
    assert.strictEqual(skuKey(variant), ahs, `${variant} must fold to MT18AHS`);
  }
  const hs = skuKey('MT18HS 8x10');
  assert.strictEqual(skuKey('M18HS 8x10'), hs, 'M18HS must fold to MT18HS');

  // ── The regression this test exists for. ──
  // MT18HS and MT18AHS are DIFFERENT PLATES (ICC-ES ESR-1988): same 18-ga HSLAS
  // Gr 60 steel, but 8 vs 6 teeth/in² and different design values throughout.
  // An earlier rule made the A optional and merged them, crediting demand for
  // one against stock of the other. They must never share a key again.
  assert.notStrictEqual(hs, ahs, 'MT18HS must NOT fold into MT18AHS');

  // M18SHS is "18S HS" — different again (Gr 80 SS). Matches neither pattern.
  assert.notStrictEqual(skuKey('M18SHS 8x10'), ahs);
  assert.notStrictEqual(skuKey('M18SHS 8x10'), hs);
  // Nothing outside the 18-gauge family is touched.
  assert.strictEqual(skuKey('MT20 3x4'), 'MT203X4');
  assert.strictEqual(skuKey('MT20HS 6x10'), 'MT20HS6X10');
});

test('an old-spelling job line finds its current-spelling stock row', () => {
  const stock = parsePlateStockCsv(
    'sku,on_hand,committed,available,incoming,threshold,flag,last_counted\n' +
    'MT18AHS 8x10,200,0,200,0,,,2026-08-11\n');
  // Rewrite a real line in a real export to the OLD spelling, so this exercises
  // the actual parser rather than a hand-built stub. "MT20  1.5x4" (two spaces,
  // as MiTek emits it) is the first plate line in this fixture.
  const original = fs.readFileSync(path.join(FIX, '10001R-materials.csv'), 'utf8');
  const text = original.replace(/MT20 {2}1\.5x4/g, 'M18AHS 8x10');
  assert.notStrictEqual(text, original, 'the fixture must actually contain the line being rewritten');
  const jobs = [{ name: 'old.csv', text }];
  const r = planPlates(jobs, stock);
  const x = r.rows.find((q) => q.key === skuKey('MT18AHS 8x10'));
  assert.ok(x, 'the old-spelling demand line must resolve to a row');
  assert.strictEqual(x.inStockFile, true, 'and must find the MT18AHS stock row');
  assert.strictEqual(x.availableEaches, 200);
});

// ── the stock reader ────────────────────────────────────────────────────────

test('stock reader prefers `available` over `on_hand`', () => {
  // MT20 3x3 is on_hand 3500 / committed 500 / available 3000. Planning against
  // on-hand would promise 500 already-committed plates to a second job.
  assert.strictEqual(STOCK.bySku.get(skuKey('MT20 3x3')).available, 3000);
  assert.strictEqual(STOCK.bySku.get(skuKey('MT20 3x3')).onHand, 3500);
});

test('the reader exposes both a raw and a 0-clamped view of a negative', () => {
  const s = STOCK.bySku.get(skuKey('MT20 3x6'));
  assert.strictEqual(s.availableRaw, -100, 'the truth - this is what planning uses');
  assert.strictEqual(s.available, 0, 'clamped convenience view; NOT used for buy quantities');
  assert.strictEqual(STOCK.negatives.length, 1);
  assert.match(STOCK.warnings.join(' '), /NEGATIVE on-hand/);
});

test('a file with no recognizable header is rejected by name, never parsed to an empty yard', () => {
  // An empty parse is indistinguishable from an empty yard, which silently
  // prices the whole batch as a purchase. It must throw instead.
  assert.throws(() => parsePlateStockCsv('Job Name:,Sample\nLABEL,QTY\nA1,4\n'),
    /Not a plate stock CSV/);
});

// ── purchase-unit conversion ────────────────────────────────────────────────

test('conversion rounds UP and reports the overshoot', () => {
  // MT20 1.5x3 is a 1,296-each box. Short 576 -> 1 box, 720 spare.
  const o = toPurchaseUnits(576, { eaches_per_unit: 1296, unit_label: 'box' });
  assert.strictEqual(o.length, 1);
  assert.deepStrictEqual(
    { unit: o[0].unit, units: o[0].units, total: o[0].totalEaches, leftover: o[0].leftover },
    { unit: 'box', units: 1, total: 1296, leftover: 720 });
});

test('a SKU with both a pack and a pallet returns BOTH, smallest overshoot first', () => {
  // MT20 3x4: 20-each pack, 22,000-each pallet — 1,100x apart. Choosing between
  // them is a supplier/price question, so the tool shows both rather than
  // recommending "1 pallet" for a 1,094-each shortfall.
  const o = toPurchaseUnits(1094, { eaches_per_unit: 20, unit_label: 'pack', pallet_eaches: 22000 });
  assert.strictEqual(o.length, 2);
  assert.strictEqual(o[0].unit, 'pack');
  assert.strictEqual(o[0].units, 55);              // ceil(1094/20)
  assert.strictEqual(o[0].leftover, 6);            // 1100 - 1094
  assert.strictEqual(o[1].unit, 'pallet');
  assert.strictEqual(o[1].units, 1);
  assert.strictEqual(o[1].leftover, 20906);        // 22000 - 1094
});

test('REGRESSION: a SKU that is both banded and boxed offers ALL of its options', () => {
  // 15 of 57 SKUs appear twice in plate_pack_factor — once as MT20-BAND, once as
  // MT20-BOX — with the same sku_display. An earlier version keyed a plain Map on
  // SKU, so the second row overwrote the first and one perfectly orderable option
  // silently disappeared. This pins all three, from the REAL pack-factor table.
  const { PACK_BY_KEY } = require('../src/plates/planPlates.js');
  const packs = PACK_BY_KEY.get(skuKey('MT20 4x4'));
  assert.strictEqual(packs.length, 2, 'MT20 4x4 exists as both MT20-BAND and MT20-BOX');

  const o = toPurchaseUnits(506, packs);
  assert.strictEqual(o.length, 3, 'band pack + band pallet + box');
  assert.deepStrictEqual(o.map((x) => [x.units, x.unit, x.leftover]), [
    [26, 'pack', 14],        // 26 x 20   = 520
    [2, 'box', 154],         //  2 x 330  = 660
    [1, 'pallet', 14894],    //  1 x 15400
  ]);
});

test('zero or negative shortfall converts to nothing', () => {
  assert.strictEqual(toPurchaseUnits(0, { eaches_per_unit: 20, unit_label: 'pack' }), null);
  assert.strictEqual(toPurchaseUnits(-5, { eaches_per_unit: 20, unit_label: 'pack' }), null);
});

// ── the plan ────────────────────────────────────────────────────────────────

test('all three jobs are listed, including the one with no plates', () => {
  const r = planPlates(JOB_FILES, STOCK);
  assert.strictEqual(r.jobs.length, 3);
  assert.strictEqual(r.rejected.length, 0);
  const ewpJob = r.jobs.find((j) => j.jobNumber === '10002J');
  assert.strictEqual(ewpJob.plateLines, 0,
    'an EWP-only job legitimately has no plates - it must still be listed, not dropped');
});

test('demand sums across jobs', () => {
  const r = planPlates(JOB_FILES, STOCK);
  assert.strictEqual(row(r, 'MT20 3x3').needEaches, 2124);
  assert.strictEqual(row(r, 'MT20 1.5x3').needEaches, 1576);
  assert.strictEqual(r.totals.jobs, 3);
  assert.strictEqual(r.totals.skusDemanded, 25);
});

test('a covered SKU is not on the buy list', () => {
  const r = planPlates(JOB_FILES, STOCK);
  const x = row(r, 'MT20 3x3');            // need 2124, available 3000
  assert.strictEqual(x.shortEaches, 0);
  assert.strictEqual(x.purchase, null);
  assert.ok(!r.toBuy.some((b) => b.key === x.key));
});

test('a short SKU gets the right buy figure in eaches AND units', () => {
  const r = planPlates(JOB_FILES, STOCK);
  const x = row(r, 'MT20 1.5x3');          // need 1576, available 1000
  assert.strictEqual(x.shortEaches, 576);
  assert.strictEqual(x.purchase[0].units, 1);
  assert.strictEqual(x.purchase[0].unit, 'box');
  assert.strictEqual(x.purchase[0].leftover, 720);
});

test('incoming is REPORTED, never netted out of the buy figure', () => {
  const r = planPlates(JOB_FILES, STOCK);
  const x = row(r, 'MT20 4x4');            // need 1006, available 500, incoming 600
  assert.strictEqual(x.incoming, 600);
  assert.strictEqual(x.shortEaches, 506,
    'shortfall is need - available; incoming must NOT reduce it silently (ADR 0005)');
  assert.strictEqual(x.purchase[0].units, 26);   // ceil(506/20)
  assert.strictEqual(x.purchase[0].leftover, 14);
});

test('a SKU absent from the stock file is treated as zero on hand and flagged', () => {
  const r = planPlates(JOB_FILES, STOCK);
  const x = row(r, 'MT20 1.5x4');          // need 930, not in the stock file
  assert.strictEqual(x.inStockFile, false);
  assert.strictEqual(x.availableEaches, 0);
  assert.strictEqual(x.shortEaches, 930);
  assert.strictEqual(x.purchase[0].units, 1);    // 936-each box
  assert.strictEqual(x.purchase[0].leftover, 6);
  assert.ok(r.unmatched.some((u) => skuKey(u.sku) === x.key));
});

test('a negative-stock SKU shows the real figure and BUYS the existing shortfall too', () => {
  // Clamping available to 0 here was a bug: it hid the ledger shortfall and
  // under-ordered. need 1022, available -100 -> buy 1122, split for the UI.
  const r = planPlates(JOB_FILES, STOCK);
  const x = row(r, 'MT20 3x6');
  assert.strictEqual(x.availableEaches, -100, 'the real, negative figure is shown');
  assert.strictEqual(x.negativeStock, true);
  assert.strictEqual(x.shortEaches, 1122, 'need - available, negatives included');
  assert.strictEqual(x.shortFromJobs, 1022);
  assert.strictEqual(x.shortFromLedger, 100);
});

test('a healthy SKU reports no ledger shortfall component', () => {
  const r = planPlates(JOB_FILES, STOCK);
  const x = row(r, 'MT20 1.5x3');          // need 1576, available 1000
  assert.strictEqual(x.negativeStock, false);
  assert.strictEqual(x.shortEaches, 576);
  assert.strictEqual(x.shortFromLedger, 0);
  assert.strictEqual(x.shortFromJobs, 576);
});

test('every job row carries what the drill-down needs', () => {
  const r = planPlates(JOB_FILES, STOCK);
  for (const j of row(r, 'MT20 3x3').byJob) {
    assert.ok(j.job, 'job number');
    assert.ok('jobName' in j, 'name');
    assert.ok(j.qty > 0, 'quantity');
    assert.ok('deliveryDate' in j, 'delivery date, for the Stock-page-style table');
  }
});

test('the buy list is ordered biggest shortfall first', () => {
  const r = planPlates(JOB_FILES, STOCK);
  for (let i = 1; i < r.toBuy.length; i++) {
    assert.ok(r.toBuy[i - 1].shortEaches >= r.toBuy[i].shortEaches);
  }
});

test('every row can be traced back to the jobs that drove it', () => {
  const r = planPlates(JOB_FILES, STOCK);
  const x = row(r, 'MT20 3x3');
  assert.ok(x.byJob.length >= 1);
  assert.strictEqual(x.byJob.reduce((s, j) => s + j.qty, 0), x.needEaches,
    'per-job quantities must sum to the aggregate, or the expansion lies');
});

// ── the safety property ─────────────────────────────────────────────────────

test('planning with no stock file at all still works (greenfield)', () => {
  const r = planPlates(JOB_FILES, null);
  assert.strictEqual(r.stockInfo, null);
  assert.strictEqual(row(r, 'MT20 3x3').shortEaches, 2124, 'everything is a buy');
  assert.strictEqual(row(r, 'MT20 3x3').inStockFile, false);
});

test('planPlates is pure - same inputs, identical output, inputs untouched', () => {
  // The whole safety argument for this tool is that it writes nothing anywhere.
  // A stable, side-effect-free result is the testable half of that claim.
  const before = JSON.stringify(JOB_FILES);
  const a = JSON.stringify(planPlates(JOB_FILES, STOCK));
  const b = JSON.stringify(planPlates(JOB_FILES, STOCK));
  assert.strictEqual(a, b);
  assert.strictEqual(JSON.stringify(JOB_FILES), before, 'inputs must not be mutated');
});

test('the plate modules require no database, no fs, no network', () => {
  // Enforces the same hard constraint planner/server.js declares. A stray
  // require('pg') here would make the tool need a DB it must never have.
  for (const f of ['planPlates.js', 'readPlateStockCsv.js', 'parsePlateSummary.js', 'parseCsv.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'plates', f), 'utf8');
    const reqs = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
    for (const r of reqs) {
      assert.ok(r.startsWith('./'), `${f} requires "${r}" - plate modules may only require siblings`);
    }
  }
});
