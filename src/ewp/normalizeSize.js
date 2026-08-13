// =============================================================
// normalizeSize — SHARED module (single source of truth)
// =============================================================
// Moved byte-for-byte out of optimizeCuts so the inventory-impact report
// attributes committed cuts back to inventory lines using EXACTLY the same
// match key the optimizer used (normalizeSize(item) + span). Same rationale
// as extractDepth.js — one copy, no drift.
//
// Strips noise tokens so CSV sizes and inventory item strings compare equal:
// CSV may emit "2.1 RigidLam DF LVL 1-3/4 x 11-7/8" while inventory has
// "2.1 RigidLam LVL 1-3/4 x 11-7/8".
// =============================================================

function normalizeSize(s) {
  if (!s) return "";
  return s
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\bdf\b/g, "")        // strip "DF" (Douglas Fir designator)
    .replace(/\b2\.1\b/g, "")      // strip "2.1" grade prefix
    .replace(/\s+/g, " ")          // re-collapse after strips
    .trim();
}

module.exports = { normalizeSize };
