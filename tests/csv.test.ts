import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseRatesCsv } from "../app/lib/rates/csv";

const sample = readFileSync(new URL("./fixtures/setustore_sample.csv", import.meta.url), "utf8");
const HEADER = "origin_country,destination_country,hsn_code,hsn_description,component_name,component_type,rate_value,currency,calculation_basis,calculation_order,charge_scope,is_active,effective_from,effective_to,notes";
const csv = (...rows: string[]) => [HEADER, ...rows].join("\n");

describe("Setu Store sample CSV", () => {
  const r = parseRatesCsv(sample);

  it("parses all 13 rows with no errors (BOM header handled)", () => {
    expect(r.errorCount).toBe(0);
    expect(r.rows).toHaveLength(13);
  });

  it("maps country names to ISO codes", () => {
    expect(new Set(r.rows.map((x) => x.destination))).toEqual(new Set(["US", "AU", "GB", "DE"]));
    expect(new Set(r.rows.map((x) => x.origin))).toEqual(new Set(["IN"]));
  });

  it("reads MPF as a fixed per-cart charge in USD", () => {
    const mpf = r.rows.find((x) => x.componentName.startsWith("Merchandise Processing Fee"))!;
    expect(mpf).toMatchObject({ chargeType: "fixed", rateValue: "3", currency: "USD", scope: "per_cart", basis: "not_applicable", calcOrder: 3 });
  });

  it("reads percentages per product value", () => {
    const row = r.rows.find((x) => x.destination === "DE" && x.componentName === "Additional Import Tax")!;
    expect(row).toMatchObject({ chargeType: "percentage", rateValue: "5", basis: "product_value", scope: "per_product_value", active: true });
  });
});

describe("INR fixed charges (carts are charged in INR, Bucks converts display)", () => {
  it("rejects the sample's USD MPF when the charge currency is INR", () => {
    const r = parseRatesCsv(sample, { chargeCurrency: "INR" });
    expect(r.errorCount).toBe(1);
    expect(r.issues[0]).toMatchObject({ line: 4, column: "currency" });
    expect(r.issues[0].message).toContain("INR");
  });

  it("accepts INR fixed charges, and reads a blank currency as INR", () => {
    const r = parseRatesCsv(csv(
      "India,USA,71179090,x,MPF,fixed,255,INR,not_applicable,3,per_cart,True,,,",
      "India,UK,71179090,x,Handling,fixed,100,,not_applicable,3,per_cart,True,,,",
    ), { chargeCurrency: "INR" });
    expect(r.errorCount).toBe(0);
    expect(r.rows.map((x) => x.currency)).toEqual(["INR", "INR"]);
  });

  it("ignores the currency column on percentage rows", () => {
    const r = parseRatesCsv(csv("India,USA,71179090,x,Duty,percentage,10,USD,product_value,1,per_product_value,True,,,"), { chargeCurrency: "INR" });
    expect(r.errorCount).toBe(0);
  });
});

describe("validation", () => {
  it("rejects a fixed charge without currency or scope", () => {
    const r = parseRatesCsv(csv("India,USA,71179090,x,MPF,fixed,3,,,1,,True,,,"));
    expect(r.issues.map((i) => i.column)).toEqual(expect.arrayContaining(["currency", "charge_scope"]));
    expect(r.rows).toHaveLength(0);
  });

  it("rejects unknown countries and non-India origins", () => {
    const r = parseRatesCsv(csv(
      "India,Narnia,71179090,x,Duty,percentage,10,USD,product_value,1,per_product_value,True,,,",
      "China,USA,71179090,x,Duty,percentage,10,USD,product_value,1,per_product_value,True,,,",
    ));
    expect(r.errorCount).toBe(2);
  });

  it("rejects duplicate component names in one HSN + country", () => {
    const r = parseRatesCsv(csv(
      "India,USA,71179090,x,Duty,percentage,10,USD,product_value,1,per_product_value,True,,,",
      "India,USA,71179090,x,duty,percentage,12,USD,product_value,2,per_product_value,True,,,",
    ));
    expect(r.issues.some((i) => i.message.includes("appears twice"))).toBe(true);
  });

  it("accepts scope aliases per_product and per_shipment", () => {
    const r = parseRatesCsv(csv(
      "India,USA,1234,x,A,fixed,1,USD,not_applicable,1,per_product,True,,,",
      "India,USA,1234,x,C,fixed,1,USD,not_applicable,3,per_shipment,True,,,",
    ));
    expect(r.rows.map((x) => x.scope)).toEqual(["per_unit", "per_cart"]);
    expect(r.errorCount).toBe(0);
  });

  it("rejects per-vendor charges with a clear reason", () => {
    for (const scope of ["per_vendor_shipment", "per_vendor"]) {
      const r = parseRatesCsv(csv(`India,USA,1234,x,Fee,fixed,1,USD,not_applicable,1,${scope},True,,,`));
      expect(r.errorCount).toBe(1);
      expect(r.issues[0].message).toContain("only known at checkout");
    }
  });

  it("accepts CAD for Canada and rejects unknown currencies", () => {
    const ok = parseRatesCsv(csv("India,Canada,1234,x,Fee,fixed,4,CAD,not_applicable,1,per_cart,True,,,"));
    expect(ok.rows[0]).toMatchObject({ destination: "CA", currency: "CAD" });
    const bad = parseRatesCsv(csv("India,Canada,1234,x,Fee,fixed,4,CAN,not_applicable,1,per_cart,True,,,"));
    expect(bad.issues[0].column).toBe("currency");
  });

  it("parses ISO and day-first dates and checks their order", () => {
    const r = parseRatesCsv(csv(
      "India,USA,1234,x,A,percentage,1,USD,product_value,1,per_product_value,True,2026-01-01,31-12-2026,",
      "India,USA,1234,x,B,percentage,1,USD,product_value,2,per_product_value,True,01/02/2027,01/01/2027,",
    ));
    expect(r.rows[0]).toMatchObject({ effectiveFrom: "2026-01-01", effectiveTo: "2026-12-31" });
    expect(r.issues.some((i) => i.column === "effective_to" && i.severity === "error")).toBe(true);
  });

  it("checks value_plus_selected references", () => {
    const r = parseRatesCsv(HEADER + ",basis_components\n" + [
      "India,UK,1234,x,Duty,percentage,6,GBP,product_value,1,per_product_value,True,,,,",
      "India,UK,1234,x,VAT,percentage,20,GBP,value_plus_selected,2,per_product_value,True,,,,Duty",
      "India,UK,1234,x,Bad,percentage,1,GBP,value_plus_selected,3,per_product_value,True,,,,Missing",
    ].join("\n"));
    expect(r.rows.find((x) => x.componentName === "VAT")?.basisIncludes).toEqual(["Duty"]);
    expect(r.issues.some((i) => i.message.includes('"Missing"'))).toBe(true);
  });

  it("fills calculation order from row order when blank", () => {
    const r = parseRatesCsv(csv(
      "India,USA,1234,x,A,percentage,1,USD,product_value,,per_product_value,True,,,",
      "India,USA,1234,x,B,percentage,1,USD,product_value,,per_product_value,True,,,",
    ));
    expect(r.rows.map((x) => x.calcOrder)).toEqual([10, 20]);
  });
});
