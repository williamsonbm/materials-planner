// =============================================================
// hangerCanon.js — supplier/MiTek spelling → the SKU we actually stock.
// =============================================================
// PORT OF `hanger_canon()` in the inventory web app (sql/hanger_schema.sql §0b).
// The two are deliberately kept in step: a mapping added there and not here
// means this planner orders a part the yard already has on the shelf under
// another name. If you add a WHEN there, add an entry here.
//
// WHY THIS EXISTS. MiTek writes Simpson's part numbers on the material sheet.
// We stock TC26 / TC24 in place of Simpson's STC26 / STC24 — same part, our
// supplier's number. Without this fold, a sheet calling for STC26 never matches
// the TC26 sitting in the stock file, the SKU lands as UNMATCHED, and the buyer
// is told to special-order hangers that are already in the building.
//
// SKU IDENTITY ONLY. The spelled-out ply prefixes MiTek uses ("Two H2.5A") are a
// QUANTITY multiplier, not a different part — they change qty, not the SKU
// string, and parseHangerSheet.js already handles them. Do NOT put them here.
//
// Z→2 SPELLING ALIASES. Simpson's ZMAX parts end in "Z". A "Z" keyed as "2"
// makes a phantom SKU that plain uppercasing will NOT merge (Z is not 2).
// H2A2→H2AZ is the live one — in the web app the wrong spelling was found
// holding real on-hand stock. H1A2→H1AZ is a safety net: H1AZ already held the
// baseline there, H1A2 lived only in the retired system, but the same typo is
// one keystroke away.
// =============================================================

"use strict";

// Alias-comparison normalizer. Strips whitespace, dot, slash, backslash, dash
// and the double-quote inch-mark, then uppercases — matching public.norm() in
// the web app, so "STC 26", "S-TC26" and "stc.26" all reach the same entry.
//
// This is DELIBERATELY more aggressive than skuKey() and is used for NOTHING
// but the alias lookup below. skuKey() only uppercases and strips whitespace
// because it has to keep manufacturer product numbers distinct (ITS1.81/14 and
// IUS2.56/11.88 would collapse toward each other under punctuation-stripping).
// Folding one small hand-maintained table under a loose comparison is safe;
// keying the entire catalog that way is not.
const canonNorm = (s) => String(s || '').toUpperCase().replace(/[\s./\\"-]/g, '');

// normalized spelling → { canon, kind }. Keep in sync with hanger_canon().
//
// `kind` exists so the two cases can be REPORTED differently, because they are
// different things and a buyer must not confuse them:
//   'substitution' — a real Simpson part we deliberately replace with our
//                    supplier's equivalent. The buyer is ordering a different
//                    manufacturer's part than the sheet names.
//   'spelling'     — the same part, keyed wrong. Nothing is being substituted.
const ALIASES = new Map([
  [canonNorm('STC26'), { canon: 'TC26', kind: 'substitution' }],
  [canonNorm('STC24'), { canon: 'TC24', kind: 'substitution' }],
  [canonNorm('H1A2'),  { canon: 'H1AZ', kind: 'spelling' }],   // Z→2, safety net
  [canonNorm('H2A2'),  { canon: 'H2AZ', kind: 'spelling' }],   // Z→2, the live one
]);

/**
 * Fold a supplier spelling onto the SKU we stock.
 *
 * Unknown SKUs are returned EXACTLY as given — this is a small closed table, not
 * a guess. Returns the canonical display string (e.g. 'TC26'), not a lookup key;
 * callers still run the result through skuKey() to key it.
 *
 * @param {string} raw  SKU as written on the material sheet or stock export
 * @returns {string}    canonical SKU, or `raw` unchanged when no alias applies
 */
function hangerCanon(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return s;
  const hit = ALIASES.get(canonNorm(s));
  return hit ? hit.canon : s;
}

/**
 * Describe the rewrite hangerCanon would apply, or null when there is none.
 *
 * Lets callers REPORT the fold instead of performing it silently — swapping one
 * manufacturer's part number for another's is something a buyer comparing the
 * plan against the MiTek sheet has every right to see.
 *
 * Returns null when the SKU is unknown OR when it is already written the way we
 * buy it (so a sheet that says TC26 produces no noise).
 *
 * @returns {{ canon: string, kind: 'substitution'|'spelling' } | null}
 */
function aliasOf(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  const hit = ALIASES.get(canonNorm(s));
  if (!hit || hit.canon === s) return null;
  return hit;
}

/** True when hangerCanon(raw) would return something other than `raw`. */
const isAliased = (raw) => aliasOf(raw) !== null;

module.exports = { hangerCanon, aliasOf, isAliased, canonNorm, ALIASES };
