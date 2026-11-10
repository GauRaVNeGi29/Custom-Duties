import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { calculate } from "../lib/engine/calculate";
import { buildEngineLines, parseCalculateRequest } from "../lib/engine/cart";
import { loadProfiles, todayIn } from "../lib/engine/load.server";
import { getSettings, syncProduct } from "../lib/products/sync.server";

/**
 * POST /apps/setu-duties/calculate   (Shopify app proxy → /proxy/calculate)
 *
 * The cart block sends the cart lines from /cart.js and the chosen
 * destination; the response is the duty breakdown to display. Display only:
 * nothing here touches checkout, and the shop comes from the verified proxy
 * signature, never from the request.
 */

const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.public.appProxy(request);
  return json({ error: "Use POST." }, 405);
};

/** Products synced on demand when a cart holds a variant the map has not seen yet. */
const MAX_LIVE_SYNC = 10;

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.public.appProxy(request);
  if (!session) return json({ error: "unauthorized" }, 401);
  const shop = session.shop;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Body must be JSON." }, 400);
  }
  const parsed = parseCalculateRequest(body);
  if (!parsed.ok) return json({ error: parsed.error }, 400);
  const req = parsed.value;

  const settings = await getSettings(db, shop);
  const destination = req.destination
    ? await db.destination.findFirst({ where: { shop, countryCode: req.destination, enabled: true } })
    : null;
  if (req.destination && !destination) return json({ error: "This destination is not offered." }, 400);

  // variant -> HSN, syncing any product the map has not seen yet
  const variantIds = [...new Set(req.lines.map((l) => BigInt(l.variant_id)))];
  let mapped = await db.productHsn.findMany({ where: { shop, variantId: { in: variantIds } } });
  const known = new Set(mapped.map((m) => m.variantId));
  const unknownProducts = [...new Set(req.lines.filter((l) => !known.has(BigInt(l.variant_id))).map((l) => l.product_id))];
  if (unknownProducts.length && admin) {
    for (const pid of unknownProducts.slice(0, MAX_LIVE_SYNC)) {
      try {
        await syncProduct(db, admin.graphql, shop, `gid://shopify/Product/${pid}`);
      } catch (e) {
        console.error(`[setu] live sync failed for product ${pid}`, e);
      }
    }
    mapped = await db.productHsn.findMany({ where: { shop, variantId: { in: variantIds } } });
  }
  const hsnByVariant = new Map(mapped.map((m) => [Number(m.variantId), m.hsnResolved]));

  const lines = buildEngineLines(req, hsnByVariant, settings.useDiscountedValue);
  const hsnCodes = [...new Set(lines.map((l) => l.hsn).filter((h): h is string => !!h))];
  const profiles = destination
    ? await loadProfiles(db, { shop, hsnCodes, destination: destination.countryCode, origin: settings.defaultOrigin })
    : {};

  const result = calculate({
    lines,
    destination: destination?.countryCode ?? null,
    currency: req.currency,
    destinationCurrency: destination?.currency.trim() ?? null,
    profiles,
    today: todayIn(settings.timezone),
  });

  return json({
    ...result,
    destinationName: destination?.displayName ?? null,
    disclaimer: settings.disclaimer,
    showLandedCost: settings.showLandedCost,
  });
};
