import { describe, expect, it } from "vitest";
import { calculate } from "../app/lib/engine/calculate";
import type { EngineComponent, EngineLine, EngineProfile } from "../app/lib/engine/types";

// Rates below are the illustrative examples from the Setu Store brief, not real tariffs.

let n = 0;
const pct = (name: string, rate: string, order: number, extra: Partial<EngineComponent> = {}): EngineComponent => ({
  id: `c${++n}`, name, chargeType: "percentage", rateValue: rate, currency: "USD", basis: "product_value",
  basisIncludes: [], calcOrder: order, scope: "per_product_value", minAmount: null, maxAmount: null,
  effectiveFrom: null, effectiveTo: null, active: true, ...extra,
});
const fixed = (name: string, amount: string, scope: EngineComponent["scope"], order = 90, extra: Partial<EngineComponent> = {}): EngineComponent => ({
  ...pct(name, amount, order), chargeType: "fixed", basis: "not_applicable", scope, ...extra,
});
const profile = (hsn: string, components: EngineComponent[], desc = null): EngineProfile => ({ hsn, hsnDescription: desc, active: true, components });
const line = (key: string, hsn: string | null, value: string, quantity = 1, vendor: string | null = "Vendor A"): EngineLine => ({
  key, productTitle: key, quantity, value, hsn, vendor,
});

const MPF = () => fixed("MPF", "3", "per_cart");
const usJewellery = () => profile("71179090", [pct("Basic Import Duty", "10", 1), pct("Additional Tariff", "11", 2), MPF()]);
const base = { destination: "US", currency: "USD", today: "2026-11-04" };

describe("brief examples", () => {
  it("A: single product → $24", () => {
    const r = calculate({ ...base, lines: [line("Imitation Jewellery", "71179090", "100.00")], profiles: { "71179090": usJewellery() } });
    expect(r.status).toBe("complete");
    expect(r.summary.map((s) => [s.name, s.ratePercent, s.amount])).toEqual([
      ["Basic Import Duty", "10", "10.00"],
      ["Additional Tariff", "11", "11.00"],
      ["MPF", null, "3.00"],
    ]);
    expect(r.totalCharges).toBe("24.00");
    expect(r.landedCost).toBe("124.00");
  });

  it("B: three products, same HSN → $45, MPF once", () => {
    const r = calculate({
      ...base,
      lines: [line("Necklace", "71179090", "100"), line("Earrings", "71179090", "50"), line("Bracelet", "71179090", "50")],
      profiles: { "71179090": usJewellery() },
    });
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].value).toBe("200.00");
    expect(r.totalCharges).toBe("45.00");
    expect(r.shipmentCharges).toHaveLength(1);
  });

  it("C: three HSNs → $66 + MPF once = $69", () => {
    const r = calculate({
      ...base,
      lines: [line("Jewellery", "71179090", "100"), line("Wallet", "42023120", "150"), line("Bag", "42022220", "100")],
      profiles: {
        "71179090": usJewellery(),
        "42023120": profile("42023120", [pct("Basic Import Duty", "8", 1), pct("Additional Tariff", "12", 2), MPF()]),
        "42022220": profile("42022220", [pct("Basic Import Duty", "5", 1), pct("Additional Tariff", "10", 2), MPF()]),
      },
    });
    const byName = Object.fromEntries(r.summary.map((s) => [s.name, s]));
    expect(byName["Basic Import Duty"].amount).toBe("27.00");
    expect(byName["Basic Import Duty"].ratePercent).toBe("varies");
    expect(byName["Additional Tariff"].amount).toBe("39.00");
    expect(byName["MPF"].amount).toBe("3.00");
    expect(r.totalCharges).toBe("69.00");
  });

  it("D: switching USA → Germany uses only the Germany profile", () => {
    const lines = [line("Jewellery", "71179090", "100")];
    const us = calculate({ ...base, lines, profiles: { "71179090": usJewellery() } });
    const de = calculate({
      ...base, destination: "DE", currency: "EUR", lines,
      profiles: { "71179090": profile("71179090", [pct("Basic Import Duty", "8", 1, { currency: "EUR" }), pct("Additional Import Tax", "5", 2, { currency: "EUR" })]) },
    });
    expect(us.totalCharges).toBe("24.00");
    expect(de.summary.map((s) => s.name)).toEqual(["Basic Import Duty", "Additional Import Tax"]);
    expect(de.totalCharges).toBe("13.00");
  });
});

describe("bases and order", () => {
  it("value_plus_prior includes earlier amounts", () => {
    const r = calculate({ ...base, lines: [line("x", "1", "100")],
      profiles: { "1": profile("1", [pct("Duty", "8", 1), pct("Import Tax", "5", 2, { basis: "value_plus_prior" })]) } });
    expect(r.groups[0].components[1].base).toBe("108.00");
    expect(r.totalCharges).toBe("13.40");
  });

  it("value_plus_selected includes only the named components", () => {
    const r = calculate({ ...base, lines: [line("x", "1", "100")],
      profiles: { "1": profile("1", [pct("A", "10", 1), pct("B", "20", 2), pct("VAT", "10", 3, { basis: "value_plus_selected", basisIncludes: ["A"] })]) } });
    expect(r.groups[0].components[2].base).toBe("110.00");
    expect(r.groups[0].components[2].amount).toBe("11.00");
  });

  it("calc order, not list order, decides sequence", () => {
    const r = calculate({ ...base, lines: [line("x", "1", "100")],
      profiles: { "1": profile("1", [pct("Second", "10", 2, { basis: "value_plus_prior" }), pct("First", "10", 1)]) } });
    expect(r.groups[0].components.map((c) => c.name)).toEqual(["First", "Second"]);
    expect(r.totalCharges).toBe("21.00");
  });

  it("min and max clamp a component", () => {
    const r = calculate({ ...base, lines: [line("x", "1", "100")],
      profiles: { "1": profile("1", [pct("Low", "1", 1, { minAmount: "5" }), pct("High", "50", 2, { maxAmount: "20" })]) } });
    expect(r.groups[0].components.map((c) => c.amount)).toEqual(["5.00", "20.00"]);
  });
});

describe("fixed charge scopes", () => {
  const lines = [line("a", "1", "10", 3, "Vendor A"), line("b", "1", "10", 2, "Vendor B"), line("c", "2", "10", 1, "Vendor A")];
  const run = (scope: EngineComponent["scope"]) => calculate({ ...base, lines, profiles: {
    "1": profile("1", [fixed("Fee", "2", scope)]),
    "2": profile("2", [fixed("Fee", "2", scope)]),
  } }).totalCharges;

  it("per_unit charges every unit", () => expect(run("per_unit")).toBe("12.00"));      // (3+2)×2 + 1×2
  it("per_line charges every line", () => expect(run("per_line")).toBe("6.00"));       // 2 lines + 1 line
  it("per_hsn_group charges each HSN once", () => expect(run("per_hsn_group")).toBe("4.00"));
  it("per_vendor_shipment is never added to the total", () => {
    const r = calculate({ ...base, lines, profiles: { "1": profile("1", [fixed("Vendor Fee", "2", "per_vendor_shipment")]) } });
    expect(r.totalCharges).toBe("0.00");
    expect(r.issues[0]).toMatchObject({ type: "unsupported_scope", component: "Vendor Fee" });
  });
  it("per_cart charges once", () => expect(run("per_cart")).toBe("2.00"));

  it("same per-cart charge at different amounts uses the higher one", () => {
    const r = calculate({ ...base, lines: [line("a", "1", "10"), line("b", "2", "10")], profiles: {
      "1": profile("1", [fixed("MPF", "3", "per_cart")]),
      "2": profile("2", [fixed("MPF", "5", "per_cart")]),
    } });
    expect(r.totalCharges).toBe("5.00");
  });
});

describe("missing data is never guessed", () => {
  it("no destination → no amounts", () => {
    const r = calculate({ ...base, destination: null, lines: [line("x", "71179090", "100")], profiles: {} });
    expect(r.status).toBe("no_destination");
    expect(r.totalCharges).toBe("0.00");
  });

  it("missing HSN and missing profile → partial, items named", () => {
    const r = calculate({ ...base,
      lines: [line("Jewellery", "71179090", "100"), line("Wallet", null, "50"), line("Bag", "42022220", "50")],
      profiles: { "71179090": usJewellery() } });
    expect(r.status).toBe("partial");
    expect(r.issues.map((i) => [i.type, i.productTitles])).toEqual([
      ["missing_hsn", ["Wallet"]],
      ["no_profile", ["Bag"]],
    ]);
    expect(r.totalCharges).toBe("24.00");
    expect(r.calculatedValue).toBe("100.00");
  });

  it("disabled and out-of-date components are skipped; none left → partial", () => {
    const r = calculate({ ...base, lines: [line("x", "1", "100")], profiles: { "1": profile("1", [
      pct("Off", "10", 1, { active: false }),
      pct("Expired", "10", 2, { effectiveTo: "2026-10-31" }),
      pct("Future", "10", 3, { effectiveFrom: "2027-01-01" }),
    ]) } });
    expect(r.status).toBe("partial");
    expect(r.issues[0].type).toBe("no_active_components");
  });

  it("fixed charge in another currency is left out, not converted (today's INR carts)", () => {
    const r = calculate({ ...base, currency: "INR", destinationCurrency: "USD", lines: [line("x", "71179090", "8300")], profiles: { "71179090": usJewellery() } });
    expect(r.summary.map((s) => [s.name, s.amount])).toEqual([["Basic Import Duty", "830.00"], ["Additional Tariff", "913.00"]]);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({ type: "currency_mismatch", component: "MPF", componentCurrency: "USD", componentAmount: "3" });
    expect(r.issues[0].message).toContain("3 USD");
    expect(r.status).toBe("partial");
    expect(r.currencyNote).toMatchObject({ cartCurrency: "INR", destinationCurrency: "USD" });
  });

  it("the same per-cart charge missing on several HSNs is reported once", () => {
    const r = calculate({ ...base, currency: "INR", lines: [line("a", "1", "100"), line("b", "2", "100")], profiles: {
      "1": profile("1", [fixed("MPF", "3", "per_cart")]), "2": profile("2", [fixed("MPF", "3", "per_cart")]),
    } });
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0].productTitles).toEqual(["a", "b"]);
  });

  it("no currency note when the cart is in the destination currency", () => {
    const r = calculate({ ...base, destinationCurrency: "USD", lines: [line("x", "71179090", "100")], profiles: { "71179090": usJewellery() } });
    expect(r.currencyNote).toBeNull();
    expect(r.status).toBe("complete");
  });
});

describe("rounding", () => {
  it("rounds half-up per component and totals add up", () => {
    const r = calculate({ ...base, lines: [line("x", "1", "33.33")], profiles: { "1": profile("1", [pct("A", "10", 1), pct("B", "11", 2)]) } });
    expect(r.groups[0].components.map((c) => c.amount)).toEqual(["3.33", "3.67"]);
    expect(r.totalCharges).toBe("7.00");
  });

  it("zero-decimal currencies round to whole units", () => {
    const r = calculate({ ...base, currency: "JPY", lines: [line("x", "1", "1005")], profiles: { "1": profile("1", [pct("A", "10", 1)]) } });
    expect(r.totalCharges).toBe("101");
  });
});
