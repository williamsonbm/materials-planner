// parsePlateSummary.js — PURE parser for the PLATE SUMMARY section of the MiTek
// per-job material sheet (the same CSV the hanger import reads — §4a fan-out:
// one drop, multiple material ledgers). No DB access, no normalization
// (sku_norm is computed by the database). Returns { meta, lines, warnings, errors }.
//
// Section shape (verified against samples/33864R-materials.csv and the real
// 32552F full export):
//   PLATE SUMMARY
//   SKU,QUANTITY,SIZE-GAUGE,WEIGHT,SQ. INCHES[,UNIT COST,TOTAL]
//   (blank row)
//   ,930,MT20  1.5x4,64.18,5580          ← SKU col empty; SIZE-GAUGE carries the SKU
//   ,"1,576",MT20  1.5x3,...             ← thousands commas in QUANTITY
//   ,"6,052",,752.69,...                 ← subtotal rows have NO size-gauge → skipped
//   Rectangular EWP / Hangers / Total…   ← next section or footer = terminator
// Some jobs legitimately have NO plate section → ok:true, 0 lines.

"use strict";

const { parseCsv } = require("./parseCsv");

const clean = (s) => (s == null ? "" : String(s).trim());
const isBlankRow = (r) => !r || r.every((c) => clean(c) === "");

function toIsoDate(s) {
  const t = clean(s);
  if (!t) return null;
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

function parsePlateSummary(csvText) {
  const rows = parseCsv(String(csvText || ""));
  const meta = { job_number: null, job_name: null, delivery_date: null, category: null, commit_date: null };
  const lines = [];
  const warnings = [];
  const errors = [];

  // Same metadata scan as the hanger parser (labels scattered across columns).
  let quoteDate = null, orderDate = null;
  for (const r of rows.slice(0, 40)) {
    for (let i = 0; i < r.length; i++) {
      const label = clean(r[i]).replace(/:$/, "").toLowerCase();
      const value = clean(r[i + 1] || "");
      if (!value) continue;
      if (label === "job number")        meta.job_number = value;
      else if (label === "job name")      meta.job_name = value;
      else if (label === "product")       meta.category = value;
      else if (label === "delivery date") meta.delivery_date = toIsoDate(value);
      else if (label === "quote date")    quoteDate = toIsoDate(value);
      else if (label === "order date")    orderDate = toIsoDate(value);
    }
  }
  meta.commit_date = orderDate || quoteDate || null;

  if (!meta.job_number) {
    return { ok: false, reason: "No 'Job Number:' found in the header block — not a per-job material sheet?",
             meta, lines, warnings, errors };
  }

  const sectionIdx = rows.findIndex((r) => clean(r[0]).toLowerCase() === "plate summary");
  if (sectionIdx === -1) {
    warnings.push("No 'PLATE SUMMARY' section in this sheet — zero plate lines for this job.");
    return { ok: true, reason: null, meta, lines, warnings, errors };
  }

  // Header row (contains QUANTITY and SIZE-GAUGE) within the next few rows.
  let headerIdx = -1;
  for (let i = sectionIdx + 1; i < Math.min(sectionIdx + 6, rows.length); i++) {
    const h = rows[i].map((c) => clean(c).toLowerCase());
    if (h.includes("quantity") && h.includes("size-gauge")) { headerIdx = i; break; }
  }
  if (headerIdx === -1) {
    return { ok: false, reason: "Found 'PLATE SUMMARY' but no QUANTITY/SIZE-GAUGE header row after it — format change?",
             meta, lines, warnings, errors };
  }
  const header  = rows[headerIdx].map((c) => clean(c).toLowerCase());
  const qtyCol  = header.indexOf("quantity");
  const sizeCol = header.indexOf("size-gauge");

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (isBlankRow(r)) continue;               // pre-data spacer rows are normal
    const first  = clean(r[0]);
    const rawQty = clean(r[qtyCol]);
    const sku    = clean(r[sizeCol]);

    // Footer / next-section terminators.
    if (/^total\b/i.test(first) || /^total\b/i.test(rawQty) || /^total\b/i.test(sku)) break;
    if (first && !rawQty && !sku) break;        // "Rectangular EWP", "Hangers", …

    if (!sku && rawQty) continue;               // subtotal rows (qty, no size-gauge)
    if (!sku && !rawQty) continue;

    const qtyStr = rawQty.replace(/,/g, "");
    const qty = parseInt(qtyStr, 10);
    if (!Number.isFinite(qty) || String(qty) !== qtyStr.replace(/^0+(?=\d)/, "") || qty <= 0) {
      errors.push({ rowIndex: i + 1, reason: `QUANTITY not a positive integer: "${rawQty}"`, raw: r.join(",") });
      continue;
    }
    lines.push({ seq: lines.length + 1, qty, sku });
  }

  if (lines.length === 0 && errors.length === 0) {
    warnings.push("PLATE SUMMARY present but contained no data rows.");
  }
  return { ok: true, reason: null, meta, lines, warnings, errors };
}

module.exports = { parsePlateSummary };
