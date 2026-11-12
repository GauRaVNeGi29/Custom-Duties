import type { PrismaClient, ShopSettings } from "@prisma/client";

/**
 * Keeps ProductHsn (variant -> HSN, titles, vendor) in step with Shopify.
 *
 * The HSN code lives in an app-owned metafield, $app:hsn_code, on the product
 * (and optionally on a variant as an override). Only this app and Setu Store
 * staff in Shopify admin can change it; seller apps such as Webkul cannot.
 *
 * HSN sources, tried in ShopSettings.hsnSourceOrder (default):
 *   1. variant metafield  $app:hsn_code   (optional override for one variant)
 *   2. product metafield  $app:hsn_code   (optional override for a product)
 *   3. Shopify's own "HS code" field on each variant (inventoryItem.harmonizedSystemCode)
 * Most products need nothing in the app: the HS code entered in Shopify is used.
 */

/** Minimal shape of the Admin GraphQL client from authenticate.admin / authenticate.webhook. */
export type AdminGraphql = (
  query: string,
  options?: { variables?: Record<string, unknown> },
// eslint-disable-next-line @typescript-eslint/no-explicit-any
) => Promise<{ json: () => Promise<any> }>;

const VARIANT_FIELDS = `#graphql
  fragment SetuVariant on ProductVariant {
    id
    title
    sku
    hsn: metafield(namespace: $ns, key: $key) { value }
    inventoryItem { harmonizedSystemCode }
  }
`;

const PRODUCT_FIELDS = `#graphql
  fragment SetuProduct on Product {
    id
    title
    vendor
    hsn: metafield(namespace: $ns, key: $key) { value }
  }
`;

const PRODUCT_ONE = `#graphql
  query SetuProduct($id: ID!, $ns: String!, $key: String!) {
    product(id: $id) {
      ...SetuProduct
      variants(first: 100) {
        pageInfo { hasNextPage endCursor }
        nodes { ...SetuVariant }
      }
    }
  }
  ${PRODUCT_FIELDS}
  ${VARIANT_FIELDS}
`;

const MORE_VARIANTS = `#graphql
  query SetuMoreVariants($id: ID!, $after: String!, $ns: String!, $key: String!) {
    product(id: $id) {
      variants(first: 250, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { ...SetuVariant }
      }
    }
  }
  ${VARIANT_FIELDS}
`;

const DEFINITION_CREATE = `#graphql
  mutation SetuHsnDefinition($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition { id }
      userErrors { field message code }
    }
  }
`;

export const gidToNumber = (gid: string) => BigInt(gid.split("/").pop()!);

/** "7117.90.90" -> "71179090"; anything that is not 4–10 digits -> null. */
export function normaliseHsn(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const s = raw.replace(/[\s.-]/g, "");
  return /^\d{4,10}$/.test(s) ? s : null;
}

export async function getSettings(db: PrismaClient, shop: string): Promise<ShopSettings> {
  try {
    return await db.shopSettings.upsert({ where: { shop }, update: {}, create: { shop } });
  } catch (e) {
    // Two first-time requests can both try to create the row; the loser reads it.
    if ((e as { code?: string }).code !== "P2002") throw e;
    return db.shopSettings.findUniqueOrThrow({ where: { shop } });
  }
}

async function gql(graphql: AdminGraphql, query: string, variables: Record<string, unknown>) {
  const res = await graphql(query, { variables });
  const body = await res.json();
  if (body.errors) throw new Error(`Shopify GraphQL error: ${JSON.stringify(body.errors)}`);
  return body.data;
}

function vars(s: ShopSettings) {
  return { ns: s.hsnMetafieldNamespace, key: s.hsnMetafieldKey };
}

/**
 * Create the HSN definitions on products and variants. Safe to call repeatedly.
 * App-owned ($app) with admin access MERCHANT_READ_WRITE: staff can edit the
 * field on the product page in Shopify admin; other apps cannot write it.
 */
export async function ensureHsnDefinitions(graphql: AdminGraphql, s: ShopSettings) {
  for (const ownerType of ["PRODUCT", "PRODUCTVARIANT"]) {
    const data = await gql(graphql, DEFINITION_CREATE, {
      definition: {
        name: ownerType === "PRODUCT" ? "HSN code" : "HSN code (variant override)",
        namespace: s.hsnMetafieldNamespace,
        key: s.hsnMetafieldKey,
        description: "Indian HSN code used by Setu Import Duties to look up configured duty rates. 4–10 digits. Managed by the Setu Store team.",
        type: "single_line_text_field",
        ownerType,
        pin: ownerType === "PRODUCT",
        validations: [{ name: "regex", value: "^[0-9]{4,10}$" }],
        access: { admin: "MERCHANT_READ_WRITE" },
      },
    });
    const errors = data.metafieldDefinitionCreate.userErrors as { code: string; message: string }[];
    const real = errors.filter((e) => e.code !== "TAKEN");
    if (real.length) throw new Error(`HSN metafield definition (${ownerType}): ${real.map((e) => e.message).join("; ")}`);
  }
}

type ProductNode = {
  id: string; title: string; vendor: string | null;
  hsn: { value: string } | null;
  variants: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: VariantNode[] };
};
type VariantNode = {
  id: string; title: string; sku: string | null;
  hsn: { value: string } | null; inventoryItem: { harmonizedSystemCode: string | null } | null;
};

function resolveRows(shop: string, s: ShopSettings, p: ProductNode, variants: VariantNode[]) {
  const vendor = p.vendor || null;
  const productHsn = p.hsn?.value ?? null;
  return variants.map((v) => {
    const candidates: Record<string, string | null> = {
      variant_metafield: v.hsn?.value ?? null,
      product_metafield: productHsn,
      shopify_hs_code: v.inventoryItem?.harmonizedSystemCode ?? null,
    };
    const { hsnResolved, hsnSource } = resolveHsn(s.hsnSourceOrder, {
      variant_metafield: candidates.variant_metafield,
      product_metafield: candidates.product_metafield,
      shopify_hs_code: candidates.shopify_hs_code,
    });
    return {
      shop,
      variantId: gidToNumber(v.id),
      productId: gidToNumber(p.id),
      productTitle: p.title,
      variantTitle: v.title === "Default Title" ? null : v.title,
      sku: v.sku || null,
      vendor,
      hsnVariantMetafield: candidates.variant_metafield,
      hsnProductMetafield: candidates.product_metafield,
      hsnShopify: candidates.shopify_hs_code,
      hsnResolved,
      hsnSource,
      syncedAt: new Date(),
    };
  });
}

async function allVariants(graphql: AdminGraphql, s: ShopSettings, p: ProductNode) {
  const list = [...p.variants.nodes];
  let page = p.variants.pageInfo;
  while (page.hasNextPage && page.endCursor) {
    const data = await gql(graphql, MORE_VARIANTS, { id: p.id, after: page.endCursor, ns: s.hsnMetafieldNamespace, key: s.hsnMetafieldKey });
    list.push(...data.product.variants.nodes);
    page = data.product.variants.pageInfo;
  }
  return list;
}

async function writeProduct(db: PrismaClient, shop: string, productId: bigint, rows: ReturnType<typeof resolveRows>) {
  const variantIds = rows.map((r) => r.variantId);
  await db.$transaction([
    // Also clear these variants if they were stored under another product.
    db.productHsn.deleteMany({ where: { shop, OR: [{ productId }, { variantId: { in: variantIds } }] } }),
    // skipDuplicates: if two syncs of the same product overlap, the second
    // leaves the first one's (equally fresh) rows instead of failing.
    db.productHsn.createMany({ data: rows, skipDuplicates: true }),
  ]);
}

/** Re-read one product from Shopify and replace its variants in the map. */
export async function syncProduct(db: PrismaClient, graphql: AdminGraphql, shop: string, productGid: string) {
  const s = await getSettings(db, shop);
  const data = await gql(graphql, PRODUCT_ONE, { id: productGid, ...vars(s) });
  const p: ProductNode | null = data.product;
  if (!p) {
    await removeProduct(db, shop, gidToNumber(productGid));
    return 0;
  }
  const rows = resolveRows(shop, s, p, await allVariants(graphql, s, p));
  await writeProduct(db, shop, gidToNumber(p.id), rows);
  return rows.length;
}

/** Products an inventory item belongs to (one item can be shared by several variants). */
export async function productsForInventoryItem(graphql: AdminGraphql, inventoryItemGid: string): Promise<string[]> {
  const data = await gql(graphql, INVENTORY_ITEM_PRODUCT, { id: inventoryItemGid });
  const nodes = (data.inventoryItem?.variants?.nodes ?? []) as { product: { id: string } | null }[];
  return [...new Set(nodes.map((n) => n.product?.id).filter((id): id is string => !!id))];
}

const INVENTORY_ITEM_PRODUCT = `#graphql
  query SetuInventoryItemProduct($id: ID!) {
    inventoryItem(id: $id) { variants(first: 50) { nodes { product { id } } } }
  }
`;

/**
 * Shopify's HS code lives on the inventory item, so editing it fires
 * inventory_items/update. One item can be shared by several variants, so
 * resync every product it belongs to. Returns the variants written (0 if none).
 */
export async function syncInventoryItem(db: PrismaClient, graphql: AdminGraphql, shop: string, inventoryItemGid: string) {
  const productGids = await productsForInventoryItem(graphql, inventoryItemGid);
  let written = 0;
  for (const gid of productGids) written += await syncProduct(db, graphql, shop, gid);
  return written;
}

export async function removeProduct(db: PrismaClient, shop: string, productId: bigint) {
  await db.productHsn.deleteMany({ where: { shop, productId } });
}

/** Recompute hsnResolved for given rows using the shop's source order. */
export function resolveHsn(
  sourceOrder: string[],
  candidates: { variant_metafield: string | null; product_metafield: string | null; shopify_hs_code: string | null },
): { hsnResolved: string | null; hsnSource: string | null } {
  for (const src of sourceOrder) {
    const n = normaliseHsn(candidates[src as keyof typeof candidates]);
    if (n) return { hsnResolved: n, hsnSource: src };
  }
  return { hsnResolved: null, hsnSource: null };
}

// ---------------------------------------------------------------------------
// Full catalogue sync via a Shopify bulk export
//
// A normal paged query is capped at 1,000 cost points per request, and a
// 10,000-variant catalogue would take many minutes. A bulk export runs inside
// Shopify and returns one JSONL file, so it works for any catalogue size and
// within Cloud Run's request-based (free tier) CPU: start it, then poll.
// ---------------------------------------------------------------------------

const BULK_START = `#graphql
  mutation SetuBulkSync($query: String!) {
    bulkOperationRunQuery(query: $query, groupObjects: false) {
      bulkOperation { id status }
      userErrors { field message }
    }
  }
`;

const BULK_STATUS = `#graphql
  query SetuBulkStatus($id: ID!) {
    bulkOperation(id: $id) { id status errorCode objectCount url partialDataUrl completedAt }
  }
`;

/** One JSONL line per variant, with its product inline (no nested connections). */
export function bulkSyncQuery(s: Pick<ShopSettings, "hsnMetafieldNamespace" | "hsnMetafieldKey">) {
  const mf = `metafield(namespace: ${JSON.stringify(s.hsnMetafieldNamespace)}, key: ${JSON.stringify(s.hsnMetafieldKey)}) { value }`;
  return `{
  productVariants {
    edges {
      node {
        id
        title
        sku
        hsn: ${mf}
        inventoryItem { harmonizedSystemCode }
        product { id title vendor hsn: ${mf} }
      }
    }
  }
}`;
}

export type SyncStatus =
  | { state: "idle"; lastFullSyncAt: Date | null }
  | { state: "running"; objectCount: number }
  | { state: "done"; variants: number; products: number }
  | { state: "failed"; error: string };

/** Ask Shopify to export every variant. Returns quickly; call pollFullSync until done. */
export async function startFullSync(db: PrismaClient, graphql: AdminGraphql, shop: string): Promise<SyncStatus> {
  const s = await getSettings(db, shop);
  if (s.syncBulkOpId) return pollFullSync(db, graphql, shop);
  const data = await gql(graphql, BULK_START, { query: bulkSyncQuery(s) });
  const errors = data.bulkOperationRunQuery.userErrors as { message: string }[];
  if (errors.length) return { state: "failed", error: errors.map((e) => e.message).join("; ") };
  await db.shopSettings.update({ where: { shop }, data: { syncBulkOpId: data.bulkOperationRunQuery.bulkOperation.id } });
  return { state: "running", objectCount: 0 };
}

/**
 * Check the export; when Shopify has finished, download and apply it.
 * fetchFile is injectable for tests.
 */
export async function pollFullSync(
  db: PrismaClient, graphql: AdminGraphql, shop: string,
  fetchFile: (url: string) => Promise<string> = async (url) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download of product export failed (${res.status})`);
    return res.text();
  },
): Promise<SyncStatus> {
  const s = await getSettings(db, shop);
  if (!s.syncBulkOpId) return { state: "idle", lastFullSyncAt: s.lastFullSyncAt };
  const data = await gql(graphql, BULK_STATUS, { id: s.syncBulkOpId });
  const op = data.bulkOperation as { status: string; errorCode: string | null; objectCount: string; url: string | null } | null;
  if (!op) {
    await db.shopSettings.update({ where: { shop }, data: { syncBulkOpId: null } });
    return { state: "failed", error: "The product export could not be found. Start the sync again." };
  }
  if (op.status === "CREATED" || op.status === "RUNNING" || op.status === "CANCELING") {
    return { state: "running", objectCount: Number(op.objectCount) };
  }
  if (op.status !== "COMPLETED") {
    await db.shopSettings.update({ where: { shop }, data: { syncBulkOpId: null } });
    return { state: "failed", error: `Shopify product export ${op.status.toLowerCase()}${op.errorCode ? ` (${op.errorCode})` : ""}. Start the sync again.` };
  }
  // url is null when the store has no variants at all
  const text = op.url ? await fetchFile(op.url) : "";
  const result = await applyBulkExport(db, shop, s, text);
  await db.shopSettings.update({ where: { shop }, data: { syncBulkOpId: null, lastFullSyncAt: new Date() } });
  return { state: "done", ...result };
}

type BulkLine = VariantNode & { product: Omit<ProductNode, "variants"> | null };

/** Replace the whole variant map for a shop with the export's contents. */
export async function applyBulkExport(db: PrismaClient, shop: string, s: ShopSettings, jsonl: string) {
  const rows: ReturnType<typeof resolveRows> = [];
  const products = new Set<string>();
  for (const raw of jsonl.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const v = JSON.parse(line) as BulkLine;
    if (!v.product) continue;
    products.add(v.product.id);
    rows.push(...resolveRows(shop, s, { ...v.product, variants: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } }, [v]));
  }
  const CHUNK = 1000;
  await db.$transaction(async (tx) => {
    await tx.productHsn.deleteMany({ where: { shop } });
    for (let i = 0; i < rows.length; i += CHUNK) {
      await tx.productHsn.createMany({ data: rows.slice(i, i + CHUNK), skipDuplicates: true });
    }
  }, { timeout: 300_000, maxWait: 30_000 }); // generous: free hosting plans have little CPU
  return { variants: rows.length, products: products.size };
}

/** Counts for the admin home page and the Coverage screen. */
export async function hsnCoverage(db: PrismaClient, shop: string) {
  const [variants, missing, bySource] = await Promise.all([
    db.productHsn.count({ where: { shop } }),
    db.productHsn.count({ where: { shop, hsnResolved: null } }),
    db.productHsn.groupBy({ by: ["hsnSource"], where: { shop }, _count: true }),
  ]);
  return { variants, missingHsn: missing, bySource: bySource.map((b) => ({ source: b.hsnSource, count: b._count })) };
}
