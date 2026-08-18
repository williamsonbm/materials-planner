// =============================================================
// planner/server.js — the DB-FREE local entry point.
// Run with: npm start   →  http://localhost:3000
// =============================================================
// A standalone purchase planner for a laptop (Linux or Windows 11). Drop in one
// or more MiTek "Material Summary" CSVs, say how many distinct stock lengths
// you're willing to order, and get back the length sets that minimize what you
// have to buy.
//
// HARD CONSTRAINT — this file must never reach for a database. No `pg`, no
// `dotenv`, no require of the app's ../../server.js. It shares the ENGINE with
// the web app (one copy of optimizeCuts.js, no drift) and nothing else. It also
// binds 127.0.0.1 only: this is a personal tool, not a LAN service, and the
// app's own auth/session layer is not in play here.
//
// UPLOADS — the browser reads the CSVs with FileReader and POSTs them as JSON
// text. That avoids a multipart parser (and a new npm dependency) entirely;
// material summaries are a few KB of text. express.json's limit is the DoS
// guard, mirroring the body-size reasoning in the main server.
// =============================================================

const express = require('express');
const path = require('node:path');

const { parseJobCsv } = require('../ewp/parseCsv.js');
const { parseStockCsv, looksLikeStockCsv } = require('../ewp/readStockCsv.js');
const { applyStock, coverageOf } = require('../ewp/applyStock.js');
const { analyzeBatch, productsOf, splitBatch } = require('../ewp/selectStockLengths.js');
const {
  IJOIST_LENGTH_MENU, DEFAULT_PURCHASE_LENGTHS_BY_CAT, DEFAULT_LVL_DROP_MIN_FT,
} = require('../ewp/optimizeCuts.js');
const { planPlates } = require('../plates/planPlates.js');
const { parsePlateStockCsv, looksLikePlateStockCsv } = require('../plates/readPlateStockCsv.js');
const { planHangers } = require('../hangers/planHangers.js');
const { parseHangerStockCsv, looksLikeHangerStockCsv } = require('../hangers/readHangerStockCsv.js');

const PORT = Number(process.env.PORT || process.env.PLANNER_PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

// How many ranked candidates to ship to the browser. The search can evaluate
// ~969 sets at maxLengths:3; the buyer only ever looks at the head of that list,
// and sending all of them is a slow response for no benefit.
const RESULT_LIMIT = 25;

const app = express();
app.use(express.json({ limit: '5mb' }));

// Never let a browser cache this tool. Without it, /api/menu is a plain GET with
// no Cache-Control and no Last-Modified, so a browser may heuristically reuse an
// older response — which is exactly what happened when the menu payload changed
// shape between restarts: the page kept a stale body, blew up reading a field
// that no longer existed, and silently rendered an empty pool editor. A dev tool
// on localhost has nothing to gain from caching.
app.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store, max-age=0');
  next();
});

// Deliberately NOT express.static(public/). Two reasons: the app's public/ has
// its own index.html, which express.static would serve at "/" ahead of any
// route here — you'd get the hanger app's dashboard firing DB calls at a server
// that has no database. And planner.html is fully self-contained (inline CSS +
// JS), so it lives next to this file rather than in the app's asset dir, where
// the main server would otherwise publish a page whose /api/plan doesn't exist.
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'planner.html'));
});

// The cut-list diagrams, shared verbatim with the web app's /optimize.html so
// the office reads the same picture in both places. Served as THREE EXPLICIT
// ROUTES rather than a static mount of public/ — mounting it would also publish
// index.html, optimize.html and the rest of an app this server cannot back.
const SHARED_ASSETS = {
  '/cutListModel.js': [path.join(__dirname, '..', 'ewp', 'cutListModel.js'), 'application/javascript'],
  '/cutList.js': [path.join(__dirname, '..', '..', 'public', 'cutList.js'), 'application/javascript'],
  '/cutList.css': [path.join(__dirname, '..', '..', 'public', 'cutList.css'), 'text/css'],
};
for (const [route, [file, type]] of Object.entries(SHARED_ASSETS)) {
  app.get(route, (_req, res) => res.type(type).sendFile(file));
}

// ── PLATES ──────────────────────────────────────────────────────────────────
// A second, independent tool sharing this process. Deliberately its own page and
// its own endpoint rather than a mode toggle on the EWP planner: the two answer
// different questions (which lengths to buy vs how many boxes), and the EWP
// page's pool editor and max-lengths controls are meaningless for plates.
// Nothing below touches the EWP path.
app.get('/plates', (_req, res) => {
  res.sendFile(path.join(__dirname, 'plates.html'));
});

app.post('/api/plates/plan', (req, res) => {
  const { files, stock } = req.body || {};
  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ ok: false, error: 'No CSV files were provided.' });
  }

  // Sniff the dropped files rather than trusting which zone they landed in — a
  // misfiled CSV is a two-second mistake that would otherwise cost a confusing
  // error. Same reasoning as routeFiles() for the EWP side.
  const jobFiles = [];
  let stockFile = stock && String(stock.text || '').trim() ? stock : null;
  const rerouted = [];
  for (const f of files) {
    if (looksLikePlateStockCsv(String(f.text || ''))) {
      if (!stockFile) { stockFile = f; rerouted.push({ name: f.name, to: 'stock' }); }
    } else {
      jobFiles.push(f);
    }
  }

  let parsedStock = null;
  let stockError = null;
  if (stockFile) {
    try {
      parsedStock = parsePlateStockCsv(String(stockFile.text || ''));
    } catch (err) {
      // A bad stock file must not refuse the plan outright — losing the netting
      // is annoying; refusing to plan because an OPTIONAL second input was wrong
      // is worse. Same call the EWP side makes in readStock().
      stockError = err.message;
    }
  }

  let plan;
  try {
    plan = planPlates(jobFiles, parsedStock);
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
  if (!plan.jobs.length) {
    return res.status(400).json({
      ok: false, error: 'No usable plate material summaries found.', rejected: plan.rejected,
    });
  }

  res.json({
    ok: true,
    ...plan,
    rerouted,
    stockFileName: stockFile ? stockFile.name : null,
    stockError,
  });
});

// ── HANGERS ─────────────────────────────────────────────────────────────────
app.get('/hangers', (_req, res) => {
  res.sendFile(path.join(__dirname, 'hangers.html'));
});

app.post('/api/hangers/plan', (req, res) => {
  const { files, stock } = req.body || {};
  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ ok: false, error: 'No CSV files were provided.' });
  }

  const jobFiles = [];
  let stockFile = stock && String(stock.text || '').trim() ? stock : null;
  const rerouted = [];
  for (const f of files) {
    if (looksLikeHangerStockCsv(String(f.text || ''))) {
      if (!stockFile) { stockFile = f; rerouted.push({ name: f.name, to: 'stock' }); }
    } else {
      jobFiles.push(f);
    }
  }

  let parsedStock = null;
  let stockError = null;
  if (stockFile) {
    try {
      parsedStock = parseHangerStockCsv(String(stockFile.text || ''));
    } catch (err) {
      stockError = err.message;
    }
  }

  let plan;
  try {
    plan = planHangers(jobFiles, parsedStock);
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
  if (!plan.jobs.length) {
    return res.status(400).json({
      ok: false, error: 'No usable hanger material summaries found.', rejected: plan.rejected,
    });
  }

  res.json({
    ok: true,
    ...plan,
    rerouted,
    stockFileName: stockFile ? stockFile.name : null,
    stockError,
  });
});

// Menu + defaults for the UI, read from the engine rather than re-typed here —
// same single-source-of-truth rule server.js follows.
app.get('/api/menu', (_req, res) => {
  res.json({
    ok: true,
    lengthMenu: IJOIST_LENGTH_MENU,
    supplierDefault: DEFAULT_PURCHASE_LENGTHS_BY_CAT['I-Joist'],
    // Defaults for the LVL / Rim pools. These are SET by the user, not searched:
    // the engine already opens the cheapest allowed length per board, so simply
    // widening the list captures the benefit without any extra combinatorics.
    byCat: {
      LVL: DEFAULT_PURCHASE_LENGTHS_BY_CAT['LVL'],
      RimBoard: DEFAULT_PURCHASE_LENGTHS_BY_CAT['RimBoard'],
    },
    lvlDropMinFt: DEFAULT_LVL_DROP_MIN_FT,
  });
});

// Parse the uploaded CSVs once. Shared by /api/inspect and /api/plan so the two
// never disagree about what is in a batch. parseJobCsv returns [] for a non-EWP
// export, which is a user-facing mistake worth naming rather than silently
// dropping.
function readBatch(files) {
  const jobs = [];
  const rejected = [];
  const cutItems = [];
  for (const f of files) {
    let items;
    try {
      items = parseJobCsv(String(f.text || ''));
    } catch (err) {
      rejected.push({ name: f.name, reason: `parse failed: ${err.message}` });
      continue;
    }
    if (!items.length) {
      rejected.push({ name: f.name, reason: 'not an EWP material summary (Product != "EWP")' });
      continue;
    }
    const header = items.find((i) => i.kind === 'header') || {};
    const materials = items.filter((i) => i.kind === 'material' && i.category !== 'Hanger');
    if (!materials.length) {
      rejected.push({ name: f.name, reason: 'no EWP cut material rows (hangers only?)' });
      continue;
    }
    jobs.push({
      file: f.name,
      jobNumber: header.jobNumber || 'Unknown',
      jobName: header.jobName || 'Unknown',
      deliveryDate: header.deliveryDate || 'Unknown',
      pieces: materials.reduce((s, m) => s + (m.qty || 0), 0),
      categories: [...new Set(materials.map((m) => m.category))].sort(),
    });
    cutItems.push(...items);
  }
  return { jobs, rejected, cutItems };
}

// Sort the uploaded files into job summaries and the (single) stock list.
//
// The page has a drop zone for each, but a misfiled CSV is a two-second mistake
// that would otherwise cost a confusing error — a stock file parsed as a job is
// "not an EWP material summary", which says nothing useful. The two shapes are
// unambiguous (a stock file's header carries item/span/qty; a MiTek summary's
// does not), so sniff and re-file, and tell the caller it happened.
function routeFiles(files, stockFile) {
  const jobFiles = [];
  const stockFiles = [];
  const rerouted = [];

  for (const f of files || []) {
    if (looksLikeStockCsv(String(f.text || ''))) {
      stockFiles.push(f);
      rerouted.push({ name: f.name, to: 'stock' });
    } else {
      jobFiles.push(f);
    }
  }
  if (stockFile && String(stockFile.text || '').trim()) {
    if (looksLikeStockCsv(String(stockFile.text))) {
      // An explicitly-dropped stock file wins over one sniffed out of the job pile.
      stockFiles.unshift(stockFile);
    } else {
      jobFiles.push(stockFile);
      rerouted.push({ name: stockFile.name, to: 'jobs' });
    }
  }
  return { jobFiles, stockFile: stockFiles[0] || null, rerouted };
}

// Parse the stock CSV, if there is one. A malformed stock file is reported and
// the plan still runs greenfield — losing the netting is annoying, but refusing
// to plan at all because a second, optional input was wrong is worse.
function readStock(file) {
  if (!file) return { items: [], info: null };
  try {
    const r = parseStockCsv(String(file.text || ''));
    return {
      items: r.items,
      info: {
        name: file.name,
        rows: r.rowCount,
        qtyColumn: r.qtyColumn,
        skipped: r.skipped.length,
        warnings: r.warnings,
      },
    };
  } catch (err) {
    return { items: [], info: { name: file.name, error: err.message, rows: 0 } };
  }
}

// What products are in this batch? The pool editor can only be drawn once we know,
// and parsing lives here — so the UI asks on drop, before planning anything. Parse
// only, no packing: this returns in milliseconds.
app.post('/api/inspect', (req, res) => {
  const { files, stock } = req.body || {};
  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ ok: false, error: 'No CSV files were provided.' });
  }
  const routed = routeFiles(files, stock);
  const { jobs, rejected, cutItems } = readBatch(routed.jobFiles);
  if (!cutItems.length) {
    return res.status(400).json({ ok: false, error: 'No usable EWP job data found.', rejected });
  }
  const { ijoistItems } = splitBatch(cutItems);
  const stockRead = readStock(routed.stockFile);
  res.json({
    ok: true,
    jobs,
    rejected,
    rerouted: routed.rerouted,
    // One entry per I-Joist PRODUCT — each is an independent sourcing decision
    // with its own supplier availability and its own length budget.
    products: productsOf(ijoistItems).map((p) => ({
      key: p.key, size: p.size, depth: p.depth, pieces: p.pieces, feet: p.feet,
    })),
    stock: stockRead.info,
    // Which materials the stock file actually mentions. Worth showing BEFORE a
    // plan that takes ~40s: "this file says nothing about TJI® 560" is a
    // different problem from "there are none on hand", and only one of them is
    // fixed by exporting the stock list again.
    coverage: stockRead.items.length ? coverageOf(cutItems, stockRead.items) : null,
  });
});

app.post('/api/plan', (req, res) => {
  const {
    files, stock, maxLengths, menu, topN,
    purchaseLengthsByCat, lvlDropMinFt, poolBySize, maxLengthsBySize,
  } = req.body || {};

  if (!Array.isArray(files) || files.length === 0) {
    return res.status(400).json({ ok: false, error: 'No CSV files were provided.' });
  }

  const routed = routeFiles(files, stock);
  const { jobs, rejected, cutItems } = readBatch(routed.jobFiles);

  if (!cutItems.length) {
    return res.status(400).json({ ok: false, error: 'No usable EWP job data found.', rejected });
  }

  // Only the LVL / RimBoard pools are user-settable here. I-Joist sourcing is
  // decided by the SEARCH (via `menu`), so letting it also arrive as a
  // per-category override would give two competing answers for one question.
  let byCat = null;
  if (purchaseLengthsByCat && typeof purchaseLengthsByCat === 'object') {
    byCat = {};
    for (const cat of ['LVL', 'RimBoard']) {
      const v = purchaseLengthsByCat[cat];
      if (!Array.isArray(v)) continue;
      const lens = v.map(Number).filter((n) => Number.isFinite(n) && n > 0);
      if (!lens.length) {
        return res.status(400).json({
          ok: false, error: `${cat} must have at least one purchasable length.`,
        });
      }
      byCat[cat] = lens;
    }
    if (!Object.keys(byCat).length) byCat = null;
  }

  // Per-product pools. An empty list is a real error worth naming — the UI should
  // never send one, and if it does the buyer deserves to be told which product.
  let pools = null;
  if (poolBySize && typeof poolBySize === 'object') {
    pools = {};
    for (const [key, v] of Object.entries(poolBySize)) {
      if (!Array.isArray(v)) continue;
      const lens = v.map(Number).filter((n) => Number.isFinite(n) && n > 0);
      if (!lens.length) {
        return res.status(400).json({
          ok: false, error: `No purchasable lengths are ticked for "${key}".`,
        });
      }
      pools[key] = lens;
    }
  }

  const t0 = Date.now();
  let result;
  try {
    result = analyzeBatch(cutItems, {
      maxLengths: Number(maxLengths) || 3,
      maxLengthsBySize: maxLengthsBySize && typeof maxLengthsBySize === 'object'
        ? maxLengthsBySize : undefined,
      menu: Array.isArray(menu) && menu.length ? menu.map(Number) : undefined,
      poolBySize: pools,
      // Finalists refined at full budget for the WINNING length count. Each one
      // is a full engine run, so this is the main runtime dial: 3 still lets a
      // different length set overtake the sweep's leader after refinement.
      topN: Number(topN) || 3,
      purchaseLengthsByCat: byCat,
      lvlDropMinFt: Number.isFinite(Number(lvlDropMinFt)) ? Number(lvlDropMinFt) : undefined,
    });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }

  // ---- net the greenfield answer against the yard.
  //
  // Deliberately AFTER the search, never inside it: the search stays greenfield
  // so its recommended lengths and the waste they're ranked on don't move with
  // the stock snapshot. See the header of applyStock.js.
  //
  // With no stock file this stays null and every field above is byte-identical
  // to what this endpoint returned before the feature existed.
  const stockRead = readStock(routed.stockFile);
  let stockView = null;
  if (stockRead.items.length) {
    try {
      stockView = applyStock(cutItems, result, stockRead.items, {
        purchaseLengthsByCat: byCat,
        lvlDropMinFt: Number.isFinite(Number(lvlDropMinFt)) ? Number(lvlDropMinFt) : undefined,
      });
    } catch (err) {
      // A failed netting must not throw away a plan that took ~40s to compute.
      stockRead.info = { ...(stockRead.info || {}), error: `netting failed: ${err.message}` };
    }
  }

  res.json({
    ok: true,
    jobs,
    rejected,
    rerouted: routed.rerouted,
    ms: Date.now() - t0,
    // One independent answer per I-Joist product…
    products: result.products.map((p) => ({
      ...p,
      ranked: (p.ranked || []).slice(0, RESULT_LIMIT),
      truncated: Math.max(0, (p.ranked || []).length - RESULT_LIMIT),
    })),
    // …and one order, one cut sheet, one set of totals across all of them.
    totals: result.totals,
    purchaseList: result.purchaseList,
    cutPlan: result.cutPlan,
    error: result.error,
    // …plus, when a stock list was dropped, what the yard covers of it.
    stockInfo: stockRead.info,
    stock: stockView,
  });
});

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    const url = HOST === '0.0.0.0' ? `http://localhost:${PORT}` : `http://${HOST}:${PORT}`;
    console.log(`Materials purchase planner  →  ${url}`);
    console.log('No database, no .env, localhost only. Ctrl-C to stop.');
  });
}

module.exports = { app };
