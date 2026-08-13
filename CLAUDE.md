# EWP Purchase Planner

Standalone offline tool. Drop in one or more MiTek "Material Summary" CSVs, say how many
distinct stock lengths you're willing to order, and get back the length sets that minimise
what you have to buy.

```
npm install && npm run planner    # → http://127.0.0.1:5178
npm test                          # → 94 tests, node:test, no framework
```

## Hard constraints — do not break these

- **No database.** No `pg`, no `dotenv`, no reaching into the parent web app.
  `src/planner/server.js` stays DB-free: this is a laptop tool, not a service.
- **One runtime dependency (`express`).** Do not add packages. If something seems to need a
  parser or a spreadsheet reader, write it or reuse `src/ewp/parseCsv.js`.
- **Localhost only.** The server binds `127.0.0.1` deliberately — there is no auth layer.

## Shared engine — edit with care

`src/ewp/optimizeCuts.js` and its helpers are ported from the hanger web app and kept
byte-identical on purpose. The packing behaviour is regression-locked over there. Change
them only deliberately; silent drift between the two copies causes real bugs.

## This repo is PUBLIC

- **No identifiable company information in anything committed** — company names, staff
  names, customer businesses, street addresses, phone numbers.
- New job material CSVs take the **`-scrubbed.csv`** suffix; wholly fabricated files take
  **`-synthetic.csv`**. Real-but-cleaned and invented are different things.
- **Never commit a raw MiTek export.** `.gitignore` guards `*-raw.csv`, `*-unscrubbed.csv`
  and `samples/` — a safety net, not a substitute for checking.
- Fixtures belong in `test/ewp-fixtures/` (pinned to LF), never `samples/` (gitignored).

## Working on on-hand stock / inventory?

If `docs/inventory-feature-brief.md` exists in your checkout, read it first — it explains the
design and the landmines. That folder is gitignored, so it is not in a fresh clone; the
summary below is self-contained. The feature is **built**; the shape of it is:

- `src/ewp/readStockCsv.js` — stock CSV → engine inventory items. Columns are found by
  header name, so both the wide export (`available`) and a hand-written
  `item,span,qty,threshold` load. Quantity comes from `available` (on hand minus committed).
- `src/ewp/applyStock.js` — the second engine pass. **The length search stays greenfield**:
  stock is applied to the lengths it already chose, never fed into the ranking. Change that
  and reported waste becomes stock-dependent, so two runs a week apart stop being comparable.
- Two rules worth not rediscovering: merge real stock **with** the zero-qty stubs (never
  substitute, or a size with no stock row trips `no_inventory_match`), and
  `stockPieceNumber` restarts at 0 in every `optimizeCuts` call, so `inventoryImpact` must be
  called once per pass, never over concatenated passes.
