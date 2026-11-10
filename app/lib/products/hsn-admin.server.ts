import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import type { Prisma, PrismaClient, ProductHsn } from "@prisma/client";
import { getSettings, normaliseHsn, resolveHsn, type AdminGraphql } from "./sync.server";

/**
 * Admin tools for the Setu Store team to manage product HSN codes:
 * per-product edit, bulk set, CSV import/export, missing-HSN list, and a
 * one-time copy from Shopify's own HS code field.
 *
 * Every change is written to the app-owned metafield ($app:hsn_code) in
 * Shopify, then mirrored into the local ProductHsn map so the cart sees it at once.
 */

export interface HsnChange {
  target: "product" | "variant";
  productId: bigint;
  variantId?: bigint;
  title: string;
  from: string | null;
  to: string | null; // null = remove the value
}

export interface HsnIssue {
  line: number;
  severity: "error" | "warning";
  message: string;
}

const productGid = (id: bigint) => `gid://shopify/Product/${id}`;
const variantGid = (id: bigint) => `gid://shopify/ProductVariant/${id}`;

// ---------------------------------------------------------------------------
// Listing (admin Products screen)
// ---------------------------------------------------------------------------

export type ProductFilter = "all" | "missing" | "unconfigured" | "has_override";

export async function listProducts(
  db: PrismaClient,
  opts: { shop: string; search?: string; filter?: ProductFilter; page?: number; pageSize?: number },
) {
  const pageSize = opts.pageSize ?? 50;
  const page = Math.max(1, opts.page ?? 1);
  const configured = await configuredHsnCodes(db, opts.shop);

  const where: Prisma.ProductHsnWhereInput = { shop: opts.shop };
  const q = opts.search?.trim();
  if (q) {
    where.OR = [
      { productTitle: { contains: q, mode: "insensitive" } },
      { sku: { contains: q, mode: "insensitive" } },
      { vendor: { contains: q, mode: "insensitive" } },
      { hsnResolved: { startsWith: q.replace(/[\s.]/g, "") } },
      ...(/^\d+$/.test(q) ? [{ productId: BigInt(q) }, { variantId: BigInt(q) }] : []),
    ];
  }
  if (opts.filter === "missing") where.hsnResolved = null;
  if (opts.filter === "unconfigured") where.AND = [{ hsnResolved: { not: null } }, { hsnResolved: { notIn: [...configured] } }];
  if (opts.filter === "has_override") where.hsnVariantMetafield = { not: null };

  const ids = await db.productHsn.findMany({
    where, distinct: ["productId"], select: { productId: true, productTitle: true },
    orderBy: [{ productTitle: "asc" }, { productId: "asc" }],
  });
  const pageIds = ids.slice((page - 1) * pageSize, page * pageSize).map((r) => r.productId);
  const rows = await db.productHsn.findMany({
    where: { shop: opts.shop, productId: { in: pageIds } },
    orderBy: [{ productTitle: "asc" }, { variantId: "asc" }],
  });
  const products = pageIds.map((pid) => {
    const variants = rows.filter((r) => r.productId === pid);
    const first = variants[0];
    return {
      productId: pid.toString(),
      title: first.productTitle,
      vendor: first.vendor,
      productHsn: first.hsnProductMetafield,
      shopifyHsCodes: [...new Set(variants.map((v) => v.hsnShopify).filter(Boolean))] as string[],
      variants: variants.map((v) => ({
        variantId: v.variantId.toString(),
        title: v.variantTitle,
        sku: v.sku,
        override: v.hsnVariantMetafield,
        resolved: v.hsnResolved,
        configured: v.hsnResolved ? configured.has(v.hsnResolved) : false,
      })),
    };
  });
  return { products, total: ids.length, page, pageSize };
}

/** HSN codes that have at least one rate configuration. */
export async function configuredHsnCodes(db: PrismaClient, shop: string) {
  const rows = await db.hsn.findMany({ where: { shop, profiles: { some: {} } }, select: { code: true } });
  return new Set(rows.map((r) => r.code));
}

export async function hsnCounts(db: PrismaClient, shop: string) {
  const configured = [...(await configuredHsnCodes(db, shop))];
  const distinctProducts = async (where: Prisma.ProductHsnWhereInput) =>
    (await db.productHsn.findMany({ where: { shop, ...where }, distinct: ["productId"], select: { productId: true } })).length;
  const [products, missing, unconfigured, withShopifyOnly] = await Promise.all([
    distinctProducts({}),
    distinctProducts({ hsnResolved: null }),
    distinctProducts({ hsnResolved: { not: null, notIn: configured } }),
    distinctProducts({ hsnResolved: null, hsnShopify: { not: null } }),
  ]);
  return { products, missing, unconfigured, withShopifyOnly };
}

// ---------------------------------------------------------------------------
// Planning changes (pure)
// ---------------------------------------------------------------------------

/** Set (or clear, with hsn = null) the product-level HSN for many products. */
export function planBulkSet(map: ProductHsn[], productIds: bigint[], hsn: string | null): { changes: HsnChange[]; issues: HsnIssue[] } {
  const issues: HsnIssue[] = [];
  const value = hsn == null || hsn.trim() === "" ? null : normaliseHsn(hsn);
  if (hsn && hsn.trim() && !value) {
    return { changes: [], issues: [{ line: 0, severity: "error", message: `"${hsn}" is not a valid HSN code (4–10 digits).` }] };
  }
  const changes: HsnChange[] = [];
  for (const pid of new Set(productIds)) {
    const row = map.find((r) => r.productId === pid);
    if (!row) { issues.push({ line: 0, severity: "error", message: `Product ${pid} is not in the synced catalogue; run a resync.` }); continue; }
    if (row.hsnProductMetafield !== value) {
      changes.push({ target: "product", productId: pid, title: row.productTitle, from: row.hsnProductMetafield, to: value });
    }
  }
  return { changes, issues };
}

/**
 * Bring Shopify's existing HS codes into the HSN field, once, for products
 * that have no HSN yet. Same code on every variant → set on the product;
 * different codes → set on each variant as an override.
 */
export function planCopyFromShopify(map: ProductHsn[]): { changes: HsnChange[]; issues: HsnIssue[] } {
  const changes: HsnChange[] = [];
  const issues: HsnIssue[] = [];
  const byProduct = new Map<bigint, ProductHsn[]>();
  for (const r of map) byProduct.set(r.productId, [...(byProduct.get(r.productId) ?? []), r]);

  for (const [pid, rows] of byProduct) {
    if (rows.some((r) => r.hsnProductMetafield || r.hsnVariantMetafield)) continue; // team already set it
    const codes = rows.map((r) => normaliseHsn(r.hsnShopify));
    const present = codes.filter(Boolean) as string[];
    if (present.length === 0) continue;
    const unique = new Set(present);
    if (unique.size === 1 && present.length === rows.length) {
      changes.push({ target: "product", productId: pid, title: rows[0].productTitle, from: null, to: present[0] });
    } else {
      rows.forEach((r, i) => {
        if (codes[i]) changes.push({ target: "variant", productId: pid, variantId: r.variantId, title: `${r.productTitle} – ${r.variantTitle ?? r.sku ?? r.variantId}`, from: null, to: codes[i] });
      });
      if (present.length < rows.length) {
        issues.push({ line: 0, severity: "warning", message: `${rows[0].productTitle}: some variants have no Shopify HS code and stay without HSN.` });
      }
    }
  }
  const short = new Set(changes.map((c) => c.to!).filter((c) => c.length < 8));
  if (short.size) {
    issues.push({ line: 0, severity: "warning",
      message: `${short.size} HS code(s) have fewer than 8 digits (e.g. ${[...short].slice(0, 3).join(", ")}). Rates are matched on the exact code, so configure rates for these codes or correct them to 8-digit HSN.` });
  }
  return { changes, issues };
}

export const PRODUCT_HSN_COLUMNS = [
  "product_id", "variant_id", "sku", "product_title", "variant_title", "vendor",
  "hsn_code", "variant_hsn_override", "shopify_hs_code", "hsn_has_rates",
] as const;

/**
 * Product HSN CSV import.
 *  - hsn_code              → product-level HSN (blank clears it). All rows of a product must agree.
 *  - variant_hsn_override  → per-variant override (blank clears it); only on rows that identify a variant.
 *  - Rows identify a variant by variant_id, else by a unique sku; product_id alone sets product level only.
 *  - A column left out of the file is not touched.
 *  - shopify_hs_code, hsn_has_rates, titles and vendor are for reference and ignored on import.
 */
export function planProductHsnCsv(map: ProductHsn[], text: string): { changes: HsnChange[]; issues: HsnIssue[]; rowCount: number } {
  const issues: HsnIssue[] = [];
  const err = (line: number, message: string) => issues.push({ line, severity: "error", message });
  let records: Record<string, string>[];
  try {
    records = parse(text, { bom: true, columns: (h: string[]) => h.map((x) => x.trim().toLowerCase().replace(/^\uFEFF/, "")), skip_empty_lines: true, trim: true, relax_column_count: true });
  } catch (e) {
    return { changes: [], issues: [{ line: 1, severity: "error", message: `The file could not be read as CSV: ${(e as Error).message}` }], rowCount: 0 };
  }
  const headers = records.length ? Object.keys(records[0]) : [];
  const hasProductCol = headers.includes("hsn_code");
  const hasOverrideCol = headers.includes("variant_hsn_override");
  if (!records.length) err(1, "The file has no data rows.");
  if (records.length && !hasProductCol && !hasOverrideCol) err(1, 'The file needs an "hsn_code" or "variant_hsn_override" column.');
  if (records.length && !headers.some((h) => ["product_id", "variant_id", "sku"].includes(h))) err(1, 'The file needs a "product_id", "variant_id" or "sku" column to identify products.');
  if (issues.length) return { changes: [], issues, rowCount: records.length };

  const byVariant = new Map(map.map((r) => [r.variantId, r]));
  const bySku = new Map<string, ProductHsn[]>();
  for (const r of map) if (r.sku) bySku.set(r.sku.toLowerCase(), [...(bySku.get(r.sku.toLowerCase()) ?? []), r]);
  const productRows = new Map<bigint, ProductHsn[]>();
  for (const r of map) productRows.set(r.productId, [...(productRows.get(r.productId) ?? []), r]);

  const productTarget = new Map<bigint, { value: string | null; line: number }>();
  const variantTarget = new Map<bigint, { value: string | null; row: ProductHsn }>();

  const parseHsn = (raw: string, line: number, col: string): string | null | "bad" => {
    if (raw.trim() === "") return null;
    const v = normaliseHsn(raw);
    if (!v) { err(line, `${col} "${raw}" is not a valid HSN code (4–10 digits).`); return "bad"; }
    return v;
  };

  records.forEach((rec, i) => {
    const line = i + 2;
    const pidRaw = rec.product_id ?? "";
    const vidRaw = rec.variant_id ?? "";
    const skuRaw = rec.sku ?? "";
    let variant: ProductHsn | undefined;
    let productId: bigint | undefined;

    if (vidRaw) {
      if (!/^\d+$/.test(vidRaw)) return err(line, `variant_id "${vidRaw}" must be a number.`);
      variant = byVariant.get(BigInt(vidRaw));
      if (!variant) return err(line, `Variant ${vidRaw} is not in the synced catalogue.`);
    } else if (skuRaw && !pidRaw) {
      const matches = bySku.get(skuRaw.toLowerCase()) ?? [];
      if (matches.length === 0) return err(line, `No variant has SKU "${skuRaw}".`);
      if (matches.length > 1) return err(line, `SKU "${skuRaw}" is used by ${matches.length} variants; add variant_id.`);
      variant = matches[0];
    }
    if (pidRaw) {
      if (!/^\d+$/.test(pidRaw)) return err(line, `product_id "${pidRaw}" must be a number.`);
      productId = BigInt(pidRaw);
      if (!productRows.has(productId)) return err(line, `Product ${pidRaw} is not in the synced catalogue.`);
      if (variant && variant.productId !== productId) return err(line, `Variant ${variant.variantId} does not belong to product ${pidRaw}.`);
    }
    productId = productId ?? variant?.productId;
    if (productId === undefined) return err(line, "Row has no product_id, variant_id or sku.");

    if (hasProductCol) {
      const v = parseHsn(rec.hsn_code ?? "", line, "hsn_code");
      if (v !== "bad") {
        const prev = productTarget.get(productId);
        if (prev && prev.value !== v) err(line, `hsn_code ${v ?? "(blank)"} differs from ${prev.value ?? "(blank)"} on line ${prev.line} for the same product. Use variant_hsn_override for a variant that differs.`);
        else productTarget.set(productId, { value: v, line });
      }
    }
    if (hasOverrideCol && variant) {
      const v = parseHsn(rec.variant_hsn_override ?? "", line, "variant_hsn_override");
      if (v !== "bad") variantTarget.set(variant.variantId, { value: v, row: variant });
    }
  });

  const changes: HsnChange[] = [];
  for (const [pid, t] of productTarget) {
    const current = productRows.get(pid)![0];
    if (current.hsnProductMetafield !== t.value) changes.push({ target: "product", productId: pid, title: current.productTitle, from: current.hsnProductMetafield, to: t.value });
  }
  for (const [vid, t] of variantTarget) {
    if (t.row.hsnVariantMetafield !== t.value) {
      changes.push({ target: "variant", productId: t.row.productId, variantId: vid, title: `${t.row.productTitle} – ${t.row.variantTitle ?? t.row.sku ?? vid}`, from: t.row.hsnVariantMetafield, to: t.value });
    }
  }
  return { changes, issues, rowCount: records.length };
}

/** Warn about HSN codes being assigned that have no rates configured yet. */
export function unconfiguredWarnings(changes: HsnChange[], configured: Set<string>): HsnIssue[] {
  const missing = new Set(changes.map((c) => c.to).filter((c): c is string => !!c && !configured.has(c)));
  return missing.size
    ? [{ line: 0, severity: "warning", message: `${missing.size} HSN code(s) have no duty rates configured yet: ${[...missing].slice(0, 10).join(", ")}${missing.size > 10 ? " …" : ""}. Products with these codes will show "not yet available" on the cart until rates are added.` }]
    : [];
}

export async function exportProductHsnCsv(db: PrismaClient, opts: { shop: string; filter?: ProductFilter }) {
  const configured = await configuredHsnCodes(db, opts.shop);
  const where: Prisma.ProductHsnWhereInput = { shop: opts.shop };
  if (opts.filter === "missing") where.hsnResolved = null;
  if (opts.filter === "unconfigured") where.AND = [{ hsnResolved: { not: null } }, { hsnResolved: { notIn: [...configured] } }];
  const rows = await db.productHsn.findMany({ where, orderBy: [{ productTitle: "asc" }, { productId: "asc" }, { variantId: "asc" }] });
  return "﻿" + stringify(rows.map((r) => ({
    product_id: r.productId.toString(),
    variant_id: r.variantId.toString(),
    sku: r.sku ?? "",
    product_title: r.productTitle,
    variant_title: r.variantTitle ?? "",
    vendor: r.vendor ?? "",
    hsn_code: r.hsnProductMetafield ?? "",
    variant_hsn_override: r.hsnVariantMetafield ?? "",
    shopify_hs_code: r.hsnShopify ?? "",
    hsn_has_rates: r.hsnResolved ? (configured.has(r.hsnResolved) ? "yes" : "no") : "",
  })), { header: true, columns: [...PRODUCT_HSN_COLUMNS] });
}

// ---------------------------------------------------------------------------
// Writing to Shopify + local map
// ---------------------------------------------------------------------------

const SET = `#graphql
  mutation SetuHsnSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { ownerType }
      userErrors { field message code }
    }
  }
`;
const DELETE = `#graphql
  mutation SetuHsnDelete($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      deletedMetafields { key }
      userErrors { field message }
    }
  }
`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function call(graphql: AdminGraphql, query: string, variables: Record<string, unknown>) {
  for (let attempt = 0; ; attempt++) {
    const body = await (await graphql(query, { variables })).json();
    const throttled = body.errors?.some?.((e: { extensions?: { code?: string } }) => e.extensions?.code === "THROTTLED");
    if (throttled && attempt < 5) { await sleep(1000 * 2 ** attempt); continue; }
    if (body.errors) throw new Error(`Shopify GraphQL error: ${JSON.stringify(body.errors)}`);
    return body.data;
  }
}

export interface ApplyResult { applied: number; failed: { title: string; message: string }[] }

/**
 * Write HSN changes to Shopify in batches of 25, then update the local map.
 * Not all-or-nothing across batches (Shopify has no multi-call transaction):
 * failures are reported per product, successful batches are kept.
 */
export async function applyHsnChanges(
  db: PrismaClient, graphql: AdminGraphql, shop: string, changes: HsnChange[], actor?: string,
): Promise<ApplyResult> {
  const settings = await getSettings(db, shop);
  const ns = settings.hsnMetafieldNamespace;
  const key = settings.hsnMetafieldKey;
  const owner = (c: HsnChange) => (c.target === "product" ? productGid(c.productId) : variantGid(c.variantId!));
  const ok: HsnChange[] = [];
  const failed: ApplyResult["failed"] = [];

  const sets = changes.filter((c) => c.to);
  for (let i = 0; i < sets.length; i += 25) {
    const batch = sets.slice(i, i + 25);
    try {
      const data = await call(graphql, SET, {
        metafields: batch.map((c) => ({ ownerId: owner(c), namespace: ns, key, type: "single_line_text_field", value: c.to })),
      });
      const errors = data.metafieldsSet.userErrors as { message: string }[];
      if (errors.length) batch.forEach((c) => failed.push({ title: c.title, message: errors.map((e) => e.message).join("; ") }));
      else ok.push(...batch);
    } catch (e) {
      batch.forEach((c) => failed.push({ title: c.title, message: (e as Error).message }));
    }
  }
  const deletes = changes.filter((c) => !c.to);
  for (let i = 0; i < deletes.length; i += 25) {
    const batch = deletes.slice(i, i + 25);
    try {
      const data = await call(graphql, DELETE, { metafields: batch.map((c) => ({ ownerId: owner(c), namespace: ns, key })) });
      const errors = data.metafieldsDelete.userErrors as { message: string }[];
      if (errors.length) batch.forEach((c) => failed.push({ title: c.title, message: errors.map((e) => e.message).join("; ") }));
      else ok.push(...batch);
    } catch (e) {
      batch.forEach((c) => failed.push({ title: c.title, message: (e as Error).message }));
    }
  }

  await mirrorLocally(db, shop, settings.hsnSourceOrder, ok);
  if (ok.length) {
    await db.auditLog.createMany({
      data: ok.map((c) => ({
        shop, entity: c.target === "product" ? "product_hsn" : "variant_hsn",
        entityId: (c.variantId ?? c.productId).toString(), action: c.to ? "update" : "delete",
        before: { hsn: c.from }, after: { hsn: c.to }, actor: actor ?? "admin",
      })),
    });
  }
  return { applied: ok.length, failed };
}

async function mirrorLocally(db: PrismaClient, shop: string, sourceOrder: string[], changes: HsnChange[]) {
  if (!changes.length) return;
  const productIds = [...new Set(changes.map((c) => c.productId))];
  const rows = await db.productHsn.findMany({ where: { shop, productId: { in: productIds } } });
  const productValue = new Map(changes.filter((c) => c.target === "product").map((c) => [c.productId, c.to]));
  const variantValue = new Map(changes.filter((c) => c.target === "variant").map((c) => [c.variantId!, c.to]));
  await db.$transaction(rows.map((r) => {
    const hsnProductMetafield = productValue.has(r.productId) ? productValue.get(r.productId)! : r.hsnProductMetafield;
    const hsnVariantMetafield = variantValue.has(r.variantId) ? variantValue.get(r.variantId)! : r.hsnVariantMetafield;
    const resolved = resolveHsn(sourceOrder, { variant_metafield: hsnVariantMetafield, product_metafield: hsnProductMetafield, shopify_hs_code: r.hsnShopify });
    return db.productHsn.update({
      where: { shop_variantId: { shop, variantId: r.variantId } },
      data: { hsnProductMetafield, hsnVariantMetafield, ...resolved },
    });
  }));
}
