// =============================================================
// readHangerStockCsv.js — hanger on-hand CSV → { sku, available, ... }
// =============================================================
// The hanger planner's stock reader: reads the inventory snapshot.
//
// Shared inventory principles (same as Plates):
//   * Header recognized by name, not fixed column indices.
//   * Prefer `available` over `on_hand` (`available = on_hand - committed`).
//   * Carry negatives through in `availableRaw` and clamp to 0 in `available`.
//   * `incoming` is parsed and carried through for buyer visibility.
//   * Skip non-numeric / subtotal rows.
// =============================================================

"use strict";

const { parseCsv } = require('../plates/parseCsv.js');
const { hangerCanon } = require('./hangerCanon.js');

const SKU_COLS = ['sku', 'sku_display', 'item', 'product', 'description', 'part'];
const QTY_COLS = ['available', 'qty', 'quantity', 'on_hand', 'onhand'];
const ONHAND_COLS = ['on_hand', 'onhand'];
const COMMITTED_COLS = ['committed'];
const INCOMING_COLS = ['incoming'];
const THRESHOLD_COLS = ['threshold', 'min', 'minimum'];
const COUNTED_COLS = ['last_counted', 'counted_at', 'last_count'];

const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '_');

/**
 * Canonical SKU lookup key.
 * Normalizes case and whitespace while preserving manufacturer product numbers
 * (like ITS1.81/14, HGUS210-2, H2.5A).
 *
 * Runs hangerCanon() FIRST so supplier spellings key to the SKU we stock: a job
 * sheet's STC26 and a stock file's TC26 must produce the same key or the demand
 * lands UNMATCHED and the buyer special-orders parts already on the shelf. Both
 * sides of the match go through here, so folding it in at this one point covers
 * demand and inventory together.
 *
 * Deliberately keeps its own loose-but-not-too-loose normalization: uppercase
 * and strip whitespace only. The heavier punctuation-stripping lives inside
 * hangerCanon and applies to the alias table alone — see the note there.
 */
function skuKey(raw) {
  return hangerCanon(String(raw || '').trim()).toUpperCase().replace(/\s+/g, '');
}

/**
 * Sniff whether a CSV text looks like a Hanger stock file.
 */
function looksLikeHangerStockCsv(text) {
  if (typeof text !== 'string') return false;
  const firstKb = text.slice(0, 1024);
  const rows = parseCsv(firstKb);
  if (!rows || rows.length < 2) return false;

  const header = rows[0].map(norm);
  const hasSku = SKU_COLS.some((c) => header.includes(c));
  const hasQty = QTY_COLS.some((c) => header.includes(c));
  const hasSpan = header.includes('span') || header.includes('length');

  // If it has a span/length column, it's an EWP stock file, not hangers
  if (hasSpan) return false;

  // If it doesn't have SKU and QTY, it's not a stock file
  if (!hasSku || !hasQty) return false;

  // Sniff content in the first few data rows: check for common hanger prefixes
  // (ITS, IUS, HUS, HGUS, THA, LUS, LU, H2.5A, LRU, etc.) vs plates (MT20, MT18, etc.)
  const sampleText = rows.slice(1, 10).map((r) => r.join(' ')).join(' ').toUpperCase();
  // STC24/STC26 are listed separately from TC24/TC26 on purpose: \b will not
  // match TC24 inside STC24 (the preceding S is a word character), so a stock
  // file written in Simpson's spelling would sniff as "not hangers" without them.
  const hasHangerHints = /\b(ITS|IUS|HUS|HGUS|THA|LUS|LU|H2\.5A|LRU|LSSR|LSSU|TC24|TC26|STC24|STC26|VPA2|MIU|BA)\b/.test(sampleText);
  const hasPlateHints = /\b(MT20|MT18|M20|M18|MP20|MP14|G20)\b/.test(sampleText);

  if (hasPlateHints && !hasHangerHints) return false;
  return true;
}

/**
 * Parse a hanger stock CSV text.
 * Returns { byKey, rows, warnings }.
 */
function parseHangerStockCsv(text) {
  const rows = parseCsv(String(text || ''));
  if (!rows.length) {
    throw new Error('Stock CSV is empty.');
  }

  // Find header row
  let headerIdx = -1;
  let header = null;
  let skuCol = -1, availCol = -1, onhandCol = -1, commCol = -1, incCol = -1, threshCol = -1;

  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const r = rows[i].map(norm);
    const s = SKU_COLS.find((c) => r.includes(c));
    const q = QTY_COLS.find((c) => r.includes(c));
    if (s && q) {
      headerIdx = i;
      header = r;
      skuCol = r.indexOf(s);
      availCol = r.indexOf(q);
      break;
    }
  }

  if (headerIdx === -1) {
    throw new Error('Stock CSV has no recognizable SKU / QTY header row.');
  }

  for (const c of ONHAND_COLS) {
    const idx = header.indexOf(c);
    if (idx !== -1) { onhandCol = idx; break; }
  }
  for (const c of COMMITTED_COLS) {
    const idx = header.indexOf(c);
    if (idx !== -1) { commCol = idx; break; }
  }
  for (const c of INCOMING_COLS) {
    const idx = header.indexOf(c);
    if (idx !== -1) { incCol = idx; break; }
  }
  for (const c of THRESHOLD_COLS) {
    const idx = header.indexOf(c);
    if (idx !== -1) { threshCol = idx; break; }
  }

  const byKey = new Map();
  const parsedRows = [];
  const warnings = [];

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.every((c) => !String(c).trim())) continue;

    const rawSku = String(row[skuCol] || '').trim();
    if (!rawSku || /^total\b/i.test(rawSku)) continue;

    const key = skuKey(rawSku);
    if (!key) continue;

    const rawAvail = String(row[availCol] || '').replace(/,/g, '').trim();
    const parsedAvail = parseFloat(rawAvail);
    if (!Number.isFinite(parsedAvail)) continue;

    const onHand = onhandCol !== -1 ? parseFloat(String(row[onhandCol] || '').replace(/,/g, '')) || 0 : parsedAvail;
    const committed = commCol !== -1 ? parseFloat(String(row[commCol] || '').replace(/,/g, '')) || 0 : 0;
    const incoming = incCol !== -1 ? parseFloat(String(row[incCol] || '').replace(/,/g, '')) || 0 : 0;
    const threshold = threshCol !== -1 ? parseFloat(String(row[threshCol] || '').replace(/,/g, '')) || 0 : 0;

    const item = {
      sku: rawSku,
      key,
      availableRaw: parsedAvail,
      available: Math.max(0, parsedAvail),
      onHand,
      committed,
      incoming,
      threshold,
      rowIndex: i + 1,
    };

    if (byKey.has(key)) {
      warnings.push(`Duplicate stock row for SKU "${rawSku}" at line ${i + 1}; subsequent row ignored.`);
    } else {
      byKey.set(key, item);
      parsedRows.push(item);
    }
  }

  return { byKey, rows: parsedRows, warnings };
}

module.exports = {
  skuKey,
  looksLikeHangerStockCsv,
  parseHangerStockCsv,
};
