// =============================================================
// detectWarnings.js — ported from source-to-port/detectWarnings.txt
// (job gate)
// =============================================================
// INPUT: full optimizeCuts output stream (headers, warnings, hangers,
// cut plan, summary).
//
// BEHAVIOR:
//   - Warnings present  → block the whole job. Returns
//       { blocked: true, alert: { kind:"slack_alert", ...grouped warnings } }.
//     No committed rows are produced (same semantics as the live workflow:
//     downstream shapeCommittedRows receives nothing).
//   - No warnings       → { blocked: false, items } passthrough.
// =============================================================
// PORT: `const items = $input.all().map(i => i.json);` is now a function
// parameter; the n8n return-maps are replaced by a discriminated-union return
// the GUI/pipeline branches on. Grouping logic is unchanged.
// =============================================================

function detectWarnings(items, opts = {}) {
  const onHandOnly = opts.mode === 'on-hand' || opts.onHandOnly === true;
  const allWarnings = items.filter(i => i.kind === "warning");

  // On-hand-only mode: "unfulfillable_cut" is the EXPECTED shortfall (the pieces
  // you'd have to buy), not a reason to block. Split it out; every other warning
  // type (cut_exceeds_max_stock, no_inventory_match, depth_extraction_failed,
  // parse warnings) still blocks. Allow-buy mode blocks on ALL warnings.
  const shortfall = onHandOnly
    ? allWarnings.filter(w => w.warningType === "unfulfillable_cut")
    : [];
  const warnings = onHandOnly
    ? allWarnings.filter(w => w.warningType !== "unfulfillable_cut")
    : allWarnings;

  if (warnings.length === 0) {
    // Pass through unchanged
    return { blocked: false, items, shortfall };
  }

  // ---- Warnings present — block the job
  // Pull job metadata from the first available source (header, warning, or
  // any item that carries jobNumber). Defensive in case the header was lost
  // upstream — we still want a meaningful alert.
  const header = items.find(i => i.kind === "header") || {};
  const anyJobInfo = items.find(i => i.jobNumber) || {};
  const jobNumber    = header.jobNumber    || anyJobInfo.jobNumber    || "Unknown";
  const jobName      = header.jobName      || anyJobInfo.jobName      || "Unknown";
  const deliveryDate = header.deliveryDate || anyJobInfo.deliveryDate || "Unknown";

  // Group warnings by (category | size) so a single broken product that
  // triggered multiple warnings reads as one issue rather than N. Warnings
  // that don't have a category/size (e.g. unknown_section) live in their
  // own group keyed by warningType.
  const groups = new Map();
  for (const w of warnings) {
    const key = (w.category && w.size)
      ? `${w.category}|${w.size}`
      : `__${w.warningType}__`;
    if (!groups.has(key)) {
      groups.set(key, {
        category: w.category || null,
        size: w.size || null,
        warnings: []
      });
    }
    groups.get(key).warnings.push(w);
  }

  return {
    blocked: true,
    alert: {
      kind: "slack_alert",
      jobNumber,
      jobName,
      deliveryDate,
      warningCount: warnings.length,
      groupCount: groups.size,
      groups: Array.from(groups.values()),
      // Raw warnings preserved for debugging / future Block Kit upgrade
      rawWarnings: warnings
    },
    shortfall
  };
}

module.exports = { detectWarnings };
