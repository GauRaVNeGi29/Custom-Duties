-- Use Shopify's own HS code field as the normal HSN source; the app-owned
-- HSN fields stay as optional overrides (tried first).
ALTER TABLE "ShopSettings"
  ALTER COLUMN "hsnSourceOrder" SET DEFAULT ARRAY['variant_metafield', 'product_metafield', 'shopify_hs_code']::TEXT[];

UPDATE "ShopSettings"
  SET "hsnSourceOrder" = array_append("hsnSourceOrder", 'shopify_hs_code')
  WHERE NOT ('shopify_hs_code' = ANY("hsnSourceOrder"));

-- Products already synced: use their Shopify HS code now (same rule as
-- normaliseHsn: strip spaces, dots and dashes; keep 4–10 digits), so the cart
-- works straight after deploy without waiting for a resync.
UPDATE "ProductHsn"
  SET "hsnResolved" = regexp_replace("hsnShopify", '[\s.-]', '', 'g'),
      "hsnSource"   = 'shopify_hs_code'
  WHERE "hsnResolved" IS NULL
    AND "hsnShopify" IS NOT NULL
    AND regexp_replace("hsnShopify", '[\s.-]', '', 'g') ~ '^[0-9]{4,10}$';
