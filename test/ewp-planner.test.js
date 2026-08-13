// =============================================================
// ewp-planner.test.js — the standalone (DB-free) purchase planner.
// Run with: npm test  (node --test)
// =============================================================
// The planner's defining constraint is NEGATIVE: it must run on a laptop with
// no Postgres, no .env and no LAN. That is easy to break by accident — one
// convenience `require` of the app's server.js would drag in `pg` and `dotenv`
// and the tool would start demanding a database on startup. So the module graph
// is asserted here rather than left to a code-review grep.
//
// node --test runs each test FILE in its own process, so require.cache below
// reflects only what this file pulled in.
// =============================================================

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { app } = require('../src/planner/server.js');

const FIX = path.join(__dirname, 'ewp-fixtures');

// Boot on an ephemeral port, run `fn`, always close.
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

const post = (base, body) =>
  fetch(`${base}/api/plan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json().then((j) => ({ status: r.status, body: j })));

const fixture = (name) => ({ name, text: fs.readFileSync(path.join(FIX, name), 'utf8') });

// ---- the negative constraint -----------------------------------------------

test('the planner module graph contains no database or env dependency', () => {
  const loaded = Object.keys(require.cache);
  const forbidden = ['node_modules/pg/', 'node_modules/pg-pool/', 'node_modules/dotenv/'];
  for (const f of forbidden) {
    const hit = loaded.find((m) => m.split(path.sep).join('/').includes(f));
    assert.equal(hit, undefined, `planner must not load ${f} (found ${hit})`);
  }
});

test('the planner does not load the web app server', () => {
  const appServer = path.join(__dirname, '..', 'server.js');
  assert.ok(!require.cache[appServer], 'planner must not require the app server.js');
});

test('the planner shares ONE copy of the engine with the app (no vendored fork)', () => {
  // If someone "extracts" the optimizer by copying it under src/planner/, this
  // fails — which is the whole point of the branch-not-fork decision.
  const engine = path.join(__dirname, '..', 'src', 'ewp', 'optimizeCuts.js');
  assert.ok(require.cache[engine], 'planner must load src/ewp/optimizeCuts.js itself');
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'src', 'planner', 'optimizeCuts.js')),
    'no forked copy of the engine may exist under src/planner/');
});

// ---- routing ---------------------------------------------------------------

test('GET / serves the planner page, not the web app dashboard', async () => {
  await withServer(async (base) => {
    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /<title>EWP Purchase Planner<\/title>/);
  });
});

test('the web app pages are NOT served by the planner', async () => {
  await withServer(async (base) => {
    // public/index.html exists; if express.static were mounted it would shadow
    // "/" and serve a dashboard whose API calls hit a server with no database.
    for (const p of ['/index.html', '/optimize.html', '/app.css']) {
      const r = await fetch(`${base}${p}`);
      assert.equal(r.status, 404, `${p} must not be served`);
    }
  });
});

test('GET /api/menu reports the engine menu rather than a re-typed copy', async () => {
  const { IJOIST_LENGTH_MENU, DEFAULT_PURCHASE_LENGTHS_BY_CAT, DEFAULT_LVL_DROP_MIN_FT } =
    require('../src/ewp/optimizeCuts.js');
  await withServer(async (base) => {
    const m = await (await fetch(`${base}/api/menu`)).json();
    assert.deepEqual(m.lengthMenu, IJOIST_LENGTH_MENU);
    assert.deepEqual(m.supplierDefault, DEFAULT_PURCHASE_LENGTHS_BY_CAT['I-Joist']);
    // Starting points for the user-settable LVL / Rim pools.
    assert.deepEqual(m.byCat.LVL, [48]);
    assert.deepEqual(m.byCat.RimBoard, [12]);
    assert.equal(m.lvlDropMinFt, DEFAULT_LVL_DROP_MIN_FT);
  });
});

// ---- planning --------------------------------------------------------------

test('POST /api/plan plans a two-job batch with no database in sight', async () => {
  await withServer(async (base) => {
    const { status, body } = await post(base, {
      files: [fixture('34120J-materials.csv'), fixture('34182J-materials.csv')],
      maxLengths: 1, menu: [48, 44, 40], topN: 1,
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);

    assert.deepEqual(body.jobs.map((j) => j.jobNumber), ['34120J', '34182J']);
    assert.ok(body.totals, 'a feasible plan exists');
    assert.ok(body.purchaseList.length > 0);
    assert.ok(body.products.length >= 1 && body.products.every((p) => p.best));
    // Greenfield: the buy list is the whole job, and it spans all three categories.
    const cats = new Set(body.purchaseList.map((p) => p.category));
    assert.deepEqual([...cats].sort(), ['I-Joist', 'LVL', 'RimBoard']);
  });
});

test('POST /api/plan names the files it could not use', async () => {
  await withServer(async (base) => {
    const { status, body } = await post(base, {
      files: [{ name: 'junk.csv', text: 'not,a,material,summary' }],
      maxLengths: 2,
    });
    assert.equal(status, 400);
    assert.equal(body.ok, false);
    assert.equal(body.rejected.length, 1);
    assert.match(body.rejected[0].reason, /not an EWP material summary/);
  });
});

test('POST /api/plan rejects an empty request rather than planning nothing', async () => {
  await withServer(async (base) => {
    const { status, body } = await post(base, { files: [] });
    assert.equal(status, 400);
    assert.match(body.error, /No CSV files/);
  });
});

test('POST /api/plan names the product whose pool is empty, not a stack trace', async () => {
  await withServer(async (base) => {
    const ins = await (await fetch(`${base}/api/inspect`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: [fixture('34120J-materials.csv')] }),
    })).json();
    const { status, body } = await post(base, {
      files: [fixture('34120J-materials.csv')],
      maxLengths: 1, poolBySize: { [ins.products[0].key]: [] },
    });
    assert.equal(status, 400);
    assert.match(body.error, /No purchasable lengths are ticked/);
    assert.match(body.error, /pji-40/);
  });
});

// ---- the phase-2 response: recommendation, curve, cut plan -----------------

test('POST /api/plan returns a recommendation, a curve and a cut plan', async () => {
  await withServer(async (base) => {
    const { status, body } = await post(base, {
      files: [fixture('33844J-materials.csv')],
      maxLengths: 3, menu: [48, 44, 40, 36, 34, 32, 30, 28],
    });
    assert.equal(status, 200);
    assert.equal(body.ok, true);

    // The bug report, end to end through HTTP: zero true waste, 144 ft of drops.
    // 33844J is a single-product job, so there is exactly one product section.
    assert.equal(body.products.length, 1);
    const p = body.products[0];
    assert.equal(p.recommended, 2);
    assert.deepEqual(p.best.lengthsUsed, [36, 32]);
    assert.equal(p.best.ijoistWaste, 0);
    assert.equal(body.totals.trueWaste, 0);
    assert.equal(body.totals.recoverableDrops, 144);

    // Curve covers every N up to the cap, and never gets worse as N grows.
    assert.deepEqual(p.curve.map((c) => c.n), [1, 2, 3]);
    for (let i = 1; i < p.curve.length; i++) {
      assert.ok(p.curve[i].ijoistWaste <= p.curve[i - 1].ijoistWaste);
    }

    // Advice is present and names the shortcut.
    assert.ok(p.suggestions.some((s) => s.kind === 'clean'));

    // Cut plan reaches the client with all three categories.
    assert.equal(body.cutPlan.length, 1);
    assert.deepEqual(body.cutPlan[0].groups.map((g) => g.category).sort(),
      ['I-Joist', 'LVL', 'RimBoard']);
    assert.ok(body.cutPlan[0].groups.every((g) => g.boards.length === g.boardCount));
  });
});

test('POST /api/plan honours a widened LVL pool', async () => {
  await withServer(async (base) => {
    const send = (LVL) => post(base, {
      files: [fixture('33844J-materials.csv')],
      maxLengths: 2, menu: [48, 36, 32, 28],
      purchaseLengthsByCat: { LVL, RimBoard: [12] },
    });
    const a = (await send([48])).body;
    const b = (await send([48, 44, 40])).body;
    assert.equal(a.totals.recoverableDrops, 144);
    assert.equal(b.totals.recoverableDrops, 80, 'shorter LVL boards leave less over');
    assert.equal(a.products[0].best.ijoistWaste, b.products[0].best.ijoistWaste,
      'I-Joist is untouched');
  });
});

test('POST /api/plan rejects an empty LVL pool instead of planning nothing', async () => {
  await withServer(async (base) => {
    const { status, body } = await post(base, {
      files: [fixture('33844J-materials.csv')],
      maxLengths: 2, purchaseLengthsByCat: { LVL: [], RimBoard: [12] },
    });
    assert.equal(status, 400);
    assert.match(body.error, /LVL must have at least one purchasable length/);
  });
});

test('POST /api/plan lets the drop threshold move the waste figure', async () => {
  await withServer(async (base) => {
    const send = (lvlDropMinFt) => post(base, {
      files: [fixture('33844J-materials.csv')],
      maxLengths: 2, menu: [48, 36, 32, 28], lvlDropMinFt,
    });
    assert.equal((await send(8)).body.totals.trueWaste, 0);
    assert.equal((await send(30)).body.totals.trueWaste, 144);
  });
});

// ---- caching ---------------------------------------------------------------
// A shipped page + a restarted server is the normal upgrade path for this tool,
// so a browser must never be able to pair new HTML with a cached old API body.
// That failure mode is silent and awful: the page throws reading a field that no
// longer exists, renders an empty pool editor, and the user gets a server error
// blaming them for lengths they were never given a chance to pick.

test('every response is marked no-store so a stale API body cannot be reused', async () => {
  await withServer(async (base) => {
    for (const p of ['/', '/api/menu']) {
      const r = await fetch(`${base}${p}`);
      assert.match(r.headers.get('cache-control') || '', /no-store/, `${p} must be no-store`);
    }
  });
});

test('the page only reads /api/menu fields the server actually sends', async () => {
  // Guards the exact break above: the HTML destructures MENU.byCat.LVL, so if the
  // payload is renamed again this fails here rather than in someone's browser.
  await withServer(async (base) => {
    const html = await (await fetch(`${base}/`)).text();
    const menu = await (await fetch(`${base}/api/menu`)).json();
    for (const key of ['lengthMenu', 'supplierDefault', 'byCat', 'lvlDropMinFt']) {
      if (!new RegExp(`MENU\\.${key}\\b`).test(html)) continue;
      assert.notEqual(menu[key], undefined, `page reads MENU.${key} but /api/menu omits it`);
    }
    assert.notEqual(menu.byCat.LVL, undefined);
    assert.notEqual(menu.byCat.RimBoard, undefined);
  });
});

// ---- shared cut-list assets ------------------------------------------------

test('the planner serves the shared cut-list assets and nothing else from public/', async () => {
  await withServer(async (base) => {
    for (const p of ['/cutListModel.js', '/cutList.js', '/cutList.css']) {
      const r = await fetch(`${base}${p}`);
      assert.equal(r.status, 200, `${p} must be served`);
      assert.ok((await r.text()).length > 100, `${p} must have content`);
    }
    // Still an explicit allow-list, not a static mount of public/.
    for (const p of ['/nav.js', '/presets.html', '/optimize-editor.js']) {
      assert.equal((await fetch(`${base}${p}`)).status, 404, `${p} must not be served`);
    }
  });
});

test('the served cutListModel.js is the SAME file the PDF builders require', async () => {
  // A public/ duplicate would drift from the copy the printed sheets use; this
  // fails if anyone makes one.
  await withServer(async (base) => {
    const served = await (await fetch(`${base}/cutListModel.js`)).text();
    const onDisk = fs.readFileSync(path.join(__dirname, '..', 'src', 'ewp', 'cutListModel.js'), 'utf8');
    assert.equal(served, onDisk);
    assert.ok(!fs.existsSync(path.join(__dirname, '..', 'public', 'cutListModel.js')),
      'no duplicate copy may exist under public/');
  });
});

test('the cut plan reaches the client in the shape the shared renderer needs', async () => {
  await withServer(async (base) => {
    const { body } = await post(base, {
      files: [fixture('33844J-materials.csv')],
      maxLengths: 2, menu: [48, 36, 32, 28],
    });
    const groups = body.cutPlan[0].groups;
    for (const g of groups) {
      assert.ok(g.category && g.size, 'group carries category + size');
      for (const bd of g.boards) {
        assert.equal(typeof bd.stockLength, 'number');
        assert.ok(Array.isArray(bd.cuts) && bd.cuts.length > 0);
        for (const c of bd.cuts) {
          assert.ok(c.label !== undefined, 'cut carries a label');
          assert.equal(typeof c.length, 'number');
          assert.ok(c.length <= bd.stockLength + 1e-9);
        }
      }
    }
  });
});

// ---- product discovery -----------------------------------------------------

test('POST /api/inspect lists the products so the pool editor can be drawn', async () => {
  await withServer(async (base) => {
    const r = await (await fetch(`${base}/api/inspect`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      // 33591J carries TWO products at ONE depth — the reason pools are per
      // product rather than per depth.
      body: JSON.stringify({ files: [fixture('33591J-materials.csv')] }),
    })).json();

    assert.equal(r.ok, true);
    assert.deepEqual(r.jobs.map((j) => j.jobNumber), ['33591J']);
    assert.equal(r.products.length, 2);
    assert.ok(r.products.every((p) => p.depth === '11-78'), 'both at the same depth');
    assert.deepEqual(r.products.map((p) => p.size).sort(),
      ['11 7/8" TJI® 210', '11 7/8" TJI® 560']);
    for (const p of r.products) {
      assert.ok(p.key && p.pieces > 0 && p.feet > 0);
    }
  });
});

test('POST /api/inspect rejects junk the same way /api/plan does', async () => {
  await withServer(async (base) => {
    const bad = await fetch(`${base}/api/inspect`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: [{ name: 'junk.csv', text: 'nope' }] }),
    });
    assert.equal(bad.status, 400);
    const empty = await fetch(`${base}/api/inspect`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: [] }),
    });
    assert.equal(empty.status, 400);
  });
});

test('two products at one depth get separate plans and separate PO lines', async () => {
  await withServer(async (base) => {
    const files = [fixture('33591J-materials.csv')];
    const ins = await (await fetch(`${base}/api/inspect`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ files }),
    })).json();
    const k = Object.fromEntries(ins.products.map((p) => [p.size, p.key]));

    const { body } = await post(base, {
      files, maxLengths: 1,
      poolBySize: {
        [k['11 7/8" TJI® 210']]: [32],
        [k['11 7/8" TJI® 560']]: [48],
      },
    });
    const by = Object.fromEntries(body.products.map((p) => [p.size, p]));
    assert.deepEqual(by['11 7/8" TJI® 210'].best.lengthsUsed, [32]);
    assert.deepEqual(by['11 7/8" TJI® 560'].best.lengthsUsed, [48]);

    // Same depth, but two distinct order lines — which is the whole point.
    const ij = body.purchaseList.filter((p) => p.category === 'I-Joist');
    assert.equal(ij.length, 2);
    assert.equal(new Set(ij.map((l) => l.size)).size, 2);
  });
});
