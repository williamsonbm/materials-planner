// =============================================================
// planLvl.js — "Across these jobs, how much LVL (by the linear foot) do we
// need, and what does the yard already cover?"
// =============================================================
// Standalone, DB-free LVL linear-footage planner. Unlike the EWP cut planner,
// this is NOT a length-optimization problem — there is no bin-packing here,
// and optimizeCuts.js is deliberately not touched (see CLAUDE.md: it is kept
// byte-identical to the sibling hanger-web-app on purpose).
//
// Core behaviors:
//   * Uses parseLvlSheet (src/lvl/parseLvlSheet.js), NOT parseJobCsv — that
//     parser gates the whole file on `Product: EWP`, which silently drops
//     real LVL usage on Roof/Floor jobs that carry a Rectangular EWP section
//     alongside trusses. See parseLvlSheet.js's header for the full reasoning.
//   * A job with a job number but genuinely no LVL rows is included with zero
//     usage, not rejected — the same "legitimately zero" call the hangers
//     planner makes for a job with no Hangers section. Only a file with no
//     recognizable job number at all is rejected.
//   * Linear feet per row = qty × decimalFeet. This already accounts for
//     plies: MiTek's QTY column on an LVL row counts individual 1-3/4"-thick
//     boards, whether that's several single-ply beams or the plies of one
//     multi-ply beam (e.g. QTY=2, LENGTH=16' is one 2-ply 16' beam = 32 LF of
//     1-3/4" stock either way). No separate ply multiplier is needed.
//   * Grouped by DEPTH ONLY (extractDepth), never by full size string — LVL
//     thickness is always one ply's cross-section (1-3/4"), so a multi-ply
//     beam and a single-ply beam of the same depth draw from the same base
//     stock pool. This matches how stock is matched below.
//   * Stock (optional): reuses parseStockCsv (src/ewp/readStockCsv.js)
//     verbatim. Rows are filtered to ones that look like LVL (the item
//     string contains "LVL" — the wide EWP stock export can carry I-Joist/
//     RimBoard/LVL rows together), then grouped by depth the same way.
//     Stock linear feet per row = qty × span.
//   * Aggregates across every dropped job file, and across every dropped
//     stock row, before netting — so two jobs against one yard read as one
//     answer, the same as the hangers/plates planners.
// =============================================================

"use strict";

const { parseLvlSheet } = require('./parseLvlSheet.js');
const { extractDepth, KNOWN_DEPTHS } = require('../ewp/extractDepth.js');

// extractDepth's sheet-form keys ("11-78", "9-12") aren't fit to show a user.
// KNOWN_DEPTHS is a fixed, small set, so an explicit label map is clearer
// than trying to invert the fraction encoding generically.
const DEPTH_LABELS = {
  '9-12': '9-1/2"', '11-78': '11-7/8"', '14': '14"', '16': '16"',
  '18': '18"', '20': '20"', '22': '22"', '24': '24"',
};
function depthLabel(depth) {
  return DEPTH_LABELS[depth] || `${depth}"`;
}

// Numeric ordering by known depth, not string sort ("11-78" < "14" alphabetically
// but should read as an inch value). Depths are always a member of KNOWN_DEPTHS
// here (extractDepth returns "" otherwise, and "" rows are excluded upstream).
function byDepthOrder(a, b) {
  return KNOWN_DEPTHS.indexOf(a.depth) - KNOWN_DEPTHS.indexOf(b.depth);
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Plan LVL linear-footage across a batch of job files against optional stock.
 *
 * @param {Array<{ name: string, text: string }>} jobFiles
 * @param {{ items: Array<{ item: string, span: number, qty: number }> } | null} parsedStock
 */
function planLvl(jobFiles, parsedStock = null) {
  const jobs = [];
  const rejected = [];
  const warnings = [];

  // depth -> { depth, usedLf, jobs: [{ jobNumber, jobName, deliveryDate, lf }] }
  const usageByDepth = new Map();

  for (const f of jobFiles || []) {
    let res;
    try {
      res = parseLvlSheet(String(f.text || ''));
    } catch (err) {
      rejected.push({ name: f.name, reason: `parse failed: ${err.message}` });
      continue;
    }
    if (!res.ok) {
      rejected.push({ name: f.name, reason: res.reason });
      continue;
    }
    if (res.warnings && res.warnings.length) {
      for (const w of res.warnings) warnings.push(w);
    }

    const header = res.meta;
    const jobByDepth = new Map(); // depth -> lf, this job only
    for (const it of res.items) {
      const depth = extractDepth(it.size, 'LVL');
      if (!depth) {
        warnings.push(`[${header.jobNumber || f.name}] Could not determine depth for LVL size "${it.size}" — this row was skipped.`);
        continue;
      }
      const lf = it.qty * it.decimalFeet;
      jobByDepth.set(depth, (jobByDepth.get(depth) || 0) + lf);

      if (!usageByDepth.has(depth)) {
        usageByDepth.set(depth, { depth, usedLf: 0, jobs: [] });
      }
      usageByDepth.get(depth).usedLf += lf;
    }

    const jobDepths = [...jobByDepth.entries()]
      .map(([depth, lf]) => ({ depth, label: depthLabel(depth), lf: round2(lf) }))
      .sort(byDepthOrder);

    jobs.push({
      name: f.name,
      jobNumber: header.jobNumber || 'Unknown',
      jobName: header.jobName || 'Unknown',
      deliveryDate: header.deliveryDate || 'Unknown',
      byDepth: jobDepths,
      totalLf: round2(jobDepths.reduce((s, d) => s + d.lf, 0)),
      // Raw line items, in sheet order, exactly as the material summary lists
      // them (label/size/qty/length) — even a row whose depth couldn't be
      // extracted still shows here. This is what the "line items as they
      // appear on the material sheet" drill-down in the UI renders.
      items: res.items.map((it) => ({
        label: it.label, size: it.size, qty: it.qty, length: it.rawLength,
      })),
    });

    for (const d of jobDepths) {
      usageByDepth.get(d.depth).jobs.push({
        jobNumber: header.jobNumber || 'Unknown',
        jobName: header.jobName || 'Unknown',
        deliveryDate: header.deliveryDate || 'Unknown',
        lf: d.lf,
      });
    }
  }

  // ---- Stock, if provided: LVL rows only, grouped by depth ----
  const hasStock = Boolean(parsedStock && Array.isArray(parsedStock.items));
  const stockByDepth = new Map(); // depth -> lf
  if (hasStock) {
    for (const item of parsedStock.items) {
      if (!/\blvl\b/i.test(item.item)) continue;
      const depth = extractDepth(item.item, 'LVL');
      if (!depth) {
        warnings.push(`Stock row "${item.item}" looks like LVL but its depth couldn't be determined — skipped from stock netting.`);
        continue;
      }
      const lf = item.qty * item.span;
      stockByDepth.set(depth, (stockByDepth.get(depth) || 0) + lf);
    }
    if (!stockByDepth.size) {
      warnings.push('Stock file was read, but no LVL rows were found in it — every depth below shows as a full buy.');
    }
  }

  // ---- Net usage against stock, one row per depth seen anywhere ----
  const allDepths = new Set([...usageByDepth.keys(), ...stockByDepth.keys()]);
  const byDepth = [...allDepths].map((depth) => {
    const usage = usageByDepth.get(depth);
    const usedLf = round2(usage ? usage.usedLf : 0);
    const stockLf = hasStock ? round2(stockByDepth.get(depth) || 0) : null;
    const remainingLf = hasStock ? round2(Math.max(0, stockLf - usedLf)) : null;
    const neededLf = hasStock ? round2(Math.max(0, usedLf - stockLf)) : null;
    return {
      depth,
      label: depthLabel(depth),
      usedLf,
      stockLf,
      remainingLf,
      neededLf,
      jobs: usage ? [...usage.jobs].sort((a, b) => b.lf - a.lf) : [],
    };
  }).sort(byDepthOrder);

  const summary = {
    jobsCount: jobs.length,
    depthsCount: byDepth.length,
    totalUsedLf: round2(byDepth.reduce((s, d) => s + d.usedLf, 0)),
    totalStockLf: hasStock ? round2(byDepth.reduce((s, d) => s + (d.stockLf || 0), 0)) : null,
    totalNeededLf: hasStock ? round2(byDepth.reduce((s, d) => s + (d.neededLf || 0), 0)) : null,
    hasStock,
  };

  return { jobs, byDepth, summary, hasStock, warnings, rejected };
}

module.exports = { planLvl };
