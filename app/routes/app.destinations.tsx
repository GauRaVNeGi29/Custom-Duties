import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { COUNTRY_CODES, countryName } from "../lib/countries";
import { checkMarkets, currencyLabel, isCurrency, MARKETS_QUERY, SUPPORTED_CURRENCIES, type MarketsResponse } from "../lib/currency";

/**
 * Destinations: the countries offered in the cart selector and the currency
 * each one uses. Add a country or change a currency here – no code change.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const destinations = await db.destination.findMany({ where: { shop }, orderBy: [{ sortOrder: "asc" }, { displayName: "asc" }] });

  // Fixed charges per destination and currency, to spot charges that no longer match.
  const fixed = await db.taxComponent.groupBy({
    by: ["profileId", "currency"], where: { chargeType: "fixed", profile: { shop } }, _count: true,
  });
  const profiles = await db.rateProfile.findMany({ where: { shop }, select: { id: true, destinationId: true } });
  const destOfProfile = new Map(profiles.map((p) => [p.id, p.destinationId]));
  const fixedByDest = new Map<string, Record<string, number>>();
  for (const f of fixed) {
    const dest = destOfProfile.get(f.profileId)!;
    const m = fixedByDest.get(dest) ?? {};
    m[f.currency?.trim() ?? "none"] = (m[f.currency?.trim() ?? "none"] ?? 0) + f._count;
    fixedByDest.set(dest, m);
  }
  const profileCount = new Map<string, number>();
  profiles.forEach((p) => profileCount.set(p.destinationId, (profileCount.get(p.destinationId) ?? 0) + 1));

  let market: ReturnType<typeof checkMarkets> | null = null;
  let marketError: string | null = null;
  try {
    const body = (await (await admin.graphql(MARKETS_QUERY)).json()) as { data?: unknown; errors?: unknown };
    if (body.errors) throw new Error(JSON.stringify(body.errors));
    market = checkMarkets(body.data as MarketsResponse, destinations.map((d) => ({ countryCode: d.countryCode, currency: d.currency.trim() })));
  } catch (e) {
    marketError = `Could not read Shopify Markets: ${(e as Error).message}`;
  }

  return {
    destinations: destinations.map((d) => ({
      id: d.id, countryCode: d.countryCode, displayName: d.displayName, currency: d.currency.trim(), enabled: d.enabled, sortOrder: d.sortOrder,
      profiles: profileCount.get(d.id) ?? 0,
      fixedCurrencies: fixedByDest.get(d.id) ?? {},
      check: market?.checks.find((c) => c.countryCode === d.countryCode) ?? null,
    })),
    shopCurrency: market?.shopCurrency ?? null,
    enabledCurrencies: market?.enabledCurrencies ?? [],
    marketError,
    countries: COUNTRY_CODES.map((c) => ({ code: c, name: countryName(c) })).sort((a, b) => a.name.localeCompare(b.name)),
    currencies: [...SUPPORTED_CURRENCIES],
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const actor = session.onlineAccessInfo?.associated_user?.email ?? "admin";
  const form = await request.formData();
  const intent = String(form.get("intent"));

  if (intent === "save") {
    const id = String(form.get("id") ?? "");
    const countryCode = String(form.get("countryCode") ?? "").toUpperCase();
    const currency = String(form.get("currency") ?? "").toUpperCase();
    const displayName = String(form.get("displayName") ?? "").trim() || countryName(countryCode);
    const enabled = form.get("enabled") === "true";
    const sortOrder = Number(form.get("sortOrder") ?? 100) || 100;
    if (!COUNTRY_CODES.includes(countryCode)) return { error: "Choose a country." };
    if (!isCurrency(currency)) return { error: `"${currency}" is not a recognised currency code.` };

    const before = id ? await db.destination.findFirst({ where: { id, shop } }) : null;
    if (!id && (await db.destination.findFirst({ where: { shop, countryCode } }))) return { error: `${countryName(countryCode)} is already a destination.` };
    const saved = before
      ? await db.destination.update({ where: { id: before.id }, data: { displayName, currency, enabled, sortOrder } })
      : await db.destination.create({ data: { shop, countryCode, displayName, currency, enabled, sortOrder } });
    await db.auditLog.create({
      data: { shop, entity: "destination", entityId: saved.id, action: before ? "update" : "create",
        before: before ? { displayName: before.displayName, currency: before.currency.trim(), enabled: before.enabled } : undefined,
        after: { countryCode, displayName, currency, enabled }, actor },
    });
    return { ok: `${displayName} saved.` };
  }

  if (intent === "delete") {
    const id = String(form.get("id"));
    const dest = await db.destination.findFirst({ where: { id, shop }, include: { _count: { select: { profiles: true } } } });
    if (!dest) return { error: "Not found." };
    if (dest._count.profiles > 0) return { error: `${dest.displayName} has ${dest._count.profiles} rate configuration(s). Turn it off instead, or remove its rates first.` };
    await db.destination.delete({ where: { id } });
    await db.auditLog.create({ data: { shop, entity: "destination", entityId: id, action: "delete", before: { countryCode: dest.countryCode }, actor } });
    return { ok: `${dest.displayName} removed.` };
  }
  return { error: "Unknown action" };
};

type Dest = Awaited<ReturnType<typeof loader>>["destinations"][number];

export default function Destinations() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const [editing, setEditing] = useState<Partial<Dest> | null>(null);
  const busy = fetcher.state !== "idle";
  const res = fetcher.data;
  const mismatches = data.destinations.filter((d) => d.check && !d.check.matches);

  const save = (d: Partial<Dest>) => {
    fetcher.submit({
      intent: "save", id: d.id ?? "", countryCode: d.countryCode ?? "", displayName: d.displayName ?? "",
      currency: d.currency ?? "", enabled: String(d.enabled ?? true), sortOrder: String(d.sortOrder ?? 100),
    }, { method: "POST" });
    setEditing(null);
  };
  const cell = { padding: 6, borderBottom: "1px solid #eee", verticalAlign: "top" as const };

  return (
    <s-page heading="Destinations and currencies">
      <s-button slot="primary-action" onClick={() => setEditing({ enabled: true, sortOrder: 100 })}>Add destination</s-button>

      <s-section heading="How currencies work">
        <s-paragraph>
          Shopify carts are charged in INR for every country, and Bucks converts the amounts customers see. The duty block shows its
          amounts in your store&apos;s money format so Bucks converts them too. Percentage duties are calculated on the INR cart value.
          Fixed charges (such as MPF) are entered in INR; a fixed charge in any other currency is rejected, never converted.
        </s-paragraph>
        {data.marketError && <s-banner tone="warning">{data.marketError}</s-banner>}
        {data.shopCurrency && (
          <s-paragraph>
            Shopify store currency: {data.shopCurrency} · currencies enabled for customers: {data.enabledCurrencies.join(", ") || "none"}
          </s-paragraph>
        )}
        {mismatches.length > 0 && (
          <s-banner tone="warning">
            {mismatches.length} destination(s) have a currency here that differs from the currency Shopify charges carts in. Set them to the
            Shopify currency (INR), or their fixed charges will not be included.
          </s-banner>
        )}
      </s-section>

      {res && "error" in res && res.error && <s-banner tone="critical">{res.error}</s-banner>}
      {res && "ok" in res && res.ok && <s-banner tone="success">{res.ok}</s-banner>}

      {editing && (
        <s-section heading={editing.id ? `Edit ${editing.displayName}` : "Add destination"}>
          <s-stack direction="block" gap="base">
            <label>Country{" "}
              <select value={editing.countryCode ?? ""} disabled={!!editing.id} style={{ padding: 6 }}
                onChange={(e) => setEditing({ ...editing, countryCode: e.target.value, displayName: data.countries.find((c) => c.code === e.target.value)?.name })}>
                <option value="">Choose…</option>
                {data.countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
              </select>
            </label>
            <label>Name shown to customers{" "}
              <input value={editing.displayName ?? ""} onChange={(e) => setEditing({ ...editing, displayName: e.target.value })} style={{ padding: 6 }} />
            </label>
            <label>Currency{" "}
              <select value={editing.currency ?? ""} onChange={(e) => setEditing({ ...editing, currency: e.target.value })} style={{ padding: 6 }}>
                <option value="">Choose…</option>
                {data.currencies.map((c) => <option key={c} value={c}>{currencyLabel(c)}</option>)}
              </select>
            </label>
            <label>Order in the selector{" "}
              <input type="number" value={editing.sortOrder ?? 100} onChange={(e) => setEditing({ ...editing, sortOrder: Number(e.target.value) })} style={{ padding: 6, width: 80 }} />
            </label>
            <label>
              <input type="checkbox" checked={editing.enabled ?? true} onChange={(e) => setEditing({ ...editing, enabled: e.target.checked })} /> Offer in the cart selector
            </label>
            <s-stack direction="inline" gap="base">
              <s-button variant="primary" onClick={() => save(editing)} {...(busy ? { loading: true } : {})}>Save</s-button>
              <s-button variant="tertiary" onClick={() => setEditing(null)}>Cancel</s-button>
            </s-stack>
          </s-stack>
        </s-section>
      )}

      <s-section heading={`Destinations (${data.destinations.length})`}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
              <th style={{ padding: 6 }}>Country</th>
              <th style={{ padding: 6 }}>Your currency</th>
              <th style={{ padding: 6 }}>Shopify Markets</th>
              <th style={{ padding: 6 }}>Fixed charges</th>
              <th style={{ padding: 6 }}>HSN configs</th>
              <th style={{ padding: 6 }}>In selector</th>
              <th style={{ padding: 6 }} />
            </tr>
          </thead>
          <tbody>
            {data.destinations.map((d) => {
              const other = Object.entries(d.fixedCurrencies).filter(([c]) => c !== d.currency);
              return (
                <tr key={d.id}>
                  <td style={cell}>{d.displayName} ({d.countryCode})</td>
                  <td style={cell}>{d.currency}</td>
                  <td style={cell}>
                    {d.check ? (
                      <>
                        <s-badge tone={d.check.matches ? "success" : "warning"}>{d.check.shopifyCurrency ?? "not in a market"}</s-badge>
                        <div style={{ color: "#555", marginTop: 4 }}>{d.check.message}</div>
                      </>
                    ) : "–"}
                  </td>
                  <td style={cell}>
                    {Object.entries(d.fixedCurrencies).map(([c, n]) => `${n} in ${c}`).join(", ") || "none"}
                    {other.length > 0 && <div style={{ color: "#8a6100" }}>Some fixed charges are not in {d.currency}.</div>}
                  </td>
                  <td style={cell}>{d.profiles}</td>
                  <td style={cell}>{d.enabled ? "Yes" : "Off"}</td>
                  <td style={cell}>
                    <s-stack direction="inline" gap="small-200">
                      <s-button variant="tertiary" onClick={() => setEditing(d)}>Edit</s-button>
                      {d.profiles === 0 && <s-button variant="tertiary" tone="critical" onClick={() => fetcher.submit({ intent: "delete", id: d.id }, { method: "POST" })}>Remove</s-button>}
                    </s-stack>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
