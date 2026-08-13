// =============================================================
// parseCsv.js - RFC4180-ish CSV splitter.
// =============================================================
// COPIED VERBATIM from the inventory app: hanger-web-app/src/parseHangerSheet.js
// (lines 17-38, 2026-08-13). parsePlateSummary.js was written and golden-tested
// against THIS splitter, so it ships with it rather than being re-pointed at
// src/ewp/parseCsv.js. The two differ in edge cases (trailing-field handling,
// bare CR); swapping them would silently change what a real MiTek export parses
// to, and the plate parser has passing golden tests only against this one.
//
// If they are ever unified, re-run test/plates.test.js against the real samples
// FIRST - the failure mode is a quietly wrong quantity, not an exception.
// =============================================================

function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

module.exports = { parseCsv };
