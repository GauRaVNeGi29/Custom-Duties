import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useSearchParams } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  applyHsnChanges, configuredHsnCodes, exportProductHsnCsv, hsnCounts, listProducts,
  planBulkSet, planCopyFromShopify, planProductHsnCsv, unconfiguredWarnings,
  type HsnChange, type HsnIssue, type ProductFilter,
} from "../lib/products/hsn-admin.server";
import { normaliseHsn } from "../lib/products/sync.server";

/**
 * Products & HSN codes – managed by the Setu Store team only.
 * Edit one product, bulk-set many, import/export CSV, find missing codes,
 * and copy existing Shopify HS codes into the HSN field once.
 */

const FILTERS: { value: ProductFilter; label: string }[] = [
  { value: "all", label: "All products" },
  { value: "missing", label: "Missing HSN" },
  { value: "unconfigured", label: "HSN without rates" },
  { value: "has_override", label: "Has variant override" },
];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const filter = (url.searchParams.get("filter") as ProductFilter) || "all";
  const search = url.searchParams.get("q") ?? "";
  const page = Number(url.searchParams.get("page") ?? 1);
  const [list, counts] = await Promise.all([
    listProducts(db, { shop: session.shop, search, filter, page }),
    hsnCounts(db, session.shop),
  ]);
  return { ...list, counts, filter, search };
};

type Preview = { changes: { title: string; target: string; from: string | null; to: string | null }[]; total: number; issues: HsnIssue[] };
const preview = (changes: HsnChange[], issues: HsnIssue[]): Preview => ({
  changes: changes.slice(0, 200).map((c) => ({ title: c.title, target: c.target, from: c.from, to: c.to })),
  total: changes.length,
  issues,
});

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  const actor = session.onlineAccessInfo?.associated_user?.email ?? "admin";
  const form = await request.formData();
  const intent = String(form.get("intent"));
  const map = () => db.productHsn.findMany({ where: { shop } });
  const configured = await configuredHsnCodes(db, shop);

  if (intent === "save") {
    // one product: product-level HSN + per-variant overrides
    const productId = BigInt(String(form.get("productId")));
    const rows = await db.productHsn.findMany({ where: { shop, productId } });
    if (!rows.length) return { intent, error: "Product not found; run a resync." };
    const issues: HsnIssue[] = [];
    const changes: HsnChange[] = [];
    const read = (raw: FormDataEntryValue | null, label: string) => {
      const s = String(raw ?? "").trim();
      if (!s) return null;
      const v = normaliseHsn(s);
      if (!v) issues.push({ line: 0, severity: "error", message: `${label}: "${s}" is not a valid HSN code (4–10 digits).` });
      return v;
    };
    const productValue = read(form.get("productHsn"), "Product HSN");
    if (rows[0].hsnProductMetafield !== productValue) {
      changes.push({ target: "product", productId, title: rows[0].productTitle, from: rows[0].hsnProductMetafield, to: productValue });
    }
    for (const r of rows) {
      const field = `override_${r.variantId}`;
      if (!form.has(field)) continue;
      const v = read(form.get(field), r.variantTitle ?? r.sku ?? String(r.variantId));
      if (r.hsnVariantMetafield !== v) changes.push({ target: "variant", productId, variantId: r.variantId, title: `${r.productTitle} – ${r.variantTitle ?? r.sku}`, from: r.hsnVariantMetafield, to: v });
    }
    if (issues.length) return { intent, error: issues.map((i) => i.message).join(" ") };
    const result = await applyHsnChanges(db, admin.graphql, shop, changes, actor);
    return { intent, result, warnings: unconfiguredWarnings(changes, configured) };
  }

  if (intent === "bulk") {
    const ids = String(form.get("productIds") ?? "").split(",").filter(Boolean).map((x) => BigInt(x));
    const { changes, issues } = planBulkSet(await map(), ids, String(form.get("hsn") ?? ""));
    if (issues.some((i) => i.severity === "error")) return { intent, error: issues.map((i) => i.message).join(" ") };
    const result = await applyHsnChanges(db, admin.graphql, shop, changes, actor);
    return { intent, result, warnings: unconfiguredWarnings(changes, configured) };
  }

  if (intent === "csv_preview" || intent === "csv_commit") {
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) return { intent, error: "Choose a CSV file first." };
    const plan = planProductHsnCsv(await map(), await file.text());
    const issues = [...plan.issues, ...unconfiguredWarnings(plan.changes, configured)];
    const hasErrors = issues.some((i) => i.severity === "error");
    if (intent === "csv_preview" || hasErrors) return { intent, preview: preview(plan.changes, issues), canCommit: !hasErrors && plan.changes.length > 0 };
    const result = await applyHsnChanges(db, admin.graphql, shop, plan.changes, actor);
    return { intent, result, preview: preview(plan.changes, issues) };
  }

  if (intent === "copy_preview" || intent === "copy_commit") {
    const plan = planCopyFromShopify(await map());
    const issues = [...plan.issues, ...unconfiguredWarnings(plan.changes, configured)];
    if (intent === "copy_preview") return { intent, preview: preview(plan.changes, issues), canCommit: plan.changes.length > 0 };
    const result = await applyHsnChanges(db, admin.graphql, shop, plan.changes, actor);
    return { intent, result, preview: preview(plan.changes, issues) };
  }

  if (intent === "export") {
    const filter = (String(form.get("filter") ?? "all") as ProductFilter);
    return { intent, csv: await exportProductHsnCsv(db, { shop, filter }) };
  }
  return { intent, error: "Unknown action" };
};

type ActionData = Awaited<ReturnType<typeof action>>;

export default function Products() {
  const data = useLoaderData<typeof loader>();
  const [params, setParams] = useSearchParams();
  const fetcher = useFetcher<ActionData>();
  const shopify = useAppBridge();
  const fileRef = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkHsn, setBulkHsn] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const busy = fetcher.state !== "idle";
  const res = fetcher.data;

  useEffect(() => {
    if (!res) return;
    if ("csv" in res && res.csv) {
      const url = URL.createObjectURL(new Blob([res.csv], { type: "text/csv" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `setu-product-hsn-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    }
    if ("result" in res && res.result) {
      shopify.toast.show(res.result.failed.length ? `${res.result.applied} saved, ${res.result.failed.length} failed` : `${res.result.applied} HSN change(s) saved`);
    }
  }, [res, shopify]);

  const submit = (intent: string, fields: Record<string, string> = {}, withFile = false) => {
    const fd = new FormData();
    fd.set("intent", intent);
    Object.entries(fields).forEach(([k, v]) => fd.set(k, v));
    const file = fileRef.current?.files?.[0];
    if (withFile && file) fd.set("file", file);
    fetcher.submit(fd, { method: "POST", ...(withFile ? { encType: "multipart/form-data" } : {}) });
  };
  const setParam = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    if (v) next.set(k, v); else next.delete(k);
    if (k !== "page") next.delete("page");
    setParams(next);
  };
  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const prev = res && "preview" in res ? res.preview : null;
  const canCommit = res && "canCommit" in res ? res.canCommit : false;
  const isCopy = res?.intent?.startsWith("copy");
  const error = res && "error" in res ? res.error : null;
  const result = res && "result" in res ? res.result : null;
  const warnings = res && "warnings" in res ? res.warnings : null;

  return (
    <s-page heading="Products and HSN codes">
      <s-section heading="Overview">
        <s-paragraph>
          {data.counts.products} products · {data.counts.missing} missing HSN · {data.counts.unconfigured} with an HSN that has no rates yet
        </s-paragraph>
        <s-paragraph>
          HSN codes are stored on each product in Shopify (an app-owned field only your team and this app can change). You can also edit the
          field on the product page in Shopify admin.
        </s-paragraph>
        {data.counts.withShopifyOnly > 0 && (
          <s-banner tone="info">
            {data.counts.withShopifyOnly} products have no HSN yet but do have a Shopify HS code (set on the variant in Shopify, which sellers
            may be able to edit). Preview copying those codes into the HSN field once; after that, only your team controls them.
            <s-stack direction="inline" gap="base">
              <s-button onClick={() => submit("copy_preview")} {...(busy ? { loading: true } : {})}>Preview copy from Shopify HS codes</s-button>
            </s-stack>
          </s-banner>
        )}
      </s-section>

      <s-section heading="Find products">
        <s-stack direction="inline" gap="base">
          <input type="search" defaultValue={data.search} placeholder="Title, SKU, vendor, HSN or ID" aria-label="Search products"
            onKeyDown={(e) => { if (e.key === "Enter") setParam("q", (e.target as HTMLInputElement).value); }} style={{ minWidth: 280, padding: 6 }} />
          <select value={data.filter} onChange={(e) => setParam("filter", e.target.value)} aria-label="Filter" style={{ padding: 6 }}>
            {FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
          <s-button variant="tertiary" onClick={() => submit("export", { filter: data.filter })}>Export this list (CSV)</s-button>
        </s-stack>
      </s-section>

      <s-section heading={`Products (${data.total})`}>
        {selected.size > 0 && (
          <s-stack direction="inline" gap="base">
            <s-text>{selected.size} selected · set product HSN to</s-text>
            <input value={bulkHsn} onChange={(e) => setBulkHsn(e.target.value)} placeholder="e.g. 71179090" aria-label="HSN for selected products" style={{ padding: 6, width: 140 }} />
            <s-button variant="primary" onClick={() => { submit("bulk", { productIds: [...selected].join(","), hsn: bulkHsn }); setSelected(new Set()); }} {...(busy ? { loading: true } : {})}>
              Apply to {selected.size}
            </s-button>
            <s-button variant="tertiary" onClick={() => setSelected(new Set())}>Clear selection</s-button>
          </s-stack>
        )}
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
              <th style={{ padding: 6 }}>
                <input type="checkbox" aria-label="Select all on page"
                  checked={data.products.length > 0 && data.products.every((p) => selected.has(p.productId))}
                  onChange={(e) => setSelected(e.target.checked ? new Set(data.products.map((p) => p.productId)) : new Set())} />
              </th>
              <th style={{ padding: 6 }}>Product</th>
              <th style={{ padding: 6 }}>Vendor</th>
              <th style={{ padding: 6 }}>HSN code</th>
              <th style={{ padding: 6 }}>Shopify HS code</th>
              <th style={{ padding: 6 }}>Rates</th>
              <th style={{ padding: 6 }} />
            </tr>
          </thead>
          <tbody>
            {data.products.map((p) => {
              const resolved = [...new Set(p.variants.map((v) => v.resolved ?? ""))];
              const allConfigured = p.variants.every((v) => v.configured);
              return (
                <ProductRow key={p.productId} p={p} open={open === p.productId} onToggleOpen={() => setOpen(open === p.productId ? null : p.productId)}
                  selected={selected.has(p.productId)} onSelect={() => toggle(p.productId)}
                  status={resolved.includes("") ? "Missing HSN" : allConfigured ? "Configured" : "No rates yet"}
                  onSave={(fields) => submit("save", { productId: p.productId, ...fields })} busy={busy} />
              );
            })}
          </tbody>
        </table>
        <s-stack direction="inline" gap="base">
          <s-button variant="tertiary" {...(data.page <= 1 ? { disabled: true } : {})} onClick={() => setParam("page", String(data.page - 1))}>Previous</s-button>
          <s-text>Page {data.page} of {pages}</s-text>
          <s-button variant="tertiary" {...(data.page >= pages ? { disabled: true } : {})} onClick={() => setParam("page", String(data.page + 1))}>Next</s-button>
        </s-stack>
      </s-section>

      <s-section heading="Bulk update by CSV">
        <s-paragraph>
          Export, edit the hsn_code column (and variant_hsn_override where one variant differs), then upload. A blank cell clears that value;
          a column left out of the file is not touched. Preview first: nothing changes in Shopify until you confirm.
        </s-paragraph>
        <s-stack direction="inline" gap="base">
          <input ref={fileRef} type="file" accept=".csv,text/csv" aria-label="Product HSN CSV" />
          <s-button onClick={() => submit("csv_preview", {}, true)} {...(busy ? { loading: true } : {})}>Preview</s-button>
        </s-stack>
      </s-section>

      {(error || result || prev || (warnings && warnings.length > 0)) && (
        <s-section heading="Result">
          {error && <s-banner tone="critical">{error}</s-banner>}
          {result && (
            <s-banner tone={result.failed.length ? "warning" : "success"}>
              {result.applied} change(s) saved to Shopify.
              {result.failed.slice(0, 20).map((f, i) => <s-paragraph key={i}>Failed: {f.title} – {f.message}</s-paragraph>)}
            </s-banner>
          )}
          {warnings?.map((w, i) => <s-banner key={i} tone="warning">{w.message}</s-banner>)}
          {prev && !result && (
            <s-stack direction="block" gap="small-200">
              <s-heading>{prev.total} change(s) to make</s-heading>
              {prev.issues.map((i, n) => (
                <s-paragraph key={n}>
                  <s-text tone={i.severity === "error" ? "critical" : "caution"}>{i.severity === "error" ? "Error" : "Warning"}{i.line > 1 ? ` (line ${i.line})` : ""}:</s-text> {i.message}
                </s-paragraph>
              ))}
              {prev.changes.slice(0, 50).map((c, n) => (
                <s-paragraph key={n}>{c.title} ({c.target}): {c.from ?? "–"} → {c.to ?? "removed"}</s-paragraph>
              ))}
              {prev.total > 50 && <s-paragraph>… and {prev.total - 50} more</s-paragraph>}
              {canCommit && (
                <s-button variant="primary" onClick={() => (isCopy ? submit("copy_commit") : submit("csv_commit", {}, true))} {...(busy ? { loading: true } : {})}>
                  Confirm {prev.total} change(s)
                </s-button>
              )}
            </s-stack>
          )}
        </s-section>
      )}
    </s-page>
  );
}

type Row = Awaited<ReturnType<typeof loader>>["products"][number];

function ProductRow({ p, open, onToggleOpen, selected, onSelect, status, onSave, busy }: {
  p: Row; open: boolean; onToggleOpen: () => void; selected: boolean; onSelect: () => void;
  status: string; onSave: (fields: Record<string, string>) => void; busy: boolean;
}) {
  const [productHsn, setProductHsn] = useState(p.productHsn ?? "");
  const [overrides, setOverrides] = useState<Record<string, string>>(Object.fromEntries(p.variants.map((v) => [v.variantId, v.override ?? ""])));
  const multi = p.variants.length > 1;
  const save = () => onSave({
    productHsn,
    ...(multi ? Object.fromEntries(Object.entries(overrides).map(([k, v]) => [`override_${k}`, v])) : {}),
  });
  const cell = { padding: 6, borderBottom: "1px solid #eee", verticalAlign: "top" as const };
  return (
    <>
      <tr>
        <td style={cell}><input type="checkbox" checked={selected} onChange={onSelect} aria-label={`Select ${p.title}`} /></td>
        <td style={cell}>{p.title}{multi && <div style={{ color: "#666" }}>{p.variants.length} variants</div>}</td>
        <td style={cell}>{p.vendor}</td>
        <td style={cell}>
          <input value={productHsn} onChange={(e) => setProductHsn(e.target.value)} placeholder="Add HSN" aria-label={`HSN for ${p.title}`} style={{ width: 110, padding: 4 }} />
        </td>
        <td style={cell}>{p.shopifyHsCodes.join(", ") || "–"}</td>
        <td style={cell}>{status}</td>
        <td style={cell}>
          <s-stack direction="inline" gap="small-200">
            <s-button onClick={save} {...(busy ? { loading: true } : {})}>Save</s-button>
            {multi && <s-button variant="tertiary" onClick={onToggleOpen}>{open ? "Hide variants" : "Variants"}</s-button>}
          </s-stack>
        </td>
      </tr>
      {open && p.variants.map((v) => (
        <tr key={v.variantId} style={{ background: "#fafafa" }}>
          <td style={cell} />
          <td style={cell} colSpan={2}>↳ {v.title ?? v.sku ?? v.variantId}</td>
          <td style={cell}>
            <input value={overrides[v.variantId]} onChange={(e) => setOverrides((o) => ({ ...o, [v.variantId]: e.target.value }))}
              placeholder="Same as product" aria-label={`HSN override for ${v.title ?? v.variantId}`} style={{ width: 110, padding: 4 }} />
          </td>
          <td style={cell} colSpan={2}>Uses {v.resolved ?? "no HSN"}{v.resolved && !v.configured ? " (no rates yet)" : ""}</td>
          <td style={cell} />
        </tr>
      ))}
    </>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
