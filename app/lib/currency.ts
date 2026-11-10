// Currency helpers. Currencies are data, not code: any ISO 4217 code can be
// set on a destination or a fixed charge in admin or by CSV.

export const SUPPORTED_CURRENCIES: readonly string[] = Intl.supportedValuesOf("currency");

export const isCurrency = (code: string | null | undefined): code is string =>
  !!code && SUPPORTED_CURRENCIES.includes(code.toUpperCase());

export function currencyLabel(code: string): string {
  try {
    return `${code} – ${new Intl.DisplayNames(["en"], { type: "currency" }).of(code)}`;
  } catch {
    return code;
  }
}

/** Shape returned by the MARKETS_QUERY below. */
export interface MarketsResponse {
  shop: { currencyCode: string; enabledPresentmentCurrencies: string[] };
  markets: {
    nodes: {
      name: string;
      status: string;
      currencySettings: { localCurrencies: boolean; baseCurrency: { currencyCode: string } | null } | null;
      conditions: { regionsCondition: { regions: { nodes: { name: string; code?: string; currency?: { currencyCode: string } }[] } } | null } | null;
    }[];
  };
}

export const MARKETS_QUERY = `#graphql
  query SetuMarkets {
    shop { currencyCode enabledPresentmentCurrencies }
    markets(first: 50) {
      nodes {
        name
        status
        currencySettings { localCurrencies baseCurrency { currencyCode } }
        conditions {
          regionsCondition {
            regions(first: 250) {
              nodes { name ... on MarketRegionCountry { code currency { currencyCode } } }
            }
          }
        }
      }
    }
  }
`;

export interface MarketCheck {
  countryCode: string;
  market: string | null;
  marketActive: boolean;
  /** Currency Shopify will price this country's carts in. */
  shopifyCurrency: string | null;
  configuredCurrency: string;
  matches: boolean;
  message: string;
}

/**
 * Compare each destination's configured currency with the currency Shopify
 * Markets will actually use for carts in that country.
 */
export function checkMarkets(
  data: MarketsResponse,
  destinations: { countryCode: string; currency: string }[],
): { shopCurrency: string; enabledCurrencies: string[]; checks: MarketCheck[] } {
  const byCountry = new Map<string, { market: string; active: boolean; currency: string | null }>();
  for (const m of data.markets.nodes) {
    for (const r of m.conditions?.regionsCondition?.regions.nodes ?? []) {
      if (!r.code) continue;
      const currency = r.currency?.currencyCode ?? m.currencySettings?.baseCurrency?.currencyCode ?? data.shop.currencyCode;
      byCountry.set(r.code, { market: m.name, active: m.status === "ACTIVE", currency });
    }
  }
  const checks = destinations.map((d) => {
    const m = byCountry.get(d.countryCode);
    const shopifyCurrency = m?.currency ?? null;
    const matches = shopifyCurrency === d.currency;
    let message: string;
    if (!m) message = "This country is not in any Shopify market, so customers there may not be able to buy.";
    else if (!m.active) message = `The ${m.market} market is not active.`;
    else if (matches) message = `Shopify prices carts in ${shopifyCurrency}, matching your setting.`;
    else message = `Shopify prices carts for this country in ${shopifyCurrency}, not ${d.currency}. Percentage duties still calculate correctly in ${shopifyCurrency}, but fixed charges set in ${d.currency} will be shown as not included.`;
    return { countryCode: d.countryCode, market: m?.market ?? null, marketActive: m?.active ?? false, shopifyCurrency, configuredCurrency: d.currency, matches: !!m && m.active && matches, message };
  });
  return { shopCurrency: data.shop.currencyCode, enabledCurrencies: data.shop.enabledPresentmentCurrencies, checks };
}
