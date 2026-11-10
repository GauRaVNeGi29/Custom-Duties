import { describe, expect, it } from "vitest";
import { checkMarkets, type MarketsResponse } from "../app/lib/currency";

// Shape of Setu Store's live Markets response on 4 Nov 2026: every market priced in INR.
const market = (name: string, code: string, currency = "INR") => ({
  name, status: "ACTIVE", currencySettings: null,
  conditions: { regionsCondition: { regions: { nodes: [{ name, code, currency: { currencyCode: currency } }] } } },
});
const setuToday: MarketsResponse = {
  shop: { currencyCode: "INR", enabledPresentmentCurrencies: ["INR"] },
  markets: { nodes: [
    market("Australia", "AU"), market("Canada", "CA"), market("Germany", "DE"),
    market("India", "IN"), market("United Kingdom", "GB"), market("United States", "US"),
  ] },
};
const intended = [
  { countryCode: "US", currency: "USD" }, { countryCode: "GB", currency: "GBP" }, { countryCode: "DE", currency: "EUR" },
  { countryCode: "AU", currency: "AUD" }, { countryCode: "CA", currency: "CAD" }, { countryCode: "FR", currency: "EUR" },
];

describe("Shopify Markets currency check", () => {
  it("flags every destination while all markets are priced in INR", () => {
    const r = checkMarkets(setuToday, intended);
    expect(r.shopCurrency).toBe("INR");
    expect(r.checks.map((c) => [c.countryCode, c.shopifyCurrency, c.matches])).toEqual([
      ["US", "INR", false], ["GB", "INR", false], ["DE", "INR", false],
      ["AU", "INR", false], ["CA", "INR", false], ["FR", null, false],
    ]);
    expect(r.checks[5].message).toContain("not in any Shopify market");
  });

  it("matches once local currencies are turned on", () => {
    const local: MarketsResponse = {
      shop: { currencyCode: "INR", enabledPresentmentCurrencies: ["INR", "USD", "GBP"] },
      markets: { nodes: [market("United States", "US", "USD"), market("United Kingdom", "GB", "GBP")] },
    };
    expect(checkMarkets(local, intended.slice(0, 2)).checks.every((c) => c.matches)).toBe(true);
  });
});
