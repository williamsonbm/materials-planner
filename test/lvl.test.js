// =============================================================
// test/lvl.test.js — Unit test suite for the LVL linear-footage planner.
// Run with: node --test test/lvl.test.js
// =============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { planLvl } = require('../src/lvl/planLvl.js');
const { parseStockCsv } = require('../src/ewp/readStockCsv.js');

// Job A: a 2-ply 16' LVL beam (QTY=2, LENGTH=16-00-00 -> 32 LF at 11-7/8"),
// plus a single-ply run at 14". Also carries an I-Joist section, to confirm
// non-LVL categories never leak into the LVL totals.
const JOB_A = `Material Summary,Sample Truss Co,,,
Quote Date:,4/16/2026,Job Number:,20001J,
Order Date:,5/20/2026,Product:,EWP,
Delivery Date:,6/24/2026,,,
Job Name:,Lot 00 Sample A,Delivery Area,,
I-Shape EWP,,,,
LABEL,SIZE,QTY,LENGTH,
J48,"11 7/8"" PJI-40",11,48-00-00,
Rectangular EWP,,,,
LABEL,SIZE,QTY,LENGTH,
2BM2-2,2.1 RigidLam DF LVL 1-3/4 x 11-7/8,2,16-00-00,
Total: 2.1 RigidLam DF LVL 1-3/4 x 11-7/8,-2,32-00-00 - L/F,
LABEL,SIZE,QTY,LENGTH,
2BM1-3,2.1 RigidLam DF LVL 1-3/4 x 14,3,30-00-00,
Total: 2.1 RigidLam DF LVL 1-3/4 x 14,-3,90-00-00 - L/F,
`;

// Job B: more usage at 11-7/8" (to prove cross-job accumulation) plus a
// depth (9-1/2") that has no matching stock row at all.
const JOB_B = `Material Summary,Sample Truss Co,,,
Quote Date:,4/18/2026,Job Number:,20002J,
Order Date:,5/22/2026,Product:,EWP,
Delivery Date:,6/26/2026,,,
Job Name:,Lot 00 Sample B,Delivery Area,,
Rectangular EWP,,,,
LABEL,SIZE,QTY,LENGTH,
1BM1-4,2.1 RigidLam DF LVL 1-3/4 x 11-7/8,4,20-00-00,
Total: 2.1 RigidLam DF LVL 1-3/4 x 11-7/8,-4,80-00-00 - L/F,
LABEL,SIZE,QTY,LENGTH,
3BM5,2.1 RigidLam DF LVL 1-3/4 x 9-1/2,3,12-00-00,
Total: 2.1 RigidLam DF LVL 1-3/4 x 9-1/2,-3,36-00-00 - L/F,
`;

// A job with no LVL at all — every material row is I-Joist. Must be rejected,
// not silently counted as zero.
const JOB_NO_LVL = `Material Summary,Sample Truss Co,,,
Quote Date:,4/19/2026,Job Number:,20003J,
Order Date:,5/23/2026,Product:,EWP,
Delivery Date:,6/27/2026,,,
Job Name:,Lot 00 Sample C,Delivery Area,,
I-Shape EWP,,,,
LABEL,SIZE,QTY,LENGTH,
J48,"11 7/8"" PJI-40",11,48-00-00,
`;

// item,span,qty,threshold — same shape the EWP stock CSV already uses.
// Deliberately includes a non-LVL row to prove it gets filtered out.
const STOCK_CSV = `item,span,qty,threshold
2.1 RigidLam DF LVL 1-3/4 x 11-7/8,48,3,1
2.1 RigidLam DF LVL 1-3/4 x 14,48,1,0
"11 7/8"" PJI-40",48,10,2
`;

test('planLvl sums linear feet per depth within one job, ignoring non-LVL categories', () => {
  const plan = planLvl([{ name: 'a.csv', text: JOB_A }], null);
  assert.equal(plan.jobs.length, 1);
  const job = plan.jobs[0];
  assert.equal(job.jobNumber, '20001J');

  const d1178 = job.byDepth.find((d) => d.depth === '11-78');
  const d14 = job.byDepth.find((d) => d.depth === '14');
  assert.ok(d1178, 'expected an 11-7/8" row');
  assert.ok(d14, 'expected a 14" row');
  // 2-ply, 16' beam: QTY(2) x LENGTH(16) = 32 LF — the "2-ply" case from the
  // user's own example, confirming plies need no separate multiplier.
  assert.equal(d1178.lf, 32);
  assert.equal(d14.lf, 90); // 3 x 30
  assert.equal(job.totalLf, 122);

  // Raw sheet line items, in order, for the "as it appears on the material
  // sheet" drill-down — untouched by the depth aggregation above.
  assert.deepEqual(job.items, [
    { label: '2BM2-2', size: '2.1 RigidLam DF LVL 1-3/4 x 11-7/8', qty: 2, length: '16-00-00' },
    { label: '2BM1-3', size: '2.1 RigidLam DF LVL 1-3/4 x 14', qty: 3, length: '30-00-00' },
  ]);
});

test('planLvl accumulates the same depth across multiple jobs', () => {
  const plan = planLvl([
    { name: 'a.csv', text: JOB_A },
    { name: 'b.csv', text: JOB_B },
  ], null);

  assert.equal(plan.jobs.length, 2);
  const d1178 = plan.byDepth.find((d) => d.depth === '11-78');
  const d14 = plan.byDepth.find((d) => d.depth === '14');
  const d912 = plan.byDepth.find((d) => d.depth === '9-12');

  assert.equal(d1178.usedLf, 112); // 32 (job A) + 80 (job B)
  assert.equal(d14.usedLf, 90);    // job A only
  assert.equal(d912.usedLf, 36);   // job B only
  assert.equal(d1178.jobs.length, 2);
  assert.equal(d14.jobs.length, 1);

  assert.equal(plan.summary.jobsCount, 2);
  assert.equal(plan.summary.totalUsedLf, 112 + 90 + 36);
  assert.equal(plan.hasStock, false);
  assert.equal(d1178.stockLf, null);
  assert.equal(d1178.neededLf, null);
});

test('planLvl includes a job with a valid job number but no LVL rows as zero usage, not rejected', () => {
  // Same "legitimately zero" call the hangers planner makes for a job with no
  // Hangers section — a job number was found, it's just an I-Joist-only job.
  const plan = planLvl([{ name: 'c.csv', text: JOB_NO_LVL }], null);
  assert.equal(plan.jobs.length, 1);
  assert.equal(plan.rejected.length, 0);
  assert.equal(plan.jobs[0].jobNumber, '20003J');
  assert.equal(plan.jobs[0].totalLf, 0);
  assert.deepEqual(plan.jobs[0].byDepth, []);
});

test('planLvl still counts LVL usage on a job whose Product is Roof/Floor, not EWP', () => {
  // The whole point of using parseLvlSheet instead of parseJobCsv: parseJobCsv
  // would reject this file outright (Product != "EWP") and its LVL beam would
  // vanish silently. Mirrors the real scrubbed/ samples, which are all tagged
  // Roof or Floor yet carry a Rectangular EWP section.
  const JOB_ROOF_WITH_LVL = `Material Summary,Sample Truss Co,,,
Quote Date:,4/20/2026,Job Number:,20004R,
Order Date:,4/21/2026,Product:,Roof,
Delivery Date:,5/21/2026,,,
Job Name:,Lot 00 Sample D,Delivery Area,,
Rectangular EWP,,,,
LABEL,SIZE,QTY,LENGTH,
1BM1-2,2.1 RigidLam DF LVL 1-3/4 x 11-7/8,2,20-00-00,
Total: 2.1 RigidLam DF LVL 1-3/4 x 11-7/8,-2,40-00-00 - L/F,
`;
  const plan = planLvl([{ name: 'd.csv', text: JOB_ROOF_WITH_LVL }], null);
  assert.equal(plan.jobs.length, 1);
  assert.equal(plan.jobs[0].totalLf, 40);
  assert.ok(plan.warnings.some((w) => /Product is "Roof"/.test(w)));
});

test('planLvl nets usage against stock, filtering non-LVL stock rows and grouping by depth only', () => {
  const stock = parseStockCsv(STOCK_CSV);
  const plan = planLvl([
    { name: 'a.csv', text: JOB_A },
    { name: 'b.csv', text: JOB_B },
  ], stock);

  assert.equal(plan.hasStock, true);

  // 11-7/8": usage 112, stock 3 x 48 = 144 -> covered, 32 LF remaining.
  const d1178 = plan.byDepth.find((d) => d.depth === '11-78');
  assert.equal(d1178.stockLf, 144);
  assert.equal(d1178.remainingLf, 32);
  assert.equal(d1178.neededLf, 0);

  // 14": usage 90, stock 1 x 48 = 48 -> short by 42.
  const d14 = plan.byDepth.find((d) => d.depth === '14');
  assert.equal(d14.stockLf, 48);
  assert.equal(d14.remainingLf, 0);
  assert.equal(d14.neededLf, 42);

  // 9-1/2": usage 36, no matching stock row at all -> fully needed.
  const d912 = plan.byDepth.find((d) => d.depth === '9-12');
  assert.equal(d912.stockLf, 0);
  assert.equal(d912.neededLf, 36);

  // The I-Joist stock row ("PJI-40") also extracts to depth "11-78" (it's an
  // 11-7/8" product), so if the LVL-only filter didn't run first, it would
  // wrongly inflate 11-7/8" stock to 144 + (10 x 48) = 624. It doesn't:
  // d1178.stockLf above is exactly 144, proving the filter ran before grouping.
  assert.equal(plan.summary.totalNeededLf, 0 + 42 + 36);
});

test('planLvl matches MiTek\'s own printed linear-foot totals against a real fixture', () => {
  const csv = fs.readFileSync(
    path.join(__dirname, 'ewp-fixtures', '33591J-materials.csv'), 'utf8',
  );
  const plan = planLvl([{ name: '33591J-materials.csv', text: csv }], null);
  assert.equal(plan.jobs.length, 1);

  // The fixture's own "Total: ... - L/F" rows read 128-00-00 and 224-00-00 —
  // this is a direct cross-check against MiTek's own arithmetic, not just ours.
  const d1178 = plan.byDepth.find((d) => d.depth === '11-78');
  const d14 = plan.byDepth.find((d) => d.depth === '14');
  assert.equal(d1178.usedLf, 128);
  assert.equal(d14.usedLf, 224);
});

test('planLvl is pure — same inputs, identical output, inputs untouched', () => {
  const files = [{ name: 'a.csv', text: JOB_A }, { name: 'b.csv', text: JOB_B }];
  const stock = parseStockCsv(STOCK_CSV);
  const before = JSON.stringify(files);
  const a = JSON.stringify(planLvl(files, stock));
  const b = JSON.stringify(planLvl(files, stock));
  assert.strictEqual(a, b);
  assert.strictEqual(JSON.stringify(files), before, 'inputs must not be mutated');
});

test('src/lvl modules require no database, no fs, no network', () => {
  // Enforces the same hard constraint planner/server.js declares. A stray
  // require('pg') or require('fs') here would make the tool need something it
  // must never have — the lvl modules are pure, given their inputs as plain
  // objects/strings.
  for (const f of ['planLvl.js', 'parseLvlSheet.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'lvl', f), 'utf8');
    const reqs = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
    for (const r of reqs) {
      assert.ok(r.startsWith('./') || r.startsWith('../ewp/'),
        `${f} requires "${r}" - lvl modules may only reuse sibling or ../ewp/ helpers`);
    }
  }
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

test('GET /lvl serves the LVL planner page', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/lvl`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /<title>LVL linear-footage planner<\/title>/i);
  });
});

test('POST /api/lvl/plan plans a batch via HTTP API, auto-detecting the stock file', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/lvl/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        files: [
          { name: 'a.csv', text: JOB_A },
          { name: 'stock.csv', text: STOCK_CSV },
        ],
      }),
    });
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.jobs.length, 1);
    assert.equal(data.rerouted.length, 1);
    assert.equal(data.rerouted[0].to, 'stock');
    assert.equal(data.hasStock, true);
    const d1178 = data.byDepth.find((d) => d.depth === '11-78');
    assert.equal(d1178.usedLf, 32);
  });
});
