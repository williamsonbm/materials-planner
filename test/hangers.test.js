// =============================================================
// test/hangers.test.js — Unit test suite for Hanger parser & planner.
// Run with: node --test test/hangers.test.js
// =============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseHangerSheet } = require('../src/hangers/parseHangerSheet.js');
const { parseHangerStockCsv, looksLikeHangerStockCsv, skuKey } = require('../src/hangers/readHangerStockCsv.js');
const { planHangers } = require('../src/hangers/planHangers.js');

const SAMPLE_JOB_ROOF = `Invoice,Sample Truss Co,P.O. Box 0000,Anytown VA 00000 ,Business: (555) 555-0100,,,
Quote Date:,4/20/2026,Job Number:,10001R,,,,
Order Date:,4/21/2026,Product:,Roof,,,,
Delivery Date:,5/21/2026,,,,,,
Job Name:,Sample Customer,Delivery Area,,,,,
LUMBER SUMMARY,,,,,,,
SKU,Qty,LENGTH,MATERIAL NAME,USAGE,SQ. FEET,LINEAL FEET,BOARD FOOT
,7,8-00-00,2x4 SP 2400F 2.0E,Regular,,56,37.31
Hangers,,,,,,,
QTY,TYPE,SIZE,LENGTH,,NOTE,,
9,Hanger,HUS26,,,,,
10,Hanger,LU24,,,,,
6,Hanger,NAILED,,,,,
`;

const SAMPLE_JOB_EWP = `Material Summary,Sample Truss Co,P.O. Box 0000,Anytown VA 00000
Quote Date:,4/16/2026,Job Number:,10002J,
Order Date:,5/20/2026,Product:,EWP,
Delivery Date:,6/24/2026,,,
Job Name:,Lot 00 Sample,Delivery Area,,
I-Shape EWP,,,,
LABEL,SIZE,QTY,LENGTH,
J48,"11 7/8"" PJI-40",11,48-00-00,
Hangers,,,,
QTY,TYPE,SIZE,LENGTH,
8,Hanger,ITS2.56/11.88,,
`;

const SAMPLE_JOB_PLY = `Quote Date:,4/20/2026,Job Number:,10003R,
Order Date:,4/21/2026,Job Name:,Ply Test,Delivery Date:,5/21/2026,
Hangers,,,,
QTY,TYPE,SIZE,LENGTH,
5,Hanger,Two H2.5A,,
4,Hanger,Three H1A,,
`;

const SAMPLE_STOCK_CSV = `sku,on_hand,committed,available,incoming,threshold,flag,last_counted
HUS26,20,5,15,0,0,OK,
LU24,4,0,4,10,0,OK,
ITS2.56/11.88,0,0,0,5,0,OK,
H2.5A,50,60,-10,0,0,OK,
`;

test('parseHangerSheet parses metadata and line items from a Roof truss job', () => {
  const res = parseHangerSheet(SAMPLE_JOB_ROOF);
  assert.equal(res.ok, true);
  assert.equal(res.meta.job_number, '10001R');
  assert.equal(res.meta.job_name, 'Sample Customer');
  assert.equal(res.meta.delivery_date, '2026-05-21');
  assert.equal(res.lines.length, 2); // NAILED skipped
  assert.equal(res.lines[0].sku, 'HUS26');
  assert.equal(res.lines[0].qty, 9);
  assert.equal(res.lines[1].sku, 'LU24');
  assert.equal(res.lines[1].qty, 10);
});

test('parseHangerSheet parses an EWP job with hangers', () => {
  const res = parseHangerSheet(SAMPLE_JOB_EWP);
  assert.equal(res.ok, true);
  assert.equal(res.meta.job_number, '10002J');
  assert.equal(res.lines.length, 1);
  assert.equal(res.lines[0].sku, 'ITS2.56/11.88');
  assert.equal(res.lines[0].qty, 8);
});

test('parseHangerSheet multiplies spelled-out ply words correctly', () => {
  const res = parseHangerSheet(SAMPLE_JOB_PLY);
  assert.equal(res.ok, true);
  assert.equal(res.lines.length, 2);
  assert.equal(res.lines[0].sku, 'H2.5A');
  assert.equal(res.lines[0].qty, 10); // 5 * 2
  assert.equal(res.lines[1].sku, 'H1A');
  assert.equal(res.lines[1].qty, 12); // 4 * 3
});

test('parseHangerSheet rejects batch reports without job number', () => {
  const text = 'Hangers Needed For,4/1/2026,to,4/30/2026\nQTY,TYPE,SIZE\n10,Hanger,LU24';
  const res = parseHangerSheet(text);
  assert.equal(res.ok, false);
  assert.match(res.reason, /batch report/i);
});

test('looksLikeHangerStockCsv identifies hanger stock files', () => {
  assert.equal(looksLikeHangerStockCsv(SAMPLE_STOCK_CSV), true);
  assert.equal(looksLikeHangerStockCsv('item,span,qty\nPJI,48,10'), false);
});

test('parseHangerStockCsv parses columns and calculates available stock', () => {
  const parsed = parseHangerStockCsv(SAMPLE_STOCK_CSV);
  assert.equal(parsed.rows.length, 4);

  const hus = parsed.byKey.get('HUS26');
  assert.ok(hus);
  assert.equal(hus.onHand, 20);
  assert.equal(hus.committed, 5);
  assert.equal(hus.available, 15);
  assert.equal(hus.availableRaw, 15);

  const lu = parsed.byKey.get('LU24');
  assert.ok(lu);
  assert.equal(lu.incoming, 10);

  const h25 = parsed.byKey.get('H2.5A');
  assert.ok(h25);
  assert.equal(h25.availableRaw, -10);
  assert.equal(h25.available, 0);
});

test('planHangers nets demand against stock and surfaces buy quantities and incoming', () => {
  const stock = parseHangerStockCsv(SAMPLE_STOCK_CSV);
  const files = [
    { name: '10001R.csv', text: SAMPLE_JOB_ROOF },
    { name: '10002J.csv', text: SAMPLE_JOB_EWP },
    { name: '10003R.csv', text: SAMPLE_JOB_PLY },
  ];

  const plan = planHangers(files, stock);

  assert.equal(plan.jobs.length, 3);
  assert.equal(plan.summary.skusNeeded, 5);

  // HUS26: demand 9, available 15 -> covered (0 buy)
  const hus = plan.covered.find((r) => r.sku === 'HUS26');
  assert.ok(hus);
  assert.equal(hus.demand, 9);
  assert.equal(hus.available, 15);
  assert.equal(hus.shortfall, 0);

  // LU24: demand 10, available 4 -> buy 6 (incoming 10 reported)
  const lu = plan.buyList.find((r) => r.sku === 'LU24');
  assert.ok(lu);
  assert.equal(lu.demand, 10);
  assert.equal(lu.available, 4);
  assert.equal(lu.buyPieces, 6);
  assert.equal(lu.incoming, 10);

  // ITS2.56/11.88: demand 8, available 0 -> buy 8 (incoming 5 reported)
  const its = plan.buyList.find((r) => r.sku === 'ITS2.56/11.88');
  assert.ok(its);
  assert.equal(its.demand, 8);
  assert.equal(its.buyPieces, 8);
  assert.equal(its.incoming, 5);

  // H2.5A: demand 10, availableRaw -10 -> buy 20 (demand 10 + 10 deficit)
  const h25 = plan.buyList.find((r) => r.sku === 'H2.5A');
  assert.ok(h25);
  assert.equal(h25.demand, 10);
  assert.equal(h25.buyPieces, 20);

  // H1A: demand 12, not in stock -> unmatched, buy 12
  const h1a = plan.buyList.find((r) => r.sku === 'H1A');
  assert.ok(h1a);
  assert.equal(h1a.isUnmatched, true);
  assert.equal(h1a.buyPieces, 12);
  assert.ok(plan.unmatched.some((r) => r.sku === 'H1A'));
});

test('planHangers works without stock file (greenfield)', () => {
  const files = [{ name: '10001R.csv', text: SAMPLE_JOB_ROOF }];
  const plan = planHangers(files, null);

  assert.equal(plan.jobs.length, 1);
  assert.equal(plan.buyList.length, 2);
  assert.equal(plan.buyList[0].sku, 'LU24');
  assert.equal(plan.buyList[0].buyPieces, 10);
  assert.equal(plan.buyList[1].sku, 'HUS26');
  assert.equal(plan.buyList[1].buyPieces, 9);
});

// ---- HTTP route integration tests -----------------------------------------

const { app } = require('../src/planner/server.js');

async function withServer(fn) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('GET /hangers serves the hanger planner page', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/hangers`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<title>Hanger purchase planner<\/title>/i);
  });
});

test('POST /api/hangers/plan plans a batch via HTTP API', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/hangers/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: [
          { name: '10001R.csv', text: SAMPLE_JOB_ROOF },
          { name: 'stock.csv', text: SAMPLE_STOCK_CSV },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.jobs.length, 1);
    assert.equal(data.rerouted.length, 1); // stock.csv auto-rerouted
    assert.equal(data.rerouted[0].to, 'stock');
    assert.ok(data.buyList.some((r) => r.sku === 'LU24' && r.buyPieces === 6));
  });
});


// =============================================================
// hangerCanon — supplier spelling → the SKU we actually stock.
// =============================================================
// The bug this prevents costs money in one direction only: a sheet calling for
// STC26 that never meets the TC26 on the shelf lands as UNMATCHED, and the
// buyer special-orders hangers the yard already has. Assertions are written
// against the fixture by hand — see the note in plates.test.js about not
// "fixing" a failure by pasting in whatever the code returned.
// =============================================================

const fs = require('node:fs');
const path = require('node:path');
const { hangerCanon, aliasOf, ALIASES } = require('../src/hangers/hangerCanon.js');

const CANON_FIXTURE = fs.readFileSync(
  path.join(__dirname, 'hanger-fixtures', 'stc-canon-synthetic.csv'), 'utf8');

// TC26 10 on hand vs 15 demanded; TC24 and H1AZ empty; H2AZ deliberately deep
// enough to cover its demand, so a covered-side fold is exercised too.
const CANON_STOCK_CSV = [
  'sku,on_hand,committed,available,incoming,threshold',
  'TC26,10,0,10,0,2',
  'TC24,0,0,0,0,1',
  'H2AZ,20,0,20,0,2',
  'H1AZ,0,0,0,0,1',
  'HUS26,4,0,4,0,1',
  '',
].join('\n');

test('hangerCanon folds the supplier spellings and leaves everything else alone', () => {
  assert.equal(hangerCanon('STC26'), 'TC26');
  assert.equal(hangerCanon('STC24'), 'TC24');
  assert.equal(hangerCanon('H2A2'), 'H2AZ');
  assert.equal(hangerCanon('H1A2'), 'H1AZ');

  // Already canonical — must pass through untouched, and report no alias.
  assert.equal(hangerCanon('TC26'), 'TC26');
  assert.equal(aliasOf('TC26'), null);

  // Unknown SKUs are returned EXACTLY as given. This is a closed table, not a
  // guesser: rewriting an unlisted SKU would invent demand against the wrong row.
  for (const sku of ['HUS26', 'ITS2.56/14', 'IUS2.56/11.88', 'HGUS412', 'THA422', 'LU24', 'TBE4']) {
    assert.equal(hangerCanon(sku), sku);
    assert.equal(aliasOf(sku), null);
  }
  assert.equal(hangerCanon(''), '');
  assert.equal(hangerCanon(null), '');
});

test('the alias comparison tolerates spacing and punctuation variants', () => {
  // canonNorm strips [\s./\\"-] for the alias lookup ONLY, matching public.norm()
  // in the inventory app, so a sheet written "STC 26" still finds TC26.
  for (const variant of ['STC 26', 'stc26', 'stc.26', 'S-TC26', ' STC26 ']) {
    assert.equal(hangerCanon(variant), 'TC26', `${JSON.stringify(variant)} must fold to TC26`);
  }
});

test('the loose alias match does NOT leak into skuKey for ordinary SKUs', () => {
  // skuKey stays strict on purpose: punctuation distinguishes real product
  // numbers. If these ever collapse, unrelated hangers start sharing a stock row.
  assert.notEqual(skuKey('ITS2.56/14'), skuKey('ITS2.56/11.88'));
  assert.notEqual(skuKey('HGUS210-2'), skuKey('HGUS2102'));
  assert.equal(skuKey('H2.5A'), 'H2.5A');
});

test('skuKey folds aliases so demand and stock meet on one key', () => {
  assert.equal(skuKey('STC26'), skuKey('TC26'));
  assert.equal(skuKey('STC 26'), skuKey('TC26'));
  assert.equal(skuKey('STC24'), skuKey('TC24'));
  assert.equal(skuKey('H2A2'), skuKey('H2AZ'));
  assert.equal(skuKey('HUS26'), 'HUS26');
});

test('every ALIASES target is itself canonical (no two-hop folds)', () => {
  // A target that is also a source would need a second pass to settle, and
  // hangerCanon deliberately makes only one. Fail loudly rather than silently
  // resolving half way.
  for (const { canon } of ALIASES.values()) {
    assert.equal(hangerCanon(canon), canon, `${canon} must be a fixed point`);
  }
});

test('STC26 demand is met from TC26 on hand instead of special-ordered', () => {
  const stock = parseHangerStockCsv(CANON_STOCK_CSV);
  const r = planHangers([{ name: 'canon.csv', text: CANON_FIXTURE }], stock);
  const find = (sku) => [...r.buyList, ...r.covered].find((x) => x.sku === sku);

  // STC26 (6) + "STC 26" (4) + TC26 (5) all land on ONE row: 15 against 10 on
  // hand, so 5 to buy. Before the fold this was 15 unmatched pieces of demand
  // sitting beside 10 unused TC26.
  const tc26 = find('TC26');
  assert.ok(tc26, 'the row must be named TC26 — that is what gets ordered');
  assert.equal(tc26.demand, 15);
  assert.equal(tc26.shortfall, 5);
  assert.equal(tc26.isUnmatched, false, 'TC26 is in the stock file; nothing here is special-order');
  assert.equal(find('STC26'), undefined, 'the supplier spelling must not survive as its own row');

  assert.equal(find('TC24').demand, 3);
  assert.equal(find('H2AZ').demand, 7);
  assert.equal(find('H2AZ').shortfall, 0, '20 on hand covers 7');
  assert.equal(find('H1AZ').demand, 2);
  assert.equal(find('HUS26').demand, 9, 'a non-aliased SKU is untouched');

  assert.deepEqual(r.unmatched, [], 'every SKU in this fixture resolves');
});

test('the fold is reported, never silent, once per spelling per batch', () => {
  const stock = parseHangerStockCsv(CANON_STOCK_CSV);
  const r = planHangers([{ name: 'canon.csv', text: CANON_FIXTURE }], stock);

  const substitutions = r.warnings.filter((w) => /confirm the substitution/.test(w));
  assert.equal(substitutions.length, 3, 'STC26, "STC 26" and STC24 — one line each');
  assert.ok(substitutions.some((w) => /STC26 ×6 → TC26/.test(w)));
  assert.ok(substitutions.some((w) => /STC24 ×3 → TC24/.test(w)));

  // A Z→2 typo is the SAME part keyed wrong — it must NOT read as a
  // manufacturer substitution, or a buyer goes looking for a Simpson "H2A2".
  const spellings = r.warnings.filter((w) => /misspelling/.test(w));
  assert.equal(spellings.length, 2);
  assert.ok(spellings.some((w) => /H2A2 ×7 → H2AZ/.test(w)));
  assert.ok(!spellings.some((w) => /in lieu of/.test(w)));

  // A sheet already written our way produces no noise at all.
  assert.ok(!r.warnings.some((w) => /TC26 ×5/.test(w)));
});

test('the as-written spelling survives on the job row for the drill-down', () => {
  const stock = parseHangerStockCsv(CANON_STOCK_CSV);
  const r = planHangers([{ name: 'canon.csv', text: CANON_FIXTURE }], stock);
  const tc26 = [...r.buyList, ...r.covered].find((x) => x.sku === 'TC26');

  // Renaming a buyer's SKU with no trace back to the sheet reads as a parser
  // bug. sourceSku is set ONLY where the spellings differ, so the UI can show
  // an origin chip without annotating every row.
  assert.deepEqual(tc26.jobs.map((j) => j.sourceSku), ['STC26', 'STC 26', null]);
  assert.deepEqual(tc26.jobs.map((j) => j.qty), [6, 4, 5]);
});

test('a stock file written in Simpson spelling still sniffs as hangers', () => {
  // \b will not match TC24 inside STC24, so the sniffer needs STC* explicitly.
  assert.equal(looksLikeHangerStockCsv('sku,available\nSTC26,10\nSTC24,4\n'), true);
});
