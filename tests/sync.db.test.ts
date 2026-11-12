import { PrismaClient } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { bulkSyncQuery, normaliseHsn, pollFullSync, startFullSync, syncInventoryItem, syncProduct, type AdminGraphql } from "../app/lib/products/sync.server";

const db = new PrismaClient();
const shop = "setu-sync-test.myshopify.com";
afterAll(() => db.$disconnect());
beforeEach(async () => {
  await db.productHsn.deleteMany({ where: { shop } });
  await db.shopSettings.deleteMany({ where: { shop } });
});

const variant = (id: number, title: string, hsn: string | null, hs: string | null) => ({
  id: `gid://shopify/ProductVariant/${id}`, title, sku: `SKU${id}`,
  hsn: hsn ? { value: hsn } : null, inventoryItem: { harmonizedSystemCode: hs },
});
const product = (id: number, title: string, vendor: string, hsn: string | null, variants: unknown[]) => ({
  id: `gid://shopify/Product/${id}`, title, vendor, hsn: hsn ? { value: hsn } : null, 
  variants: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: variants },
});

function fakeShopify(products: ReturnType<typeof product>[]): AdminGraphql {
  return async (query, opts) => ({
    json: async () => {
      if (query.includes("SetuProductsPage")) {
        return { data: { products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: products } } };
      }
      if (query.includes("SetuInventoryItemProduct")) {
        const inv = String(opts?.variables?.id).split("/").pop();
        const p = products.find((pr) => (pr.variants.nodes as { id: string }[]).some((v) => v.id.endsWith(`/${inv}`)));
        return { data: { inventoryItem: p ? { variants: { nodes: [{ product: { id: p.id } }] } } : null } };
      }
      if (query.includes("query SetuProduct(")) {
        return { data: { product: products.find((p) => p.id === opts?.variables?.id) ?? null } };
      }
      throw new Error("unexpected query");
    },
  });
}

/** Bulk export JSONL as Shopify writes it: one line per variant, product inline. */
const toJsonl = (products: ReturnType<typeof product>[]) => products.flatMap((p) => (p.variants.nodes as Record<string, unknown>[]).map((v) =>
  JSON.stringify({ ...v, product: { id: p.id, title: p.title, vendor: p.vendor, hsn: p.hsn } }))).join("\n");

/** Fake Shopify for the bulk export: CREATED → RUNNING → COMPLETED. */
function fakeBulk(products: ReturnType<typeof product>[], finalStatus = "COMPLETED") {
  let polls = 0; const queries: string[] = [];
  const api: AdminGraphql = async (query, opts) => ({
    json: async () => {
      if (query.includes("bulkOperationRunQuery")) { queries.push(String(opts?.variables?.query)); return { data: { bulkOperationRunQuery: { bulkOperation: { id: "gid://shopify/BulkOperation/1", status: "CREATED" }, userErrors: [] } } }; }
      if (query.includes("SetuBulkStatus")) {
        polls++;
        const status = polls < 2 ? "RUNNING" : finalStatus;
        return { data: { bulkOperation: { id: "gid://shopify/BulkOperation/1", status, errorCode: status === "FAILED" ? "TIMEOUT" : null, objectCount: String(polls * 2), url: status === "COMPLETED" ? "https://storage.example/export.jsonl" : null, partialDataUrl: null, completedAt: null } } };
      }
      throw new Error("unexpected query " + query.slice(0, 40));
    },
  });
  return { api, queries, file: async () => toJsonl(products) };
}

async function syncAllProducts(dbc: PrismaClient, api: ReturnType<typeof fakeBulk>, s: string) {
  await startFullSync(dbc, api.api, s);
  let st = await pollFullSync(dbc, api.api, s, api.file);
  while (st.state === "running") st = await pollFullSync(dbc, api.api, s, api.file);
  return st;
}

describe("product → HSN sync", () => {
  it("uses Shopify's HS code field; an app override (variant, then product) wins over it", async () => {
    const products = [
      product(1, "Necklace", "Jaipur Crafts", "7117.90.90", [
        variant(11, "Default Title", null, "711719"),
        variant(12, "Gold", "71131990", null),
      ]),
      product(2, "Wallet", "Kanpur Leather", null, [variant(21, "Brown", null, "42023120")]),
      product(3, "Scarf", "Delhi Weaves", null, [variant(31, "Red", null, null)]),
    ];
    const res = await syncAllProducts(db, fakeBulk(products), shop);
    expect((await db.productHsn.findFirst({ where: { shop, variantId: 21n } }))?.hsnShopify).toBe("42023120");
    expect(res).toEqual({ state: "done", products: 3, variants: 4 });
    const rows = await db.productHsn.findMany({ where: { shop }, orderBy: { variantId: "asc" } });
    expect(rows.map((r) => [Number(r.variantId), r.hsnResolved, r.hsnSource, r.vendor, r.variantTitle])).toEqual([
      [11, "71179090", "product_metafield", "Jaipur Crafts", null],
      [12, "71131990", "variant_metafield", "Jaipur Crafts", "Gold"],
      // no override: Shopify's own HS code field is used
      [21, "42023120", "shopify_hs_code", "Kanpur Leather", "Brown"],
      [31, null, null, "Delhi Weaves", "Red"],
    ]);
  });

  it("a webhook resync replaces that product's variants; deleted products drop out", async () => {
    const before = [product(1, "Necklace", "A", "71179090", [variant(11, "S", null, null), variant(12, "M", null, null)])];
    await syncAllProducts(db, fakeBulk(before), shop);
    const after = [product(1, "Necklace", "A", "71179090", [variant(12, "M", null, null)])];
    await syncProduct(db, fakeShopify(after), shop, "gid://shopify/Product/1");
    expect((await db.productHsn.findMany({ where: { shop } })).map((r) => Number(r.variantId))).toEqual([12]);
    await syncProduct(db, fakeShopify([]), shop, "gid://shopify/Product/1");
    expect(await db.productHsn.count({ where: { shop } })).toBe(0);
  });

  it("editing the HS code in Shopify (inventory_items/update) resyncs that product", async () => {
    await syncAllProducts(db, fakeBulk([product(1, "Ring", "V", null, [variant(11, "S", null, "711719")])]), shop);
    expect((await db.productHsn.findFirst({ where: { shop, variantId: 11n } }))?.hsnResolved).toBe("711719");
    const edited = [product(1, "Ring", "V", null, [variant(11, "S", null, "7117.90.90")])];
    expect(await syncInventoryItem(db, fakeShopify(edited), shop, "gid://shopify/InventoryItem/11")).toBe(1);
    expect((await db.productHsn.findFirst({ where: { shop, variantId: 11n } }))?.hsnResolved).toBe("71179090");
    // an inventory item with no product (e.g. deleted) is ignored
    expect(await syncInventoryItem(db, fakeShopify(edited), shop, "gid://shopify/InventoryItem/999")).toBe(0);
  });

  it("full sync replaces the map: products deleted in Shopify drop out", async () => {
    await syncAllProducts(db, fakeBulk([product(1, "A", "V", "71179090", [variant(11, "S", null, null)]), product(2, "B", "V", null, [variant(21, "S", null, null)])]), shop);
    expect(await db.productHsn.count({ where: { shop } })).toBe(2);
    await syncAllProducts(db, fakeBulk([product(2, "B", "V", null, [variant(21, "S", null, null)])]), shop);
    expect((await db.productHsn.findMany({ where: { shop } })).map((r) => Number(r.variantId))).toEqual([21]);
    expect((await db.shopSettings.findUnique({ where: { shop } }))?.lastFullSyncAt).toBeTruthy();
  });

  it("reports progress while Shopify prepares the export, and a clear error if it fails", async () => {
    const fake = fakeBulk([], "FAILED");
    expect(await startFullSync(db, fake.api, shop)).toEqual({ state: "running", objectCount: 0 });
    expect(await pollFullSync(db, fake.api, shop, fake.file)).toEqual({ state: "running", objectCount: 2 });
    const done = await pollFullSync(db, fake.api, shop, fake.file);
    expect(done.state).toBe("failed");
    expect((await db.shopSettings.findUnique({ where: { shop } }))?.syncBulkOpId).toBeNull();
  });

  it("10,000 variants in one export", async () => {
    const many = Array.from({ length: 2500 }, (_, i) => product(i + 1, `P${i}`, "V", i % 2 ? "71171990" : null,
      Array.from({ length: 4 }, (_, j) => variant((i + 1) * 10 + j, `V${j}`, null, "711719"))));
    const t = Date.now();
    const res = await syncAllProducts(db, fakeBulk(many), shop);
    expect(res).toEqual({ state: "done", products: 2500, variants: 10000 });
    expect(await db.productHsn.count({ where: { shop, hsnResolved: "71171990" } })).toBe(5000);
    expect(Date.now() - t).toBeLessThan(30000);
  });

  it("the export query uses the app-owned HSN field and no nested connections beyond variants", () => {
    const q = bulkSyncQuery({ hsnMetafieldNamespace: "$app", hsnMetafieldKey: "hsn_code" });
    expect(q).toContain('metafield(namespace: "$app", key: "hsn_code")');
    expect(q.match(/edges/g)).toHaveLength(1);
  });

  it("rejects malformed HSN values instead of guessing", () => {
    expect(normaliseHsn("7117 90 90")).toBe("71179090");
    expect(normaliseHsn("71A7")).toBeNull();
    expect(normaliseHsn("12")).toBeNull();
  });
});
