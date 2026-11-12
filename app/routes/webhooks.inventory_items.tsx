import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { enqueueSync } from "../lib/products/sync-queue.server";

/**
 * inventory_items/update
 * Shopify's HS code field is stored on the inventory item, so an HS code edit
 * arrives here. Queue the item; the sync queue finds its product(s) and
 * resyncs them one at a time (see sync-queue.server.ts).
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, admin } = await authenticate.webhook(request);
  if (!admin) return new Response(); // app uninstalled; nothing to sync

  const p = payload as { id: number | string; admin_graphql_api_id?: string };
  const gid = p.admin_graphql_api_id ?? `gid://shopify/InventoryItem/${p.id}`;
  enqueueSync(db, admin.graphql, shop, "inventory_item", gid);
  return new Response();
};
