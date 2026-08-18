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

