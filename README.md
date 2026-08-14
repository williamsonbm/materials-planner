# Materials Purchase Planner

Decides **which stock lengths to order** for a batch of EWP jobs and **how many truss plates to buy** across multiple truss designs.

```bash
npm install          # one dependency: express
npm start            # → http://localhost:3000
```

- **EWP Planner (`/`)**: Drop in one or more MiTek "Material Summary" CSVs, set how many distinct lengths you're willing to put on a PO, and it reports the lengths to buy, the quantities, and a per-board cut list. Add an EWP stock list to net the order against what's already in the yard.
- **Truss Plate Planner (`/plates`)**: Drop in material summary CSVs along with an inventory plate stock export. It calculates total plate shortfall across all jobs and rounds up to vendor-pack or pallet order quantities.

**No database, no `.env`, no external network at runtime.** Once `npm install` has run, it works fully disconnected.

---

### Running it locally (Windows 11 / macOS / Linux)

```powershell
winget install OpenJS.NodeJS.LTS          # skip if `node -v` already prints v18+
git clone https://github.com/williamsonbm/ewp-planner.git
cd ewp-planner
npm install                                # once. Needs internet; nothing after this does.
npm start
```

Then open **http://localhost:3000** (or `http://127.0.0.1:3000`) in your browser. The terminal window runs the local server; press `Ctrl-C` to stop it.

---

## 1. EWP Purchase Planner

### The question it answers

The cut optimizer asks *"given these allowed stock lengths, how do I cut them?"*. The EWP planner asks the inverse:

> *"I'll order at most N distinct stock lengths for these jobs — which N do I buy?"*

It also answers the question behind that one — **how many lengths are worth buying at all** — by running N = 1…max and showing where the waste curve flattens:

| Lengths allowed | Best set | I-Joist waste |
|---|---|---|
| 1 | 36′ | 68 ft |
| **2** | **36′, 32′** | **0 ft** |
| 3–5 | 36′, 32′, 28′… | 0 ft |

For that job (`33844J`), lengths 3 through 5 buy you nothing. Two lengths is the optimal answer.

### Waste vs drops

- **True waste** — material lost as unusable offcuts.
- **Recoverable drops** — LVL offcuts at or above the drop threshold (default 8′) that go back on the rack. The engine costs these at **zero**.

If your shop does *not* reuse drops, raise the drop threshold in the UI to reclassify them as true waste.

### Stock on hand (Optional second CSV)

Drop an inventory stock list in the second zone and the order is netted against the yard:
- The buy list gains **if bought new / covered by stock / buy**.
- A summary card displays what shipping the batch does to each stock line, flagging any that end below their reorder threshold.
- Quantity comes from **`available`** (on hand minus committed) when available in the CSV.

**The length search itself stays stock-blind.** It answers "which lengths should I put on a PO", and that answer shouldn't move because the yard was full the week you asked. Stock is applied *after*, by re-packing the recommendation with the yard available.

### Pools are per PRODUCT, not per depth

`11 7/8" PJI-40` and `11 7/8" TJI 560` share a depth but are different SKUs that can be stocked in different lengths. Purchasable lengths are set **per product**, each product gets its own length budget, and each gets its own recommendation.

---

## 2. Truss Plate Planner (`/plates`)

The Plate Planner consolidates plate requirements across all jobs and determines purchase quantities:
- Aggregates plate demand across all dropped material summary CSVs.
- Compares demand against on-hand / available inventory.
- Converts shortfall into orderable vendor units (boxes, banded packs, pallets) using standard pack factors.
- Provides interactive drill-down showing exactly which jobs and quantities contribute to each plate SKU's demand.

---

## Project Structure

```
src/planner/     server.js, planner.html, plates.html   — local server and UI pages
src/ewp/         optimizeCuts.js                       — EWP packing engine
                 selectStockLengths.js                 — search over length sets
                 applyStock.js                         — nets EWP plan against on-hand stock
                 readStockCsv.js                       — stock CSV → engine inventory items
                 cutListModel.js                       — board grouping
                 inventoryImpact.js                    — stock depletion report
                 parseCsv.js, extractDepth.js, normalizeSize.js, dbAdapters.js
src/plates/      planPlates.js                         — plate demand aggregation and shortfall calculator
                 readPlateStockCsv.js                  — plate stock CSV parser
                 parsePlateSummary.js                  — MiTek plate summary parser
                 packFactors.json                      — packaging conversions (boxes, packs, pallets)
public/          cutList.js, cutList.css               — per-board cut diagrams
test/            test suites (run with `npm test`)
```

## Running Tests

```bash
npm test
```
All unit and integration tests run natively with the Node.js test runner (`node --test`).
