# Setu Import Duties – Shopify custom app

Calculates and **displays** estimated import duties, tariffs and charges on the
Setu Store cart page, using rates Setu Store enters itself. It never fetches or
assumes a rate, and never changes the Shopify checkout total or Shopify's own
duty collection.

Status: **cart display working.** Rates (CSV), product HSN tools, currency
setup, the calculation endpoint and the cart page block are built and tested.
Still to come: the on-screen rate editor (Phase 2; rates are managed by CSV
until then) and hosting for the live store.

## Showing duties on the cart

1. Shopify admin → Online Store → Themes → Customize.
2. Switch the page selector at the top to **Cart**.
3. In the section with the subtotal and checkout button: **Add block → Apps →
   Import duties estimate**. Drag it below the subtotal, above checkout. Save.
4. Slide-out cart: **App embeds → Duties in cart drawer** → on. If it
   does not appear in your theme's drawer, set its CSS selector to the
   drawer's checkout-button container.

The block reads `/cart.js`, calls `POST /apps/setu-duties/calculate` through
the signed app proxy, and re-calculates on destination change, add, remove,
quantity change and reload. The chosen country is saved as the hidden cart
attribute `_setu_destination`. Amounts use the shop's money format inside
`<span class="money">` for Bucks; the widget fires `setu-duties:rendered`
after each update, and `window.SetuDuties.refresh()` forces a recalculation.

## Decisions built in

- **No per-vendor charges.** Whether items ship separately is only settled at
  checkout, so the cart never adds a charge per vendor. `per_vendor_shipment`
  is rejected on import. Shipment charges such as MPF are `per_cart`.
- **HSN codes are managed by the Setu Store team only.** They are stored in an
  app-owned product metafield (`$app:hsn_code`, optional variant override).
  Staff can edit it in Shopify admin or in the app; seller apps such as Webkul
  cannot write it. Shopify's own HS code field is not used for calculation
  (sellers may be able to edit it); a one-time "copy from Shopify HS codes"
  action brings existing values in.
- **Carts are charged in INR; Bucks converts the display.** Duties are
  calculated on the INR cart. The cart block shows amounts in the store's money
  format inside `class="money"` so Bucks converts them for customers. **Fixed
  charges are entered in INR** (e.g. MPF ₹255); a fixed charge in any other
  currency is rejected on import, never converted. The charge currency is a
  setting (`ShopSettings.chargeCurrency`), not code.

## What is in Phase 1

| Area | Where |
| --- | --- |
| Shopify config: scopes, product webhooks, app proxy `/apps/setu-duties` | `shopify.app.toml` |
| Database (PostgreSQL): HSN, destinations, HSN–country profiles, unlimited components, product map, audit log, import jobs | `prisma/schema.prisma` |
| HSN metafield definitions `setu.hsn_code` on products and variants, created on install | `app/lib/products/sync.server.ts` |
| Product → HSN / vendor sync (full catalogue + webhooks) | `app/lib/products/sync.server.ts`, `app/routes/webhooks.products.tsx` |
| CSV parser and validator (your sheet's format) | `app/lib/rates/csv.ts` |
| Import (dry-run diff, all-or-nothing commit, audit) and export | `app/lib/rates/import.server.ts` |
| Calculation engine (pure, no Shopify dependency) | `app/lib/engine/calculate.ts` |
| Admin home: counts, rate CSV import/export, resync, missing-configuration list | `app/routes/app._index.tsx` |
| Products and HSN: search, missing-HSN filter, edit, bulk set, CSV import/export, copy from Shopify HS codes | `app/routes/app.products.tsx`, `app/lib/products/hsn-admin.server.ts` |
| Destinations and currencies, with a live check against Shopify Markets | `app/routes/app.destinations.tsx`, `app/lib/currency.ts` |
| Destinations list for the cart selector (signed app proxy) | `app/routes/proxy.destinations.tsx` |
| Cart calculation endpoint (signed app proxy) | `app/routes/proxy.calculate.tsx`, `app/lib/engine/cart.ts` |
| Cart page block + drawer embed (theme app extension) | `extensions/setu-duties/` |
| Tests: 67, including your sample CSV, brief examples A–D and your store's Markets setup | `tests/` |

## Rate CSV format

One row per tax component – the columns of `setustore_import_duty_rates_example.csv`:

```
origin_country, destination_country, hsn_code, hsn_description, component_name,
component_type, rate_value, currency, calculation_basis, calculation_order,
charge_scope, is_active, effective_from, effective_to, notes
```

Optional extra columns: `basis_components` (for `value_plus_selected`, names
separated by `|`), `min_amount`, `max_amount`.

| Column | Accepted values |
| --- | --- |
| origin_country | India / IN (only India is enabled in v1) |
| destination_country | Country name or ISO code: USA, UK, Germany, Australia, FR … |
| hsn_code | 4–10 digits; dots and spaces are removed (7117.90.90 → 71179090) |
| component_type | `percentage` or `fixed` |
| rate_value | Percent for percentage (10 = 10%), amount for fixed |
| currency | Fixed charges: **INR** (blank is read as INR). Ignored on percentage rows. |
| calculation_basis | `product_value`, `value_plus_prior`, `value_plus_selected`; fixed → `not_applicable` |
| calculation_order | Whole number; blank = row order (10, 20, 30 …) |
| charge_scope | Percentage: `per_product_value`. Fixed: `per_unit` (alias `per_product`), `per_line`, `per_hsn_group`, `per_cart` (alias `per_shipment`). Per-vendor scopes are rejected. |
| is_active | True / False (blank = True) |
| effective_from / to | `YYYY-MM-DD` or `DD-MM-YYYY` |

Rows match on HSN + origin + destination + component name, so re-uploading an
edited export updates in place. **Merge** adds and updates; **Replace** also
removes components missing from the file for each HSN + country it lists. A
file with any error is never applied.

## Calculation rules (engine)

- Lines are grouped by HSN; each group uses its own HSN + India + destination profile.
- Components run in calculation order. `value_plus_prior` adds every earlier
  amount in that HSN group to the base; `value_plus_selected` adds only the
  named ones.
- Fixed charges: `per_unit` × units, `per_line` × lines, `per_hsn_group` once
  per HSN, `per_cart` once per cart. If two HSNs configure the same per-cart
  charge at different amounts, the higher is used.
- A fixed charge is shown only when the cart currency matches the charge's
  currency (no conversion, per your decision). Otherwise it is listed as
  unavailable and the total is marked partial.
- Missing HSN, missing HSN–country configuration, or no active component →
  the product is named and the total is marked partial. No rate is ever guessed.
- Each component is rounded half-up to the currency's minor unit; totals are
  sums of the displayed amounts.

## Running it

Requirements: Node 22.12+, PostgreSQL 14+, Shopify CLI, a Partner / Dev
Dashboard account, and a development store (or Setu Store).

```bash
npm install
cp .env.example .env              # set DATABASE_URL
npx prisma migrate deploy
npm run config:link               # link to your app in the Dev Dashboard
npm run dev                       # opens the install link for your dev store
```

Load rates from the command line (preview, then commit):

```bash
npm run import:rates -- --shop setu-store.myshopify.com --file rates.csv
npm run import:rates -- --shop setu-store.myshopify.com --file rates.csv --commit
```

Tests (need a PostgreSQL database for the `*.db.test.ts` files):

```bash
DATABASE_URL=postgresql://…/setu_duties_test npx prisma migrate deploy
TEST_DATABASE_URL=postgresql://…/setu_duties_test npm test
```

## Product HSN CSV

Export from *Products and HSN*, edit, and upload. Columns:

`product_id, variant_id, sku, product_title, variant_title, vendor, hsn_code,
variant_hsn_override, shopify_hs_code, hsn_has_rates`

- `hsn_code` sets the product's HSN; all rows of one product must agree. A blank cell clears it.
- `variant_hsn_override` sets an HSN for one variant that differs from the product. Blank clears it.
- Rows are matched by `variant_id`, else a unique `sku`; `product_id` alone sets the product level.
- A column left out of the file is not touched. The last three columns are for reference only.
- Preview shows every change; nothing is written to Shopify until confirmed.

## Store findings (4 Nov 2026)

- 4,753 products. No HSN metafield exists yet; codes are in Shopify's HS code
  field on variants (e.g. 44209090). Some are 6 digits (e.g. 711719), which
  will not match 8-digit rates unless rates are configured for those codes.
- Markets: Australia, Canada, Germany, India, United Kingdom, United States –
  all active, all priced in **INR**; INR is the only enabled currency. Local
  currencies are not available to an India-based store; Bucks converts the
  display.

## Open points to confirm on the development store

1. **Metafield-only edits.** Check that editing only the HSN field fires
   `products/update` on your store. "Resync all products" covers any gap, and
   Phase 3 adds a live lookup for variants not yet in the map.
2. **Bucks and the duty block.** Check that Bucks converts the block's amounts,
   including after a quantity change re-renders it. If Bucks needs a manual
   trigger, the block will call it after each update.
