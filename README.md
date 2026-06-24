# Lone Star Tan — Month-End Inventory Adjustment Form (web)

A structured web replacement for the 6-page PDF "Month End Inventory Adjustment
Form." Stores enter only the SKUs that are off; the form outputs clean structured
data (JSON/CSV) so adjustments can be aggregated and bulk-applied to SunLync
instead of being re-keyed ~600 times a month by hand.

## Run it

No build step, no server, no dependencies. Just open **`index.html`** in any
modern browser (double-click it, or host the folder on SharePoint / any static
host). Everything runs client-side.

```
index.html     markup / layout
styles.css     styling
app.js         all form logic (in-memory state only — no localStorage)
catalog.js     EDITABLE product catalog + optional store list
```

## What it does

- **Searchable product picker** over the 239-SKU catalog. Type to filter, arrow
  keys + Enter to add a row. Adding a product already on the form just jumps to
  the existing row (no duplicates).
- **Signed adjustment** input (counted minus system). The form shows `in`/`out`
  next to the number and excludes blank/zero rows from the payload.
- **Notation dropdown** — Damage, Stolen, Expired, Missold, Lost, Transferred,
  Other — captured as structured values so the downstream step can pick the
  SunLync transaction type automatically.
- **Conditional transfer fields** (From / To) appear and become required only
  when Notation = Transferred.
- **Write-in rows** for products not yet in the catalog.
- **Validation** — header fields required; each row needs a non-zero adjustment
  and a notation; transfer rows need From/To.
- **Late flag** — a date after the 25th is flagged on the form and in the export.
- **Outputs** — a clean readable summary (Review & Submit), plus **Download JSON**,
  **Download CSV**, **Copy summary**, and **Open email draft** (`mailto:` with the
  summary prefilled; attach the JSON/CSV).

## Maintaining the catalog (1–2x / year refresh)

Edit **`catalog.js`** — no other code changes needed.

- Add a product: insert a new `"Name",` line (keep alphabetical).
- Discontinue: delete or comment out the line.
- Save the file as **UTF-8** so accented names render correctly
  (Crème, Gelée, Minéral, L'obsidienne).

### Store / market list (optional)

The source PDF had no store list. To turn the **Store Market / Number** field into
a dropdown, populate `window.STORE_LIST` at the top of `catalog.js`. Left empty,
the field stays free-text (with autocomplete from any list you add).

## Data model (export)

```jsonc
{
  "employee": "…",
  "storeMarketNumber": "…",
  "date": "2026-06-21",
  "submittedAt": "2026-06-21T15:04:00.000Z",
  "isLate": false,
  "lineCount": 2,
  "lines": [
    {
      "product": "Emerald - DHA Bronzer",
      "adjustment": -3,
      "notation": "Damage",
      "transactionType": "damage",
      "note": "crushed in shipment"
    },
    {
      "product": "Paradise",
      "adjustment": 2,
      "notation": "Transferred",
      "transactionType": "transfer",
      "transferFrom": "Market A - 101",
      "transferTo": "Market A - 102"
    }
  ]
}
```

Only non-blank rows (and write-ins) are included.

### Notation → transaction type mapping (PROPOSED — verify with SunLync)

| Notation | Adjustment | transactionType |
|---|---|---|
| Damage | any | `damage` |
| Transferred | any | `transfer` (carries From/To) |
| any routine reason | `> 0` | `audit in` |
| any routine reason | `< 0` | `audit out` |

This mapping lives in `transactionType()` in `app.js`. **Confirm the exact
SunLync transaction-type names before wiring any automation** (spec §8).

## Open items carried from the spec (§8)

- **SunLync bulk-load feasibility unknown.** The clean export is the prerequisite
  regardless; auto-apply is a follow-on once feasibility is confirmed.
- **Transaction-type list** needs verification against SunLync.
- **Store/market list** to be supplied (see above).
- **Notation enforcement** is now required in this form — historically it was
  loose. Flagged as a small process change, not silently imposed.
- **Aggregation / shrink view** across all 38–40 store submissions is a later step;
  the JSON/CSV export is designed to feed it.

## Suggested next step

If a shared backend is available, replace the `mailto:` + manual-attach flow with
a direct POST of the JSON to a collection endpoint, then build the cross-store
roll-up (by store / product / reason) on top of the collected submissions.
