import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { configureSyncQueue, drainSyncQueue, enqueueSync } from "../app/lib/products/sync-queue.server";
import { syncProduct, type AdminGraphql } from "../app/lib/products/sync.server";

const db = new PrismaClient();
const shop = "setu-queue-test.myshopify.com";
afterAll(() => db.$disconnect());
beforeAll(() => configureSyncQueue({ debounceMs: 30, retryDelayMs: 10, recentMs: 150 }));
beforeEach(async () => {
  await db.productHsn.deleteMany({ where: { shop } });
  await db.shopSettings.deleteMany({ where: { shop } });
});

const variant = (id: number, hs: string | null) => ({
  id: `gid://shopify/ProductVariant/${id}`, title: `V${id}`, sku: null, hsn: null, inventoryItem: { harmonizedSystemCode: hs },
});
const product = (id: number, variants: ReturnType<typeof variant>[]) => ({
  id: `gid://shopify/Product/${id}`, title: `P${id}`, vendor: "V", hsn: null,
  variants: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: variants },
});

/** Fake Shopify that counts product reads and is slow, like the real API. */
function fakeShopify(products: ReturnType<typeof product>[], { failFirst = 0, delayMs = 15 } = {}) {
  const reads: string[] = []; let failures = failFirst;
  const api: AdminGraphql = async (query, o) => ({
    json: async () => {
      await new Promise((r) => setTimeout(r, delayMs));
      if (query.includes("SetuInventoryItemProduct")) {
        const inv = String(o?.variables?.id).split("/").pop();
        const p = products.find((pr) => pr.variants.nodes.some((v) => v.id.endsWith(`/${inv}`)));
        return { data: { inventoryItem: p ? { variants: { nodes: [{ product: { id: p.id } }] } } : null } };
      }
      if (query.includes("query SetuProduct(")) {
        reads.push(String(o?.variables?.id));
        if (failures > 0) { failures--; throw new Error("Server has closed the connection"); }
        return { data: { product: products.find((p) => p.id === o?.variables?.id) ?? null } };
      }
      throw new Error("unexpected query");
    },
  });
  return { api, reads };
}

describe("webhook sync queue", () => {
  it("overlapping syncs of the same product no longer fail (the live P2002 error)", async () => {
    const { api } = fakeShopify([product(1, [variant(11, "711719"), variant(12, "711719")])], { delayMs: 0 });
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => syncProduct(db, api, shop, "gid://shopify/Product/1")));
    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    expect(await db.productHsn.count({ where: { shop } })).toBe(2);
  });

  it("a burst of product + inventory item webhooks becomes one sync per product", async () => {
    const products = Array.from({ length: 5 }, (_, i) => product(i + 1, [variant((i + 1) * 10 + 1, "711719"), variant((i + 1) * 10 + 2, "711719")]));
    const { api, reads } = fakeShopify(products);
    for (const p of products) {
      enqueueSync(db, api, shop, "product", p.id);
      enqueueSync(db, api, shop, "product", p.id); // products/update often fires twice
      for (const v of p.variants.nodes) enqueueSync(db, api, shop, "inventory_item", `gid://shopify/InventoryItem/${v.id.split("/").pop()}`);
    }
    await drainSyncQueue(shop);
    expect(reads.sort()).toEqual(products.map((p) => p.id).sort()); // 5 reads, not 25
    expect(await db.productHsn.count({ where: { shop, hsnResolved: "711719" } })).toBe(10);
  });

  it("an edit arriving just after a sync is still picked up", async () => {
    const products = [product(1, [variant(11, "711719")])];
    const { api, reads } = fakeShopify(products);
    enqueueSync(db, api, shop, "product", products[0].id);
    await new Promise((r) => setTimeout(r, 80)); // first sync done
    products[0].variants.nodes[0].inventoryItem.harmonizedSystemCode = "71179090";
    enqueueSync(db, api, shop, "inventory_item", "gid://shopify/InventoryItem/11");
    await drainSyncQueue(shop);
    expect(reads).toHaveLength(2);
    expect((await db.productHsn.findFirst({ where: { shop, variantId: 11n } }))?.hsnResolved).toBe("71179090");
  });

  it("retries a failed sync, and webhooks return without waiting for the sync", async () => {
    const { api, reads } = fakeShopify([product(1, [variant(11, "711719")])], { failFirst: 2 });
    const t = Date.now();
    enqueueSync(db, api, shop, "product", "gid://shopify/Product/1");
    expect(Date.now() - t).toBeLessThan(5); // enqueue is instant
    await drainSyncQueue(shop);
    expect(reads).toHaveLength(3);
    expect(await db.productHsn.count({ where: { shop } })).toBe(1);
  });
});
