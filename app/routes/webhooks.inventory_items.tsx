import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { syncInventoryItem } from "../lib/products/sync.server";

/**
 * inventory_items/update
 * Shopify's HS code field is stored on the inventory item, so an HS code edit
 * arrives here. Resync the item's product so the cart uses the new code.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, admin } = await authenticate.webhook(request);
  if (!admin) return new Response(); // app uninstalled; nothing to sync

  const p = payload as { id: number | string; admin_graphql_api_id?: string };
  const gid = p.admin_graphql_api_id ?? `gid://shopify/InventoryItem/${p.id}`;
  try {
    await syncInventoryItem(db, admin.graphql, shop, gid);
  } catch (e) {
    console.error(`[setu] inventory item sync failed for ${shop} ${gid}`, e);
    return new Response("sync failed", { status: 500 }); // Shopify retries
  }
  return new Response();
};
