// =============================================================
// parseCsv.js — ported from source-to-port/parseCSV.txt
// (n8n Code Node — Updated 05/25/26 6:25 AM)
// =============================================================
// Parses a MiTek Structure "Material Summary" CSV (EWP only).
//
// Emits ONE header item plus one item per material row:
//
//   Header item (always first):
//     { kind: "header", jobNumber, jobName, deliveryDate,
//       orderDate, customer, productType }
//
//   Material item:
//     { kind: "material", jobNumber, jobName, deliveryDate,
//       category,        // "I-Joist" | "LVL" | "RimBoard" | "Hanger"
//       size,            // full product description, used as grouping key
//       qty,             // integer
//       rawLength,       // "47-05-08" or "" for hangers
//       decimalFeet,     // number, or null for hangers
//       label }          // line label from CSV (e.g. "J48", "1BM7-2")
//
//   If Product != "EWP", returns an empty array (downstream nodes
//   should treat that as "skip this email").
//
// Length format from MiTek: FT-IN-SIXTEENTHS  e.g. 47-05-08
//   = 47 ft + 5 in + 8/16 in
//   = 47 + 5/12 + 8/192  (since 1 sixteenth-of-an-inch = 1/192 ft)
// =============================================================
// PORT: the n8n binary-attachment intake ($input.all(), item.binary,
// this.helpers.getBinaryDataBuffer) is replaced by a plain function
// parseJobCsv(csvText). parseCsv() and parseLength() are kept verbatim.
// The bottom return drops the n8n { json: ... } wrapper.
// =============================================================

function parseJobCsv(csvText) {
  let processedItems = [];

  // ---- Parse with a tiny CSV row splitter that handles quoted commas
  // and escaped doublequotes ("" inside a quoted field).
  // We can't use String.split(',') because fields like
  //   "1 1/8"" x 11 7/8"" APA Rim Board"
  // contain commas and escaped quotes that would corrupt the columns.
  const rows = parseCsv(csvText);

  // ---- Pass 1: Extract header metadata + gate on Product = EWP
  let jobName = "Unknown";
  let jobNumber = "Unknown";
  let deliveryDate = "Unknown";
  let orderDate = "Unknown";
  let customer = "Unknown";
  let productType = "Unknown";

  for (const cols of rows) {
    // Header rows put labels in col 0 OR col 2 (two-column layout)
    if (cols[0] === "Job Name:" && cols[1]) jobName = cols[1];
    if (cols[2] === "Job Number:" && cols[3]) jobNumber = cols[3];
    if (cols[2] === "Product:" && cols[3]) productType = cols[3];
    if (cols[0] === "Order Date:" && cols[1]) orderDate = cols[1];
    if (cols[0] === "Delivery Date:" && cols[1]) deliveryDate = cols[1];
  }

  // Gate: only process EWP material summaries
  if (productType.toUpperCase() !== "EWP") {
    // Skip this CSV entirely — caller should branch on empty output
    return [];
  }

  // Customer = first non-blank line *after* the "Delivery Date:" row
  // and before "Address:" — this captures the sold-to company name.
  let sawDelivery = false;
  for (const cols of rows) {
    if (cols[0] === "Delivery Date:") { sawDelivery = true; continue; }
    if (cols[0] === "Address:") break;
    if (sawDelivery && cols[0] && cols[0].length > 2 && !cols[1]) {
      // Single-token rows like "Some Construction Company,,,,,,,"
      customer = cols[0];
      break;
    }
  }

  // Emit header item
  processedItems.push({
    kind: "header",
    jobNumber,
    jobName,
    deliveryDate,
    orderDate,
    customer,
    productType
  });

  // ---- Pass 2: Walk rows in order, tracking which section we're in.
  let currentCategory = null;
  let sawAnyCategory = false;   // true once we've entered the material region
  const KNOWN_SECTIONS = new Set([
    "I-Shape EWP", "Rectangular EWP", "Rim Board", "Hangers"
  ]);

  for (let r = 0; r < rows.length; r++) {
    const cols = rows[r];
    const firstCol = (cols[0] || "").trim();
    const line = cols.join(",");

    // Section headers: first column has the name, rest blank
    if (firstCol === "I-Shape EWP")     { currentCategory = "I-Joist";  sawAnyCategory = true; continue; }
    if (firstCol === "Rectangular EWP") { currentCategory = "LVL";      sawAnyCategory = true; continue; }
    if (firstCol === "Rim Board")       { currentCategory = "RimBoard"; sawAnyCategory = true; continue; }
    if (firstCol === "Hangers")         { currentCategory = "Hanger";   sawAnyCategory = true; continue; }

    // End of material data — bail out before cost breakdown junk
    if (firstCol === "COST BREAKDOWN WORKSHEET!") break;

    // ---- Unknown section detection
    // After we've seen at least one known section, flag any row that looks
    // like an alphabetic section header (short, no digits/quotes/slashes,
    // doesn't end with ":") followed within 3 rows by a column header row.
    // This catches new MiTek section names like "Glulam" or "PSL" without
    // false-firing on the subsection product-name rows that appear under
    // every section (e.g. '11 7/8" PJI-40').
    if (sawAnyCategory && firstCol && !(cols[1] || "").trim()
        && !KNOWN_SECTIONS.has(firstCol)
        && firstCol.length > 0 && firstCol.length < 30
        && !firstCol.endsWith(":")
        && !/[0-9"\/]/.test(firstCol)
        && !firstCol.startsWith("Total")
        && firstCol !== "LABEL" && firstCol !== "QTY") {
      // Peek forward up to 3 rows to find a column-header row
      let looksLikeSection = false;
      for (let p = r + 1; p < Math.min(r + 4, rows.length); p++) {
        const peekFirst = (rows[p][0] || "").trim();
        if (peekFirst === "LABEL" || peekFirst === "QTY") {
          looksLikeSection = true;
          break;
        }
      }
      if (looksLikeSection) {
        processedItems.push({
          kind: "warning",
          jobNumber, jobName, deliveryDate,
          warningType: "unknown_section",
          detail: `Unrecognized section header in CSV: "${firstCol}"`,
          rawHeader: firstCol
        });
        currentCategory = null;   // ignore rows under this section
        continue;
      }
    }

    // Skip total rows, the "LABEL,SIZE,QTY,LENGTH" repeat headers, and blanks
    if (firstCol.startsWith("Total:") || firstCol.startsWith("Total ")) continue;
    if (firstCol === "LABEL" || firstCol === "QTY") continue;
    if (!currentCategory) continue;

    // ---- Hangers: layout is QTY,TYPE,SIZE,LENGTH (different from others)
    if (currentCategory === "Hanger") {
      const qty  = parseInt(cols[0]);
      const type = (cols[1] || "").trim();   // typically "Hanger"
      const size = (cols[2] || "").trim();   // e.g. "ITS2.56/11.88"
      if (qty > 0 && size && type.toLowerCase().includes("hanger")) {
        processedItems.push({
          kind: "material",
          jobNumber, jobName, deliveryDate,
          category: "Hanger",
          size,
          qty,
          rawLength: "",
          decimalFeet: null,
          label: size
        });
      }
      continue;
    }

    // ---- I-Joist / LVL / RimBoard: layout is LABEL,SIZE,QTY,LENGTH
    const label = firstCol;
    const size  = (cols[1] || "").trim();
    const qty   = parseInt(cols[2]);
    const rawLen = (cols[3] || "").trim();

    // Valid data rows have a length like "47-05-08" and a positive qty
    if (!rawLen.includes("-")) continue;
    if (!qty || qty < 1) continue;
    if (!size) continue;

    const decimalFeet = parseLength(rawLen);
    if (decimalFeet === null) continue;

    processedItems.push({
      kind: "material",
      jobNumber, jobName, deliveryDate,
      category: currentCategory,
      size,                                 // FULL size string — grouping key
      qty,
      rawLength: rawLen,
      decimalFeet,
      label
    });
  }

  return processedItems.map(item => ({ ...item, source: "cuts" }));
}

// =============================================================
// HELPERS
// =============================================================

// Convert "FT-IN-SIXTEENTHS" to decimal feet.
//   "47-05-08"  -> 47 + 5/12 + 8/192 = 47.4583
//   "07-05-08"  -> 7.4583
//   "12-00-00"  -> 12
// Returns null on malformed input.
function parseLength(raw) {
  const parts = raw.split('-');
  if (parts.length !== 3) return null;
  const ft = parseInt(parts[0]);
  const inch = parseInt(parts[1]);
  const sixteenths = parseInt(parts[2]);
  if (isNaN(ft) || isNaN(inch) || isNaN(sixteenths)) return null;
  return parseFloat((ft + inch / 12 + sixteenths / 192).toFixed(4));
}

// Minimal RFC-4180-ish CSV parser.  Handles:
//   - quoted fields containing commas
//   - escaped doublequotes ("")
//   - \r\n and \n line endings
// Returns array of arrays of strings (no trimming — caller trims).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; } // escaped
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ""; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ""; i++; continue; }
    field += c; i++;
  }
  // Flush trailing field/row if the file doesn't end with a newline
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// parseCsv (the row splitter) is exported for readStockCsv.js. The stock CSV
// carries the same booby-trapped item strings as a material summary —
// `"11 7/8"" PJI-40"` — so it needs quote-aware splitting too, and a second
// implementation would be a second thing to get wrong.
module.exports = { parseJobCsv, parseCsv };
