// =============================================================
// ewp-cutlist.test.js — the shared cut-list grouping model.
// Run with: npm test  (node --test)
// =============================================================
// `boardSig` and the rows→boards grouping used to exist twice, byte-identical,
// in public/optimize.html and src/ewp/pdfDocs.js — and were about to be copied a
// third time for the standalone planner. They now live in one module used by all
// three surfaces, plus the browser renderer in public/cutList.js.
//
// These tests lock the collapse rule, because getting it wrong is quiet and
// expensive: a buyer would be told to cut a board that isn't in the plan.
// =============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const M = require('../src/ewp/cutListModel.js');

const board = (o = {}) => ({
  size: '11 7/8" PJI-40', category: 'I-Joist', cutFrom: 'purchase', stockLength: 36,
  cuts: [{ cutLabel: 'J18', requiredLength: 18 }, { cutLabel: 'J18', requiredLength: 18 }],
  ...o,
});

// ---- the collapse rule -----------------------------------------------------

test('boards differing only in CUT ORDER are the same board', () => {
  // A multiset compare, not a sequence compare: J18+J14 and J14+J18 are one
  // board to the buyer and to the saw.
  const a = board({ cuts: [{ cutLabel: 'J18', requiredLength: 18 }, { cutLabel: 'J14', requiredLength: 14 }] });
  const b = board({ cuts: [{ cutLabel: 'J14', requiredLength: 14 }, { cutLabel: 'J18', requiredLength: 18 }] });
  assert.equal(M.boardSig(a), M.boardSig(b));
  assert.deepEqual(M.collapse([a, b]).map((g) => g.count), [2]);
});

test('boards differing in length, source, size or cut multiset are NOT collapsed', () => {
  const base = board();
  for (const diff of [
    { stockLength: 32 },
    { cutFrom: 'on-hand' },
    { size: '14" PJI-40' },
    { category: 'LVL' },
    { cuts: [{ cutLabel: 'J18', requiredLength: 18 }] },
    { cuts: [{ cutLabel: 'J18', requiredLength: 18 }, { cutLabel: 'J18', requiredLength: 17 }] },
  ]) {
    assert.notEqual(M.boardSig(base), M.boardSig(board(diff)),
      `should differ: ${JSON.stringify(diff)}`);
  }
});

test('collapse preserves total board count and first-seen order', () => {
  const groups = M.collapse([board(), board({ stockLength: 32 }), board(), board()]);
  assert.deepEqual(groups.map((g) => g.count), [3, 1]);
  assert.equal(groups.reduce((s, g) => s + g.count, 0), 4);
  assert.equal(groups[0].board.stockLength, 36, 'first-seen board leads its group');
});

// ---- rows -> boards --------------------------------------------------------

test('boardsFromRows groups committed rows by stockPieceNumber', () => {
  const rows = [
    { stockPieceNumber: 1, stockLength: 36, cutFrom: 'purchase', size: 'S', category: 'I-Joist', cutLabel: 'A', requiredLength: 18 },
    { stockPieceNumber: 1, stockLength: 36, cutFrom: 'purchase', size: 'S', category: 'I-Joist', cutLabel: 'B', requiredLength: 18 },
    { stockPieceNumber: 2, stockLength: 36, cutFrom: 'purchase', size: 'S', category: 'I-Joist', cutLabel: 'C', requiredLength: 36 },
  ];
  const boards = M.boardsFromRows(rows);
  assert.equal(boards.length, 2);
  assert.deepEqual(boards[0].cuts.map((c) => c.cutLabel), ['A', 'B']);
});

test('the two surfaces keep their DIFFERENT fallback for unnumbered rows', () => {
  // This is a real pre-existing divergence, preserved deliberately: the browser
  // cut list merges unnumbered rows for one product into a single board; the PDF
  // builder keeps them separate. Changing either is a product decision, not a
  // refactor, so the flag makes the choice explicit.
  const rows = [
    { stockPieceNumber: '', stockLength: 12, cutFrom: 'purchase', size: 'S', category: 'RimBoard', cutLabel: 'R', requiredLength: 12 },
    { stockPieceNumber: '', stockLength: 12, cutFrom: 'purchase', size: 'S', category: 'RimBoard', cutLabel: 'R', requiredLength: 12 },
  ];
  assert.equal(M.boardsFromRows(rows, false).length, 1, 'browser: merged');
  assert.equal(M.boardsFromRows(rows, true).length, 2, 'PDF: separate');
});

// ---- sections --------------------------------------------------------------

test('sectionsOf orders I-Joists, LVL, Rim Board, then anything else', () => {
  const secs = M.sectionsOf([
    board({ category: 'RimBoard', size: 'Rim' }),
    board({ category: 'Mystery', size: 'X' }),
    board({ category: 'LVL', size: 'RigidLam' }),
    board({ category: 'I-Joist' }),
  ]);
  assert.deepEqual(secs.map((s) => s.label), ['I-Joists', 'LVL', 'Rim Board', 'Other']);
  assert.ok(secs.every((s) => s.total === 1));
});

test('cutSection recognizes the product names that actually appear in the CSVs', () => {
  assert.equal(M.cutSection('11 7/8" PJI-40'), 'ijoist');
  assert.equal(M.cutSection('2.1 RigidLam DF LVL 1-3/4 x 9-1/2'), 'lvl');
  assert.equal(M.cutSection('1 1/8" x 11 7/8" APA Rim Board'), 'rim');
  assert.equal(M.cutSection(''), 'other');
});

// ---- the browser renderer (loaded the way a page loads it) -----------------

function browser(lvlThreshold = 8) {
  const sb = { console };
  sb.self = sb; sb.window = sb;
  vm.createContext(sb);
  const root = path.join(__dirname, '..');
  vm.runInContext(fs.readFileSync(path.join(root, 'src', 'ewp', 'cutListModel.js'), 'utf8'), sb);
  vm.runInContext(fs.readFileSync(path.join(root, 'public', 'cutList.js'), 'utf8'), sb);
  sb.CutList.configure({ lvlThreshold });
  return sb;
}

test('cutList.js loads in a browser-like global and exposes renderBoard globally', () => {
  const sb = browser();
  // optimize-editor.js calls renderBoard() as a bare global — that must survive.
  assert.equal(typeof sb.renderBoard, 'function');
  assert.equal(typeof sb.CutList.renderJob, 'function');
});

test('an LVL remainder at/above the threshold renders as return-to-stock, not waste', () => {
  const sb = browser(8);
  const lvl = { size: 'RigidLam', category: 'LVL', cutFrom: 'purchase', stockLength: 48,
                cuts: [{ cutLabel: 'BM', requiredLength: 30 }] };            // 18 ft left
  assert.match(sb.renderBoard(lvl, 1), /returnstock/);
  assert.doesNotMatch(sb.renderBoard(lvl, 1), /class="seg waste"/);

  // Same board, higher threshold -> the very same 18 ft is now waste.
  const strict = browser(20);
  assert.match(strict.renderBoard(lvl, 1), /class="seg waste"/);

  // I-Joist remainders are ALWAYS waste, however long.
  const ij = { size: 'PJI', category: 'I-Joist', cutFrom: 'purchase', stockLength: 48,
               cuts: [{ cutLabel: 'J', requiredLength: 10 }] };
  assert.match(sb.renderBoard(ij, 1), /class="seg waste"/);
});

test('the ×N badge shows the collapsed count, and ×1 is still shown', () => {
  const sb = browser();
  assert.match(sb.renderBoard(board(), 20), /class="qty">×20</);
  assert.match(sb.renderBoard(board(), 1), /class="qty">×1</);
});

// ---- end to end against the bug-report job ---------------------------------

test('33844J: 69 boards collapse to a handful of diagrams, all pieces preserved', () => {
  const { parseJobCsv } = require('../src/ewp/parseCsv.js');
  const { selectStockLengths } = require('../src/ewp/selectStockLengths.js');
  const { DEFAULT_PURCHASE_LENGTHS_BY_CAT } = require('../src/ewp/optimizeCuts.js');

  const cuts = parseJobCsv(
    fs.readFileSync(path.join(__dirname, 'ewp-fixtures', '33844J-materials.csv'), 'utf8'));
  const r = selectStockLengths(cuts, {
    maxLengths: 2, menu: DEFAULT_PURCHASE_LENGTHS_BY_CAT['I-Joist'], topN: 1,
  });

  const boards = r.cutPlan[0].groups.flatMap((g) => g.boards.map((bd) => ({
    size: g.size, category: g.category, cutFrom: bd.cutFrom, stockLength: bd.stockLength,
    cuts: bd.cuts.map((c) => ({ cutLabel: c.label, requiredLength: c.length })),
  })));
  assert.equal(boards.length, 69, '43 I-Joist + 8 LVL + 18 Rim');

  const secs = M.sectionsOf(boards);
  const diagrams = secs.reduce((s, x) => s + x.groups.length, 0);
  assert.ok(diagrams < 15, `expected a readable page, got ${diagrams} diagrams`);
  // Collapsing must never lose or invent a board.
  assert.equal(secs.reduce((s, x) => s + x.total, 0), 69);

  // The 20 identical "36' board holding one J36" boards are ONE row, ×20.
  const ij = secs.find((s) => s.key === 'ijoist');
  const j36 = ij.groups.find((g) => g.board.stockLength === 36 &&
    g.board.cuts.length === 1 && g.board.cuts[0].cutLabel === 'J36');
  assert.ok(j36, 'expected a single-J36-per-36ft-board group');
  assert.equal(j36.count, 20);
});
