import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getSettings } from "../lib/products/sync.server";

/**
 * GET /apps/setu-duties/destinations  (via the Shopify app proxy)
 * Countries offered in the cart destination selector, plus the display
 * settings the cart block needs. The shop comes from the verified proxy
 * signature, never from the request.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session) return Response.json({ error: "unauthorized" }, { status: 401 });

  const [destinations, settings] = await Promise.all([
    db.destination.findMany({
      where: { shop: session.shop, enabled: true },
      orderBy: [{ sortOrder: "asc" }, { displayName: "asc" }],
      select: { countryCode: true, displayName: true },
    }),
    getSettings(db, session.shop),
  ]);
  return Response.json(
    {
      destinations: destinations.map((d) => ({ code: d.countryCode, name: d.displayName })),
      settings: {
        prefillFromCustomer: settings.prefillFromCustomer,
        prefillFromMarketCountry: settings.prefillFromMarketCountry,
        showLandedCost: settings.showLandedCost,
        disclaimer: settings.disclaimer,
      },
    },
    { headers: { "Cache-Control": "public, max-age=60" } },
  );
};
