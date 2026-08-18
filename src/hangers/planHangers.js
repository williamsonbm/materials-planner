// =============================================================
// planHangers.js — "Across these jobs, what hangers do we need to buy?"
// =============================================================
// Standalone, DB-free hanger purchase planner.
//
// Core behaviors:
//   * Aggregates demand across all dropped job CSVs.
//   * Baseline is `available` (on_hand − committed), never raw on_hand.
//   * Shortfall = Math.max(0, demand - available). (If available is negative,
//     the existing ledger shortfall is preserved in the buy figure).
//   * Incoming on open POs is REPORTED beside the buy figure, never netted out.
//   * SKUs not present in the stock catalog are surfaced in `unmatched` / special-order.
//   * Full drill-down back to the contributing jobs for every SKU.
// =============================================================

"use strict";

const { parseHangerSheet } = require('./parseHangerSheet.js');
const { skuKey } = require('./readHangerStockCsv.js');

/**
 * Plan hanger purchases across a batch of job files against optional stock.
 *
 * @param {Array<{ name: string, text: string }>} jobFiles
 * @param {{ byKey: Map<string, object>, rows: Array<object>, warnings: Array<string> } | null} parsedStock
 */
function planHangers(jobFiles, parsedStock = null) {
  const jobs = [];
  const rejected = [];
  const warnings = [];

  if (parsedStock && parsedStock.warnings) {
    warnings.push(...parsedStock.warnings);
  }

  // Map of skuKey -> { sku, key, demand, jobs: [{ jobNumber, jobName, deliveryDate, qty, section }] }
  const demandByKey = new Map();

  for (const f of jobFiles || []) {
    const res = parseHangerSheet(String(f.text || ''));
    if (!res.ok) {
      rejected.push({ name: f.name, reason: res.reason });
      continue;
    }

    if (res.warnings && res.warnings.length) {
      for (const w of res.warnings) {
        warnings.push(`[${res.meta.job_number || f.name}] ${w}`);
      }
    }

    const jobEntry = {
      name: f.name,
      jobNumber: res.meta.job_number,
      jobName: res.meta.job_name,
      deliveryDate: res.meta.delivery_date,
      commitDate: res.meta.commit_date,
      category: res.meta.category,
      lines: res.lines,
    };
    jobs.push(jobEntry);

    for (const line of res.lines) {
      const k = skuKey(line.sku);
      if (!k) continue;

      if (!demandByKey.has(k)) {
        demandByKey.set(k, {
          sku: line.sku,
          key: k,
          demand: 0,
          jobs: [],
        });
      }

      const item = demandByKey.get(k);
      item.demand += line.qty;
      item.jobs.push({
        jobNumber: res.meta.job_number,
        jobName: res.meta.job_name,
        deliveryDate: res.meta.delivery_date,
        qty: line.qty,
        section: line.section,
        mtype: line.mtype || '',
      });
    }
  }

  const hasStock = Boolean(parsedStock && parsedStock.byKey);
  const buyList = [];
  const covered = [];
  const unmatched = [];

  let totalDemandPieces = 0;
  let totalBuyPieces = 0;
  let totalIncomingPieces = 0;

  for (const item of demandByKey.values()) {
    totalDemandPieces += item.demand;

    let available = null;
    let availableRaw = null;
    let onHand = null;
    let committed = null;
    let incoming = 0;
    let threshold = 0;
    let isUnmatched = false;
    let shortfall = item.demand;

    if (hasStock) {
      const stockRow = parsedStock.byKey.get(item.key);
      if (stockRow) {
        onHand = stockRow.onHand;
        committed = stockRow.committed;
        available = stockRow.available;
        availableRaw = stockRow.availableRaw;
        incoming = stockRow.incoming;
        threshold = stockRow.threshold;

        // If availableRaw is negative, the yard already has a deficit; buying
        // demand + abs(deficit) buys the order AND fixes the existing shortfall.
        if (availableRaw < 0) {
          shortfall = item.demand + Math.abs(availableRaw);
        } else {
          shortfall = Math.max(0, item.demand - availableRaw);
        }
      } else {
        isUnmatched = true;
        shortfall = item.demand;
      }
    }

    const row = {
      sku: item.sku,
      key: item.key,
      demand: item.demand,
      available,
      availableRaw,
      onHand,
      committed,
      incoming,
      threshold,
      shortfall,
      buyPieces: shortfall,
      isUnmatched,
      jobs: item.jobs,
    };

    if (shortfall > 0) {
      buyList.push(row);
      totalBuyPieces += shortfall;
    } else {
      covered.push(row);
    }

    if (isUnmatched) {
      unmatched.push(row);
    }

    if (incoming > 0) {
      totalIncomingPieces += incoming;
    }
  }

  // Sort buyList: highest shortfall first, then alphabetical by SKU
  buyList.sort((a, b) => b.shortfall - a.shortfall || a.sku.localeCompare(b.sku));
  covered.sort((a, b) => a.sku.localeCompare(b.sku));
  unmatched.sort((a, b) => a.sku.localeCompare(b.sku));

  const summary = {
    jobsCount: jobs.length,
    skusNeeded: demandByKey.size,
    skusToBuy: buyList.length,
    skusCovered: covered.length,
    skusUnmatched: unmatched.length,
    totalDemandPieces,
    totalBuyPieces,
    totalIncomingPieces,
    hasStock,
  };

  return {
    jobs,
    buyList,
    covered,
    unmatched,
    summary,
    hasStock,
    warnings,
    rejected,
  };
}

module.exports = { planHangers };
