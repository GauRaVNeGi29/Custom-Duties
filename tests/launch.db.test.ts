// Pre-launch checks with the real rate file (Nov 2026) against Postgres.
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runRateImport } from "../app/lib/rates/import.server";
import { loadProfiles } from "../app/lib/engine/load.server";
import { calculate } from "../app/lib/engine/calculate";
import { buildEngineLines } from "../app/lib/engine/cart";

const db = new PrismaClient();
const shop = "setu-launch.myshopify.com";
const rates = readFileSync(new URL("./fixtures/rates_2026-11.csv", import.meta.url), "utf8");
const sample = readFileSync(new URL("./fixtures/setustore_sample_inr.csv", import.meta.url), "utf8");

const wipe = async () => {
  await db.hsn.deleteMany({ where: { shop } });
  await db.destination.deleteMany({ where: { shop } });
  await db.auditLog.deleteMany({ where: { shop } });
  await db.importJob.deleteMany({ where: { shop } });
};
beforeAll(wipe);
afterAll(async () => { await wipe(); await db.$disconnect(); });

const cart = (destination: string, items: [number, string | null, number, number][], cartDiscount = 0) =>
  buildEngineLines(
    { destination, currency: "INR", cart_discount: cartDiscount, lines: items.map(([v, , cents, qty]) => ({ key: String(v), variant_id: v, product_id: v, product_title: `P${v}`, quantity: qty, final_line_price: cents * qty, original_line_price: cents * qty })) },
    new Map(items.map(([v, h]) => [v, h])), true);

async function run(dest: string, lines: ReturnType<typeof cart>) {
  const profiles = await loadProfiles(db, { shop, hsnCodes: lines.map((l) => l.hsn!).filter(Boolean), destination: dest });
  return calculate({ destination: dest, currency: "INR", destinationCurrency: "INR", today: "2026-11-10", profiles, lines });
}

describe("going live: old sample → delete all → new rates", () => {
  it("old sample imports, delete-all removes every rate but keeps destinations", async () => {
    await runRateImport(db, { shop, csvText: sample, dryRun: false });
    expect(await db.taxComponent.count({ where: { profile: { shop } } })).toBe(13);
    await db.hsn.deleteMany({ where: { shop } }); // what the Delete all rates button runs
    expect(await db.taxComponent.count({ where: { profile: { shop } } })).toBe(0);
    expect(await db.rateProfile.count({ where: { shop } })).toBe(0);
    expect(await db.destination.count({ where: { shop } })).toBe(4);
  });

  it("new rate file imports cleanly: 3 HSN × 4 countries, 30 components", async () => {
    const preview = await runRateImport(db, { shop, csvText: rates, dryRun: true });
    expect(preview.errorCount).toBe(0);
    const r = await runRateImport(db, { shop, csvText: rates, dryRun: false });
    expect(r.committed).toBe(true);
    expect(r.summary).toMatchObject({ hsnCreated: 3, profilesCreated: 12, componentsCreated: 30 });
    expect(await db.taxComponent.count({ where: { profile: { shop }, active: false } })).toBe(3); // AU processing charge off
  });
});

describe("cart results with the Nov 2026 rates (₹10,000 per item)", () => {
  const mixed = (d: string) => cart(d, [[1, "71179090", 1000000, 1], [2, "42022220", 1000000, 1], [3, "14011000", 1000000, 1]]);

  it("USA: MFN + 10% Section 301 + MPF once", async () => {
    const r = await run("US", mixed("US"));
    expect(r.summary.map((s) => [s.name, s.ratePercent, s.amount])).toEqual([
      ["Basic Customs Duty", "varies", "1730.00"],
      ["Section 301 Duty", "10", "3000.00"],
      ["Merchandise Processing Fee (MPF)", null, "260.00"],
    ]);
    expect(r.totalCharges).toBe("4990.00");
    expect(r.landedCost).toBe("34990.00");
  });
  it("UK: duty-free under CETA, VAT 20%", async () => {
    expect((await run("GB", mixed("GB"))).totalCharges).toBe("6000.00");
  });
  it("Germany: duty, then VAT 19% on value + duty", async () => {
    const r = await run("DE", mixed("DE"));
    expect(r.summary.map((s) => s.amount)).toEqual(["770.00", "5846.30"]);
  });
  it("Australia: GST only; processing charge is off", async () => {
    const r = await run("AU", mixed("AU"));
    expect(r.summary.map((s) => s.name)).toEqual(["Customs Duty", "GST"]);
    expect(r.totalCharges).toBe("3000.00");
  });
  it("quantity 5 and a 10% cart discount", async () => {
    const r = await run("US", cart("US", [[1, "71179090", 100000, 5]], 50000));
    // ₹5,000 - ₹500 discount = ₹4,500 → 11% 495 + 10% 450 + MPF 260
    expect(r.totalCharges).toBe("1205.00");
  });
  it("product without HSN and an HSN without rates are named, total marked partial", async () => {
    const r = await run("US", cart("US", [[1, "71179090", 100000, 1], [2, null, 100000, 1], [3, "42023120", 100000, 1]]));
    expect(r.status).toBe("partial");
    expect(r.issues.map((i) => i.type)).toEqual(["missing_hsn", "no_profile"]);
  });
  it("40-line cart", async () => {
    const big = cart("DE", Array.from({ length: 40 }, (_, i) => [i + 1, ["71179090", "42022220", "14011000"][i % 3], 12345 + i, 1 + (i % 4)] as [number, string, number, number]));
    const r = await run("DE", big);
    expect(r.status).toBe("complete");
    const sum = r.summary.reduce((s, x) => s + Number(x.amount), 0);
    expect(sum.toFixed(2)).toBe(r.totalCharges);
  });
});
