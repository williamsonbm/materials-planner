// =============================================================
// extractDepth — SHARED module (single source of truth)
// =============================================================
// Ported byte-for-byte from the identical extractDepth helpers that lived
// in BOTH optimizeCuts.txt and shapeCommittedRows.txt (an intentional n8n
// "drift canary"). Extracting it to one module makes drift structurally
// impossible — there is now exactly one copy and one KNOWN_DEPTHS list,
// imported by both optimizeCuts.js and shapeCommittedRows.js.
//
// The function body is unchanged from the verified n8n source. The signature
// is (size, category): the optimizer's pre-flight calls it as extractDepth(size)
// (category undefined — unused by the body), shapeCommittedRows calls it as
// extractDepth(size, category). Both work against the same body.
//
// 22 and 24 ARE real stock depths (ewp-actual-inventory.xlsx has populated
// "22" and "24" depth tabs), so they are included here — otherwise any 22/24
// cut would be flagged depth_extraction_failed and BLOCK the job (gotcha #1).
// =============================================================

const KNOWN_DEPTHS = ["9-12", "11-78", "14", "16", "18", "20", "22", "24"];

// Extract the depth designator (matching the inventory sheet name) from
// a size string. Strategy: scan for any dimension token in the string
// and convert it to sheet-name format; if it matches a known depth, use
// it. Returns "" if no match (caller should treat as error).
//
// Examples:
//   ("11 7/8\" PJI-40", "I-Joist")                          -> "11-78"
//   ("9 1/2\" PJI-40", "I-Joist")                           -> "9-12"
//   ("14\" PJI-40", "I-Joist")                              -> "14"
//   ("2.1 RigidLam DF LVL 1-3/4 x 9-1/2", "LVL")            -> "9-12"
//   ("2.1 RigidLam DF LVL 1-3/4 x 11-7/8", "LVL")           -> "11-78"
//   ("2.1 RigidLam DF LVL 1-3/4 x 14", "LVL")               -> "14"
//   ("1 1/8\" x 11 7/8\" APA Rim Board", "RimBoard")        -> "11-78"
//   ("1 1/8\" x 9 1/2\" APA Rim Board", "RimBoard")         -> "9-12"
function extractDepth(size, category) {
  if (!size) return "";

  // Normalize: lowercase, strip quotes, collapse whitespace
  const s = size.toLowerCase().replace(/["]/g, "").replace(/\s+/g, " ").trim();

  // Find all candidate dimension tokens in the string. A dimension can be:
  //   integer:   "14"
  //   fraction:  "9 1/2"  or  "11 7/8"
  //   hyphenated: "9-1/2"  or  "11-7/8"
  //
  // We collect every candidate, convert to sheet-name format, and pick
  // the LARGEST one that matches a known depth.  Largest because
  // RimBoard's "1 1/8" thickness should never be picked over its "11 7/8"
  // depth, and joist nominal "1-3/4" thickness on LVL should never be
  // picked over "9-1/2" or "11-7/8".
  const candidates = [];

  // Match patterns like "11 7/8", "9 1/2", "11-7/8", "9-1/2"
  const fractionRe = /(\d+)[\s-](\d+)\/(\d+)/g;
  let m;
  while ((m = fractionRe.exec(s)) !== null) {
    const whole = parseInt(m[1]);
    const num   = parseInt(m[2]);
    const den   = parseInt(m[3]);
    // Convert "11 7/8" → "11-78"  (sheet uses concatenated numerator+denom
    // for non-half fractions, and "9-12" for "9 1/2")
    const sheetForm = `${whole}-${num}${den}`;
    candidates.push({ value: whole + num / den, sheetForm });
  }

  // Match standalone integers (e.g. "14", "16", "20") — but avoid matching
  // the integer parts already consumed by fractions, and avoid spurious
  // matches like "1-3/4" (thickness) or single-digit nominals.
  // Strategy: after removing all fraction patterns, look for remaining
  // integer tokens.
  const sStripped = s.replace(fractionRe, " ");
  const intRe = /\b(\d+)\b/g;
  while ((m = intRe.exec(sStripped)) !== null) {
    const n = parseInt(m[1]);
    if (n >= 9 && n <= 24) {
      // Reasonable depth range; skip 1, 2, 3, 4 (thickness/grade numbers)
      candidates.push({ value: n, sheetForm: String(n) });
    }
  }

  // Pick the largest candidate that matches a known depth
  candidates.sort((a, b) => b.value - a.value);
  for (const c of candidates) {
    if (KNOWN_DEPTHS.includes(c.sheetForm)) return c.sheetForm;
  }

  return "";
}

module.exports = { extractDepth, KNOWN_DEPTHS };
