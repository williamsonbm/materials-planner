// =============================================================
// parseHangerSheet.js — PURE parser for the MiTek per-job material sheet (CSV text).
// =============================================================
// No DB access, no normalization (sku_norm is computed by the caller; the parser
// captures sku_display exactly as written). Returns { ok, reason, meta, lines, warnings, errors }.
//
// File shape (verified against spreadsheets/examples/*.csv):
//   - Metadata block: "Label:,value" pairs spread across columns; layout varies by
//     export, so we scan EVERY cell for known labels and take the next cell.
//   - "Hangers" section: a row whose first cell is "Hangers", then (optionally blank
//     rows,) a header row starting with QTY, then data rows until an all-empty row.
//   - Some jobs legitimately have NO Hangers section (e.g. 34182J) → ok:true, 0 lines.
//   - The date-range batch report ("Hangers Needed For,<date>,to,<date>") is NOT a
//     per-job sheet and is REJECTED (no job number → can't join the ledger).
// =============================================================

"use strict";

const { parseCsv } = require('../plates/parseCsv.js');

const clean = (s) => (s == null ? "" : String(s).trim());
const isBlankRow = (r) => !r || r.every((c) => clean(c) === "");

// "4/21/2026" or "12/24/2025" → "2026-04-21" (ISO). Returns null if unparseable/empty.
function toIsoDate(s) {
  const t = clean(s);
  if (!t) return null;
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

// Spelled-out ply words MiTek prefixes on some lines ("One H2.5A", "Two H2.5A"):
// the word is HANGERS PER UNIT. "Two H2.5A" qty 50 ⇒ 100 × H2.5A. Always surfaced
// as a warning so the multiplication is visible in the preview; never silent.
const PLY_WORDS = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5,
                    SIX: 6, SEVEN: 7, EIGHT: 8, NINE: 9, TEN: 10 };
const PLY_RE = /^(one|two|three|four|five|six|seven|eight|nine|ten)\s+(.+)$/i;

// MiTek annotations that are NOT trackable materials — skipped at parse time,
// always with a visible warning (never a silent drop). "NAILED" = site-nailed
// connection; the nails are site-supplied and not inventory.
const IGNORED_SKUS = new Set(["NAILED"]);

function parseHangerSheet(csvText) {
  const rows = parseCsv(String(csvText || ""));
  const meta = {
    job_number: null, job_name: null, delivery_date: null,
    category: null, commit_date: null,
  };
  const lines = [];
  const warnings = [];
  const errors = [];

  // ── Reject the batch/forecast report outright ─────────────────────────────
  const firstCell = clean(rows[0]?.[0] || "").toLowerCase();
  if (firstCell.startsWith("hangers needed for")) {
    return {
      ok: false,
      reason: "This is a date-range batch report (no job number). It is forecast " +
              "input only and cannot be imported as commitments. Use the per-job " +
              "material sheet instead.",
      meta, lines, warnings, errors,
    };
  }

  // ── Metadata: scan every cell for "Label:" and take the cell to its right ──
  let quoteDate = null, orderDate = null;
  for (const r of rows.slice(0, 40)) {
    for (let i = 0; i < r.length; i++) {
      const label = clean(r[i]).replace(/:$/, "").toLowerCase();
      const value = clean(r[i + 1] || "");
      if (!value) continue;
      if (label === "job number")         meta.job_number = value;
      else if (label === "job name")      meta.job_name = value;
      else if (label === "product")       meta.category = value;
      else if (label === "delivery date") meta.delivery_date = toIsoDate(value);
      else if (label === "quote date")    quoteDate = toIsoDate(value);
      else if (label === "order date")    orderDate = toIsoDate(value);
    }
  }
  meta.commit_date = orderDate || quoteDate || null;   // Order Date wins

  if (!meta.job_number) {
    return {
      ok: false,
      reason: "No 'Job Number:' found in the header block — not a per-job material sheet?",
      meta, lines, warnings, errors,
    };
  }

  // ── Material sections: "Hangers" AND "Misc Items" ──────────────────────────
  const sections = [];
  rows.forEach((r, i) => {
    const c = clean(r[0]).toLowerCase();
    if (c === "hangers") sections.push({ at: i, label: "Hangers" });
    else if (/^misc(\.|ellaneous)?\s*items$/.test(c)) sections.push({ at: i, label: "Misc Items" });
  });
  if (sections.length === 0) {
    warnings.push("No 'Hangers' (or 'Misc Items') section in this sheet — importing zero hanger lines for this job.");
    return { ok: true, reason: null, meta, lines, warnings, errors };
  }

  for (const { at, label } of sections) {
    let headerIdx = -1;
    for (let i = at + 1; i < Math.min(at + 6, rows.length); i++) {
      if (clean(rows[i][0]).toLowerCase() === "qty") { headerIdx = i; break; }
    }
    if (headerIdx === -1) {
      if (label === "Hangers") {
        return { ok: false, reason: "Found the 'Hangers' section but no QTY/TYPE/SIZE header row after it — format change?",
                 meta, lines, warnings, errors };
      }
      warnings.push(`Found '${label}' but no QTY header row after it — section skipped (format change?).`);
      continue;
    }
    const header = rows[headerIdx].map((c) => clean(c).toLowerCase());
    const qtyCol  = header.indexOf("qty");
    const sizeCol = header.indexOf("size");   // SIZE carries the SKU
    const typeCol = header.indexOf("type");   // used to tell footer rows from bad data
    if (sizeCol === -1) {
      if (label === "Hangers") {
        return { ok: false, reason: "Hangers header row has no SIZE column — format change?", meta, lines, warnings, errors };
      }
      warnings.push(`'${label}' header row has no SIZE column — section skipped.`);
      continue;
    }

    let sectionCount = 0;
    for (let i = headerIdx + 1; i < rows.length; i++) {
      const r = rows[i];
      if (isBlankRow(r)) break;
      const rawQty = clean(r[qtyCol]);
      let sku      = clean(r[sizeCol]);
      const seq    = lines.length + 1;

      if (!sku && !rawQty) continue;            // stray formatting row inside section

      // Terminate section cleanly on Total footer
      if (/^total\b/i.test(rawQty) || /^total\b/i.test(sku)) break;

      // Repeated QTY/TYPE/SIZE header
      if (rawQty.toLowerCase() === "qty") continue;

      if (!sku) { errors.push({ rowIndex: i + 1, reason: "no SIZE (SKU) value", raw: r.join(",") }); continue; }
      const qtyStr = rawQty.replace(/,/g, "");
      let qty = parseInt(qtyStr, 10);
      if (!Number.isFinite(qty) || String(qty) !== qtyStr.replace(/^0+(?=\d)/, "") || qty <= 0) {
        if (typeCol !== -1 && clean(r[typeCol]).toLowerCase() !== "hanger") {
          warnings.push(`Stopped reading the ${label} section at row ${i + 1} (foreign row: "${r.slice(0, 4).join(",")}"). If real lines exist below this row, the format changed — flag it.`);
          break;
        }
        errors.push({ rowIndex: i + 1, reason: `QTY not a positive integer: "${rawQty}"`, raw: r.join(",") });
        continue;
      }
      if (IGNORED_SKUS.has(sku.toUpperCase())) {
        warnings.push(`Row ${i + 1}: "${sku}" ×${qty} skipped — not a tracked material (site-supplied).`);
        continue;
      }
      const ply = PLY_RE.exec(sku);
      if (ply) {
        const mult = PLY_WORDS[ply[1].toUpperCase()];
        const baseSku = clean(ply[2]);
        warnings.push(
          `Row ${i + 1}: "${sku}" ×${qty} → ${qty * mult} × ${baseSku} ` +
          `(ply word "${ply[1]}" = ${mult} hanger${mult > 1 ? "s" : ""} per unit).`
        );
        qty *= mult;
        sku = baseSku;
      }
      if (label === "Hangers" && /\s/.test(sku)) {
        warnings.push(
          `Row ${i + 1}: SKU "${sku}" contains a space — possibly an unrecognized ` +
          `count-word prefix, which would make the QUANTITY wrong. Imported AS ` +
          `WRITTEN; verify before trusting this line.`
        );
        // Deliberately does NOT predict what the SKU will match. This parser
        // knows nothing about hangerCanon, which folds spacing variants like
        // "STC 26" onto TC26 downstream — a warning promising "it will show
        // UNMATCHED" was wrong the moment that landed. The quantity risk is the
        // real reason to look at this row.
      }
      if (label === "Misc Items") {
        lines.push({ seq, qty, sku, section: label, mtype: typeCol !== -1 ? clean(r[typeCol]) : "" });
      } else {
        lines.push({ seq, qty, sku, section: label });
      }
      sectionCount++;
    }
    if (label === "Misc Items" && sectionCount) {
      warnings.push(`${sectionCount} line(s) ingested from the '${label}' section — the CMS doesn't class these as hangers; unknown SKUs land as special-order.`);
    }
  }

  if (lines.length === 0 && errors.length === 0) {
    warnings.push("Material sections present but contained no data rows.");
  }

  return { ok: true, reason: null, meta, lines, warnings, errors };
}

module.exports = { parseHangerSheet };
