// Runs against a real PostgreSQL database (DATABASE_URL in .env.test).
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportRatesCsv, runRateImport } from "../app/lib/rates/import.server";
import { loadProfiles } from "../app/lib/engine/load.server";
import { calculate } from "../app/lib/engine/calculate";

const db = new PrismaClient();
const shop = "setu-test.myshopify.com";
// Same rows as the Setu Store sample, with fixed charges in INR (MPF ₹255): carts are charged in INR.
const sample = readFileSync(new URL("./fixtures/setustore_sample_inr.csv", import.meta.url), "utf8");
const sampleUsd = readFileSync(new URL("./fixtures/setustore_sample.csv", import.meta.url), "utf8");

beforeAll(async () => {
  await db.auditLog.deleteMany({ where: { shop } });
  await db.importJob.deleteMany({ where: { shop } });
  await db.hsn.deleteMany({ where: { shop } });
  await db.destination.deleteMany({ where: { shop } });
  await db.importJob.deleteMany({ where: { shop: "setu-usd-check.myshopify.com" } });
});
afterAll(() => db.$disconnect());

describe("CSV import into Postgres", () => {
  it("dry run writes nothing but reports the plan", async () => {
    const r = await runRateImport(db, { shop, csvText: sample, dryRun: true });
    expect(r.committed).toBe(false);
    expect(r.summary).toMatchObject({ hsnCreated: 3, destinationsCreated: 4, profilesCreated: 6, componentsCreated: 13 });
    expect(await db.taxComponent.count({ where: { profile: { shop } } })).toBe(0);
  });

  it("commit creates HSNs, destinations, profiles and components", async () => {
    const r = await runRateImport(db, { shop, csvText: sample, dryRun: false });
    expect(r.committed).toBe(true);
    expect(await db.hsn.count({ where: { shop } })).toBe(3);
    const dest = await db.destination.findMany({ where: { shop }, orderBy: { countryCode: "asc" } });
    expect(dest.map((d) => [d.countryCode, d.currency])).toEqual([["AU", "INR"], ["DE", "INR"], ["GB", "INR"], ["US", "INR"]]);
    expect(await db.taxComponent.count({ where: { profile: { shop } } })).toBe(13);
  });

  it("rejects a fixed charge entered in USD, since carts are charged in INR", async () => {
    const r = await runRateImport(db, { shop: "setu-usd-check.myshopify.com", csvText: sampleUsd, dryRun: true });
    expect(r.errorCount).toBe(1);
    expect(r.issues.find((i) => i.severity === "error")).toMatchObject({ line: 4, column: "currency" });
  });

  it("re-importing the same file changes nothing", async () => {
    const r = await runRateImport(db, { shop, csvText: sample, dryRun: false });
    expect(r.summary).toMatchObject({ componentsCreated: 0, componentsUpdated: 0, componentsUnchanged: 13 });
  });

  it("export → re-import round-trips with zero changes", async () => {
    const exported = await exportRatesCsv(db, { shop });
    expect(exported.split("\n")[1]).toContain("India,USA,42022220,Fabric Bag");
    const r = await runRateImport(db, { shop, csvText: exported, dryRun: true });
    expect(r.errorCount).toBe(0);
    expect(r.summary).toMatchObject({ componentsCreated: 0, componentsUpdated: 0, componentsUnchanged: 13 });
  });

  it("an edited rate is reported field by field and audited", async () => {
    const edited = sample.replace("Basic Import Duty,percentage,10,INR", "Basic Import Duty,percentage,12.5,INR");
    const preview = await runRateImport(db, { shop, csvText: edited, dryRun: true });
    expect(preview.updated).toEqual([{ hsn: "71179090", destination: "US", name: "Basic Import Duty", changes: { rateValue: { from: "10", to: "12.5" } } }]);
    await runRateImport(db, { shop, csvText: edited, dryRun: false, actor: "gaurav@setustore.com" });
    const log = await db.auditLog.findFirst({ where: { shop, action: "update" }, orderBy: { id: "desc" } });
    expect(log?.after).toEqual({ rateValue: "12.5" });
    await runRateImport(db, { shop, csvText: sample, dryRun: false }); // restore
  });

  it("replace mode removes components missing from the file for that HSN + country only", async () => {
    const withoutMpf = sample.split("\n").filter((l) => !l.includes("Merchandise Processing Fee")).join("\n");
    const merge = await runRateImport(db, { shop, csvText: withoutMpf, dryRun: true, mode: "merge" });
    expect(merge.summary.componentsDeleted).toBe(0);
    const replace = await runRateImport(db, { shop, csvText: withoutMpf, dryRun: true, mode: "replace_profiles" });
    expect(replace.deleted).toEqual([{ hsn: "71179090", destination: "US", name: "Merchandise Processing Fee (MPF)" }]);
  });

  it("a file with any error is never applied", async () => {
    const bad = sample + "India,Narnia,71179090,x,Duty,percentage,10,USD,product_value,1,per_product_value,True,,,\n";
    const r = await runRateImport(db, { shop, csvText: bad, dryRun: false });
    expect(r.committed).toBe(false);
    expect(r.errorCount).toBe(1);
  });
});

describe("database → engine", () => {
  it("Example C from the brief as an INR cart (₹8,300 / ₹12,450 / ₹8,300), MPF ₹255", async () => {
    const profiles = await loadProfiles(db, { shop, hsnCodes: ["71179090", "42023120", "42022220"], destination: "US" });
    const r = calculate({
      destination: "US", currency: "INR", destinationCurrency: "INR", today: "2026-11-04", profiles,
      lines: [
        { key: "1", productTitle: "Imitation Jewellery", quantity: 1, value: "8300", hsn: "71179090" },
        { key: "2", productTitle: "Leather Wallet", quantity: 1, value: "12450", hsn: "42023120" },
        { key: "3", productTitle: "Fabric Bag", quantity: 1, value: "8300", hsn: "42022220" },
      ],
    });
    // 830 + 913 + 996 + 1494 + 415 + 830 + MPF 255 once
    expect(r.totalCharges).toBe("5733.00");
    expect(r.status).toBe("complete");
    expect(r.currencyNote).toBeNull();
  });

  it("UK cart with the sample rates", async () => {
    const profiles = await loadProfiles(db, { shop, hsnCodes: ["71179090"], destination: "GB" });
    const r = calculate({ destination: "GB", currency: "INR", today: "2026-11-04", profiles,
      lines: [{ key: "1", productTitle: "Imitation Jewellery", quantity: 2, value: "8000", hsn: "71179090" }] });
    expect(r.summary.map((s) => [s.name, s.amount])).toEqual([["Basic Import Duty", "480.00"], ["Additional Tariff", "320.00"]]);
  });

  it("Leather Wallet has no Germany configuration → partial, named", async () => {
    const profiles = await loadProfiles(db, { shop, hsnCodes: ["42023120"], destination: "DE" });
    const r = calculate({ destination: "DE", currency: "INR", today: "2026-11-04", profiles,
      lines: [{ key: "1", productTitle: "Leather Wallet", quantity: 1, value: "12450", hsn: "42023120" }] });
    expect(r.status).toBe("partial");
    expect(r.issues[0]).toMatchObject({ type: "no_profile", hsn: "42023120" });
  });
});
