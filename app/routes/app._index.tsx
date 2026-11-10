import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { exportRatesCsv, runRateImport, type ImportReport } from "../lib/rates/import.server";
import { getSettings, hsnCoverage, pollFullSync, startFullSync, type SyncStatus } from "../lib/products/sync.server";

/**
 * Phase 1 home: setup status, product sync, and CSV import/export.
 * The full HSN → country → component editor arrives in Phase 2.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = session.shop;
  // Finish a running product export if Shopify has completed it.
  let sync: SyncStatus;
  try {
    sync = await pollFullSync(db, admin.graphql, shop);
  } catch (e) {
    sync = { state: "failed", error: (e as Error).message };
  }
  const [settings, hsn, destinations, profiles, components, coverage, lastImport] = await Promise.all([
    getSettings(db, shop),
    db.hsn.count({ where: { shop } }),
    db.destination.findMany({ where: { shop }, orderBy: { displayName: "asc" } }),
    db.rateProfile.count({ where: { shop } }),
    db.taxComponent.count({ where: { profile: { shop } } }),
    hsnCoverage(db, shop),
    db.importJob.findFirst({ where: { shop }, orderBy: { createdAt: "desc" } }),
  ]);
  // HSN codes used by products that have no profile for some enabled destination
  const usedHsn = await db.productHsn.findMany({
    where: { shop, hsnResolved: { not: null } }, distinct: ["hsnResolved"], select: { hsnResolved: true },
  });
  const configured = await db.rateProfile.findMany({
    where: { shop, hsn: { code: { in: usedHsn.map((u) => u.hsnResolved!) } } },
    select: { hsn: { select: { code: true } }, destinationId: true },
  });
  const enabled = destinations.filter((d) => d.enabled);
  const have = new Set(configured.map((c) => `${c.hsn.code}|${c.destinationId}`));
  const gaps = usedHsn.flatMap((u) =>
    enabled.filter((d) => !have.has(`${u.hsnResolved}|${d.id}`)).map((d) => ({ hsn: u.hsnResolved!, country: d.displayName })),
  );

  return {
    counts: { hsn, destinations: destinations.length, profiles, components },
    destinations: destinations.map((d) => ({ name: d.displayName, code: d.countryCode, currency: d.currency, enabled: d.enabled })),
    coverage,
    gaps: gaps.slice(0, 50),
    gapCount: gaps.length,
    lastFullSyncAt: settings.lastFullSyncAt?.toISOString() ?? null,
    sync,
    lastImport: lastImport ? { status: lastImport.status, createdAt: lastImport.createdAt.toISOString(), fileName: lastImport.fileName } : null,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = form.get("intent");

  if (intent === "sync") {
    return { intent, sync: await startFullSync(db, admin.graphql, session.shop) };
  }
  if (intent === "export") {
    return { intent, csv: await exportRatesCsv(db, { shop: session.shop }) };
  }
  if (intent === "preview" || intent === "commit") {
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) return { intent, error: "Choose a CSV file first." };
    const report: ImportReport = await runRateImport(db, {
      shop: session.shop,
      csvText: await file.text(),
      mode: form.get("mode") === "replace_profiles" ? "replace_profiles" : "merge",
      dryRun: intent === "preview",
      actor: session.onlineAccessInfo?.associated_user?.email ?? "admin",
      fileName: file.name,
    });
    return { intent, report };
  }
  if (intent === "delete_all_rates") {
    if (String(form.get("confirm") ?? "").trim() !== "DELETE") {
      return { intent, error: 'Type DELETE in the box to confirm.' };
    }
    const shop = session.shop;
    const [hsnCount, componentCount] = await Promise.all([
      db.hsn.count({ where: { shop } }),
      db.taxComponent.count({ where: { profile: { shop } } }),
    ]);
    // HSN codes cascade to their country configurations and tax components.
    // Destinations, product HSN codes and settings are kept.
    await db.$transaction([
      db.hsn.deleteMany({ where: { shop } }),
      db.auditLog.create({
        data: {
          shop, entity: "rates", action: "delete_all",
          before: { hsnCodes: hsnCount, components: componentCount },
          actor: session.onlineAccessInfo?.associated_user?.email ?? "admin",
        },
      }),
    ]);
    return { intent, deleted: { hsnCodes: hsnCount, components: componentCount } };
  }
  return { intent, error: "Unknown action" };
};

type ActionData = Awaited<ReturnType<typeof action>>;

export default function Index() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const revalidator = useRevalidator();
  const syncing = data.sync.state === "running" || (fetcher.data && "sync" in fetcher.data && fetcher.data.sync?.state === "running");
  // While Shopify prepares the product export, check again every 5 seconds.
  useEffect(() => {
    if (!syncing) return;
    const t = setInterval(() => { if (revalidator.state === "idle") revalidator.revalidate(); }, 5000);
    return () => clearInterval(t);
  }, [syncing, revalidator]);
  const shopify = useAppBridge();
  const fileRef = useRef<HTMLInputElement>(null);
  const [mode, setMode] = useState("merge");
  const [confirmText, setConfirmText] = useState("");
  const busy = fetcher.state !== "idle";
  const result = fetcher.data;

  useEffect(() => {
    if (!result) return;
    if ("csv" in result && result.csv) {
      const url = URL.createObjectURL(new Blob([result.csv], { type: "text/csv" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `setu-duty-rates-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    }
    if ("sync" in result && result.sync?.state === "failed") shopify.toast.show(result.sync.error, { isError: true });
    if ("sync" in result && result.sync?.state === "running") revalidator.revalidate();
    if ("report" in result && result.report?.committed) shopify.toast.show("Rates imported");
  }, [result, shopify, revalidator]);

  const submitFile = (intent: "preview" | "commit") => {
    const file = fileRef.current?.files?.[0];
    const fd = new FormData();
    fd.set("intent", intent);
    fd.set("mode", mode);
    if (file) fd.set("file", file);
    fetcher.submit(fd, { method: "POST", encType: "multipart/form-data" });
  };

  const report = result && "report" in result ? result.report : null;
  const error = result && "error" in result ? result.error : null;

  return (
    <s-page heading="Setu Import Duties">
      <s-section heading="Rate configuration">
        <s-paragraph>
          {data.counts.hsn} HSN codes · {data.counts.destinations} destinations · {data.counts.profiles} HSN–country
          configurations · {data.counts.components} tax components
        </s-paragraph>
        {data.destinations.length > 0 && (
          <s-paragraph>
            Destinations: {data.destinations.map((d) => `${d.name} (${d.currency})${d.enabled ? "" : " – off"}`).join(", ")}
          </s-paragraph>
        )}
      </s-section>

      <s-section heading="Show duties on your cart">
        <s-ordered-list>
          <s-list-item>In Shopify admin go to Online Store, then Themes, then Customize on your theme.</s-list-item>
          <s-list-item>At the top, switch the page to Cart.</s-list-item>
          <s-list-item>In the section that holds the subtotal and checkout button, click Add block, open Apps, and choose Import duties estimate.</s-list-item>
          <s-list-item>Drag it below the subtotal and above the checkout button, then Save.</s-list-item>
          <s-list-item>If your store uses a slide-out cart, also open App embeds (puzzle icon) and turn on Duties in cart drawer.</s-list-item>
        </s-ordered-list>
        <s-paragraph>
          The block only shows estimates. It never changes the cart or checkout total. Customers see only the destinations listed under
          Destinations and currencies.
        </s-paragraph>
      </s-section>

      <s-section heading="Import / export rates (CSV)">
        <s-paragraph>
          Use the same columns as your rate sheet. Preview shows exactly what will be added, changed or removed;
          nothing is saved until you commit, and a file with any error is never applied.
        </s-paragraph>
        <s-stack direction="block" gap="base">
          <input ref={fileRef} type="file" accept=".csv,text/csv" aria-label="Rate CSV file" />
          <label>
            <input type="radio" name="mode" value="merge" checked={mode === "merge"} onChange={() => setMode("merge")} />{" "}
            Merge – add and update components in the file, keep everything else
          </label>
          <label>
            <input type="radio" name="mode" value="replace_profiles" checked={mode === "replace_profiles"} onChange={() => setMode("replace_profiles")} />{" "}
            Replace – for each HSN + country in the file, remove components not listed
          </label>
          <s-stack direction="inline" gap="base">
            <s-button onClick={() => submitFile("preview")} {...(busy ? { loading: true } : {})}>Preview import</s-button>
            <s-button variant="primary" onClick={() => submitFile("commit")} {...(busy ? { loading: true } : {})}
              {...(!report || report.dryRun === false || report.errorCount > 0 ? { disabled: true } : {})}>
              Commit import
            </s-button>
            <s-button variant="tertiary" onClick={() => fetcher.submit({ intent: "export" }, { method: "POST" })}>
              Export all rates
            </s-button>
          </s-stack>
          {error && <s-banner tone="critical">{error}</s-banner>}
          {report && <ImportSummary report={report} />}
        </s-stack>
      </s-section>

      <s-section heading="Delete all rates">
        <s-paragraph>
          Removes every HSN code, country configuration and tax component, so you can start again from a fresh CSV.
          Destinations, product HSN codes and settings are kept. Export your rates first if you may need them again.
        </s-paragraph>
        <s-stack direction="inline" gap="base">
          <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder="Type DELETE" aria-label="Type DELETE to confirm" style={{ padding: 6, width: 140 }} />
          <s-button tone="critical" {...(confirmText !== "DELETE" ? { disabled: true } : {})} {...(busy ? { loading: true } : {})}
            onClick={() => { fetcher.submit({ intent: "delete_all_rates", confirm: confirmText }, { method: "POST" }); setConfirmText(""); }}>
            Delete all rates
          </s-button>
        </s-stack>
        {result && "deleted" in result && result.deleted && (
          <s-banner tone="success">
            Deleted {result.deleted.components} tax components across {result.deleted.hsnCodes} HSN codes.
          </s-banner>
        )}
      </s-section>

      <s-section heading="Products and HSN codes">
        {syncing && (
          <s-banner tone="info">
            Syncing products from Shopify… {data.sync.state === "running" && data.sync.objectCount > 0 ? `${data.sync.objectCount} variants read so far. ` : ""}
            Large catalogues take a few minutes. You can leave this page and come back.
          </s-banner>
        )}
        {data.sync.state === "done" && <s-banner tone="success">Product sync finished: {data.sync.variants} variants from {data.sync.products} products.</s-banner>}
        {data.sync.state === "failed" && <s-banner tone="critical">{data.sync.error}</s-banner>}
        {!syncing && !data.lastFullSyncAt && (
          <s-banner tone="warning">Products have not been synced yet. Click Sync all products so the cart can find each product&apos;s HSN code.</s-banner>
        )}
        <s-paragraph>
          {data.coverage.variants} variants synced · {data.coverage.missingHsn} without an HSN code
          {data.lastFullSyncAt ? ` · last full sync ${new Date(data.lastFullSyncAt).toLocaleString()}` : " · full sync not run yet"}
        </s-paragraph>
        <s-paragraph>
          {"HSN codes are read from the variant override, then the product's HSN code field (both managed by your team)."}
        </s-paragraph>
        <s-button onClick={() => fetcher.submit({ intent: "sync" }, { method: "POST" })} {...(busy || syncing ? { loading: true } : {})}>
          {data.lastFullSyncAt ? "Resync all products" : "Sync all products"}
        </s-button>
      </s-section>

      <s-section heading={`Missing configuration (${data.gapCount})`}>
        {data.gapCount === 0 ? (
          <s-paragraph>Every HSN code used by your products is configured for every enabled destination.</s-paragraph>
        ) : (
          <s-unordered-list>
            {data.gaps.map((g) => (
              <s-list-item key={`${g.hsn}-${g.country}`}>HSN {g.hsn} has no rates for {g.country}</s-list-item>
            ))}
          </s-unordered-list>
        )}
      </s-section>
    </s-page>
  );
}

function ImportSummary({ report }: { report: ImportReport }) {
  const s = report.summary;
  return (
    <s-box padding="base" borderWidth="base" borderRadius="base">
      <s-stack direction="block" gap="small-200">
        <s-heading>
          {report.committed ? "Imported" : report.errorCount ? "Cannot import – fix the errors below" : "Preview – nothing saved yet"}
        </s-heading>
        <s-paragraph>
          {report.rowCount} rows · {s.componentsCreated} components to add · {s.componentsUpdated} to change ·{" "}
          {s.componentsDeleted} to remove · {s.componentsUnchanged} unchanged · {s.hsnCreated} new HSN codes ·{" "}
          {s.destinationsCreated} new destinations
        </s-paragraph>
        {report.updated.slice(0, 20).map((u) => (
          <s-paragraph key={`${u.hsn}-${u.destination}-${u.name}`}>
            Change: HSN {u.hsn} → {u.destination} · {u.name}:{" "}
            {Object.entries(u.changes ?? {}).map(([k, v]) => `${k} ${String(v.from)} → ${String(v.to)}`).join(", ")}
          </s-paragraph>
        ))}
        {report.deleted.slice(0, 50).map((d) => (
          <s-paragraph key={`del-${d.hsn}-${d.destination}-${d.name}`}>
            <s-text tone="critical">Remove:</s-text> HSN {d.hsn} → {d.destination} · {d.name}
          </s-paragraph>
        ))}
        {report.issues.slice(0, 100).map((i, n) => (
          <s-paragraph key={n}>
            <s-text tone={i.severity === "error" ? "critical" : "caution"}>
              {i.severity === "error" ? "Error" : "Warning"}
              {i.line > 1 ? ` (line ${i.line}${i.column ? `, ${i.column}` : ""})` : ""}:
            </s-text>{" "}
            {i.message}
          </s-paragraph>
        ))}
      </s-stack>
    </s-box>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
