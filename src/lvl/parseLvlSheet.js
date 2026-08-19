// =============================================================
// parseLvlSheet.js — PURE parser for the LVL ("Rectangular EWP") section of a
// MiTek Material Summary CSV.
// =============================================================
// Deliberately NOT parseJobCsv (src/ewp/parseCsv.js). That parser gates the
// ENTIRE file on `Product: EWP`, which is correct for the EWP cut-optimization
// tab (a Roof or Floor job's incidental LVL beam isn't a batch that tab should
// plan lengths for) but wrong here: a real "Product: Roof" or "Product: Floor"
// job can still carry a Rectangular EWP section with real LVL beams that need
// to be counted. Rejecting the whole file would make those beams invisible.
//
// So this is its own small, focused parser — same pattern as
// src/hangers/parseHangerSheet.js (a per-feature parser, not a repurposed one)
// — that walks every row for section markers and pulls out LVL rows only,
// regardless of the header's Product value. It reuses the shared row-splitter
// and length-decoder (parseCsv, parseLength) from src/ewp/parseCsv.js rather
// than re-deriving the CSV-quoting or FT-IN-SIXTEENTHS logic a second time.
//
// Returns { ok, reason, meta, items, warnings }.
//   meta:  { jobNumber, jobName, deliveryDate, productType }
//   items: [{ size, qty, decimalFeet, rawLength, label }]  — LVL rows only
// =============================================================

"use strict";

const { parseCsv, parseLength } = require('../ewp/parseCsv.js');

function parseLvlSheet(csvText) {
  const rows = parseCsv(String(csvText || ''));
  const warnings = [];

  // ---- Header metadata — same column positions as parseJobCsv, no gate ----
  let jobName = 'Unknown';
  let jobNumber = 'Unknown';
  let deliveryDate = 'Unknown';
  let productType = 'Unknown';

  for (const cols of rows) {
    if (cols[0] === 'Job Name:' && cols[1]) jobName = cols[1];
    if (cols[2] === 'Job Number:' && cols[3]) jobNumber = cols[3];
    if (cols[2] === 'Product:' && cols[3]) productType = cols[3];
    if (cols[0] === 'Delivery Date:' && cols[1]) deliveryDate = cols[1];
  }

  const meta = { jobNumber, jobName, deliveryDate, productType };

  if (jobNumber === 'Unknown') {
    return {
      ok: false,
      reason: 'No "Job Number:" found in the header block — not a Material Summary CSV?',
      meta, items: [], warnings,
    };
  }

  if (productType !== 'Unknown' && productType.toUpperCase() !== 'EWP') {
    warnings.push(
      `[${jobNumber}] Product is "${productType}", not EWP — reading its Rectangular EWP section anyway.`
    );
  }

  // ---- Walk rows, tracking section, capturing LVL ("Rectangular EWP") only ----
  let currentCategory = null;
  const items = [];

  for (const cols of rows) {
    const firstCol = (cols[0] || '').trim();

    if (firstCol === 'I-Shape EWP')     { currentCategory = 'I-Joist';  continue; }
    if (firstCol === 'Rectangular EWP') { currentCategory = 'LVL';      continue; }
    if (firstCol === 'Rim Board')       { currentCategory = 'RimBoard'; continue; }
    if (firstCol === 'Hangers')         { currentCategory = 'Hanger';   continue; }
    if (firstCol === 'COST BREAKDOWN WORKSHEET!') break;

    if (firstCol.startsWith('Total:') || firstCol.startsWith('Total ')) continue;
    if (firstCol === 'LABEL' || firstCol === 'QTY') continue;
    if (currentCategory !== 'LVL') continue;

    // LABEL,SIZE,QTY,LENGTH
    const label = firstCol;
    const size = (cols[1] || '').trim();
    const qty = parseInt(cols[2]);
    const rawLength = (cols[3] || '').trim();

    if (!rawLength.includes('-')) continue;
    if (!qty || qty < 1) continue;
    if (!size) continue;

    const decimalFeet = parseLength(rawLength);
    if (decimalFeet === null) continue;

    items.push({ label, size, qty, rawLength, decimalFeet });
  }

  if (!items.length) {
    warnings.push(`[${jobNumber}] No LVL rows found (no "Rectangular EWP" section, or it was empty).`);
  }

  return { ok: true, reason: null, meta, items, warnings };
}

module.exports = { parseLvlSheet };
