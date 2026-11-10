import { PrismaClient, type ProductHsn } from "@prisma/client";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  applyHsnChanges, exportProductHsnCsv, listProducts, planBulkSet, planCopyFromShopify, planProductHsnCsv,
} from "../app/lib/products/hsn-admin.server";
import type { AdminGraphql } from "../app/lib/products/sync.server";

const db = new PrismaClient();
const shop = "setu-hsn-admin.myshopify.com";
afterAll(() => db.$disconnect());

const row = (productId: number, variantId: number, o: Partial<ProductHsn> = {}): ProductHsn => ({
  shop, productId: BigInt(productId), variantId: BigInt(variantId), productTitle: `Product ${productId}`,
  variantTitle: `V${variantId}`, sku: `SKU-${variantId}`, vendor: "SHRIJI CRAFTS",
  hsnVariantMetafield: null, hsnProductMetafield: null, hsnShopify: null, hsnResolved: null, hsnSource: null,
  syncedAt: new Date(), ...o,
});

beforeEach(async () => {
  await db.productHsn.deleteMany({ where: { shop } });
  await db.auditLog.deleteMany({ where: { shop } });
  await db.shopSettings.deleteMany({ where: { shop } });
  await db.hsn.deleteMany({ where: { shop } });
  await db.destination.deleteMany({ where: { shop } });
});

describe("copy from Shopify HS codes (one-time)", () => {
  it("sets the product HSN when all variants agree, overrides when they differ, skips products the team already set", () => {
    const map = [
      row(1, 11, { hsnShopify: "44209090" }),
      row(2, 21, { hsnShopify: "71179090" }), row(2, 22, { hsnShopify: "71131990" }),
      row(3, 31, { hsnShopify: "711719" }),
      row(4, 41, { hsnShopify: "42023120", hsnProductMetafield: "42023190" }), // team value wins
      row(5, 51),
    ];
    const { changes, issues } = planCopyFromShopify(map);
    expect(changes.map((c) => [c.target, Number(c.variantId ?? c.productId), c.to])).toEqual([
      ["product", 1, "44209090"],
      ["variant", 21, "71179090"],
      ["variant", 22, "71131990"],
      ["product", 3, "711719"],
    ]);
    expect(issues.some((i) => i.message.includes("fewer than 8 digits"))).toBe(true);
  });
});

describe("product HSN CSV", () => {
  const map = [row(1, 11, { hsnProductMetafield: "44209090" }), row(1, 12, { hsnProductMetafield: "44209090" }), row(2, 21), row(3, 31, { sku: "DUP" }), row(4, 41, { sku: "DUP" })];

  it("re-importing an export makes no changes", async () => {
    await db.productHsn.createMany({ data: map });
    const csv = await exportProductHsnCsv(db, { shop });
    expect(planProductHsnCsv(map, csv).changes).toEqual([]);
  });

  it("sets product HSN, variant overrides, matches by SKU, and reports errors", () => {
    const csv = [
      "product_id,variant_id,sku,hsn_code,variant_hsn_override",
      "1,11,,44209090,",
      "1,12,,44209090,44219990",
      ",,SKU-21,71179090,",
      ",,DUP,71179090,",
      "2,,,1234X,",
      "99,,,71179090,",
    ].join("\n");
    const { changes, issues } = planProductHsnCsv(map, csv);
    expect(changes.map((c) => [c.target, Number(c.variantId ?? c.productId), c.from, c.to])).toEqual([
      ["product", 2, null, "71179090"],
      ["variant", 12, null, "44219990"],
    ]);
    expect(issues.map((i) => i.line)).toEqual([5, 6, 7]); // duplicate SKU, bad HSN, unknown product
  });

  it("rejects conflicting product HSN values for one product", () => {
    const { issues } = planProductHsnCsv(map, "product_id,variant_id,hsn_code\n1,11,44209090\n1,12,44219990\n");
    expect(issues[0].message).toContain("variant_hsn_override");
  });

  it("only touches columns that are in the file", () => {
    const withOverride = [row(1, 11, { hsnVariantMetafield: "44219990", hsnProductMetafield: "44209090" })];
    expect(planProductHsnCsv(withOverride, "variant_id,hsn_code\n11,44209090\n").changes).toEqual([]);
  });
});

describe("bulk set", () => {
  it("sets the same HSN on many products and refuses invalid codes", () => {
    const map = [row(1, 11), row(2, 21, { hsnProductMetafield: "71179090" })];
    expect(planBulkSet(map, [1n, 2n], "7117.90.90").changes.map((c) => Number(c.productId))).toEqual([1]);
    expect(planBulkSet(map, [1n], "12AB").issues[0].severity).toBe("error");
  });
});

describe("writing to Shopify", () => {
  it("saves in batches of 25, deletes cleared values, mirrors the map and audits", async () => {
    await db.productHsn.createMany({ data: Array.from({ length: 30 }, (_, i) => row(i + 1, (i + 1) * 10)) });
    await db.productHsn.update({ where: { shop_variantId: { shop, variantId: 10n } }, data: { hsnProductMetafield: "44209090", hsnResolved: "44209090", hsnSource: "product_metafield" } });
    const calls: { query: string; n: number }[] = [];
    const fake: AdminGraphql = async (query, opts) => ({
      json: async () => {
        const n = (opts?.variables?.metafields as unknown[]).length;
        calls.push({ query: query.includes("metafieldsSet") ? "set" : "delete", n });
        return query.includes("metafieldsSet")
          ? { data: { metafieldsSet: { metafields: [], userErrors: [] } } }
          : { data: { metafieldsDelete: { deletedMetafields: [], userErrors: [] } } };
      },
    });
    const map = await db.productHsn.findMany({ where: { shop }, orderBy: { productId: "asc" } });
    const set = planBulkSet(map, map.slice(1).map((r) => r.productId), "71179090").changes;
    const clear = planBulkSet(map, [1n], "").changes;
    const res = await applyHsnChanges(db, fake, shop, [...set, ...clear], "team@setustore.com");
    expect(res).toEqual({ applied: 30, failed: [] });
    expect(calls).toEqual([{ query: "set", n: 25 }, { query: "set", n: 4 }, { query: "delete", n: 1 }]);
    expect((await db.productHsn.findFirst({ where: { shop, variantId: 20n } }))).toMatchObject({ hsnResolved: "71179090", hsnSource: "product_metafield" });
    expect((await db.productHsn.findFirst({ where: { shop, variantId: 10n } }))).toMatchObject({ hsnResolved: null, hsnProductMetafield: null });
    expect(await db.auditLog.count({ where: { shop, entity: "product_hsn" } })).toBe(30);
  });

  it("reports Shopify errors per product and keeps the map unchanged for them", async () => {
    await db.productHsn.create({ data: row(1, 11) });
    const fake: AdminGraphql = async () => ({ json: async () => ({ data: { metafieldsSet: { metafields: [], userErrors: [{ field: ["value"], message: "Value is invalid", code: "INVALID_VALUE" }] } } }) });
    const res = await applyHsnChanges(db, fake, shop, planBulkSet(await db.productHsn.findMany({ where: { shop } }), [1n], "71179090").changes);
    expect(res.applied).toBe(0);
    expect(res.failed[0].message).toBe("Value is invalid");
    expect((await db.productHsn.findFirst({ where: { shop } }))?.hsnResolved).toBeNull();
  });
});

describe("missing-HSN list", () => {
  it("filters missing and HSN-without-rates products", async () => {
    await db.productHsn.createMany({ data: [
      row(1, 11, { hsnProductMetafield: "71179090", hsnResolved: "71179090" }),
      row(2, 21, { hsnProductMetafield: "44209090", hsnResolved: "44209090" }),
      row(3, 31),
    ] });
    const dest = await db.destination.create({ data: { shop, countryCode: "US", displayName: "United States", currency: "USD" } });
    const hsn = await db.hsn.create({ data: { shop, code: "71179090" } });
    await db.rateProfile.create({ data: { shop, hsnId: hsn.id, destinationId: dest.id } });
    expect((await listProducts(db, { shop, filter: "missing" })).products.map((p) => p.productId)).toEqual(["3"]);
    expect((await listProducts(db, { shop, filter: "unconfigured" })).products.map((p) => p.productId)).toEqual(["2"]);
    expect((await listProducts(db, { shop, search: "4420" })).products.map((p) => p.productId)).toEqual(["2"]);
  });
});
