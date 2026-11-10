import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { removeProduct, syncProduct } from "../lib/products/sync.server";

/**
 * products/create, products/update, products/delete
 * Re-reads the product from the Admin API rather than trusting the payload,
 * so HSN metafields, Shopify HS codes and vendor are always current.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload, admin } = await authenticate.webhook(request);
  const id = BigInt((payload as { id: number | string }).id);

  if (topic === "PRODUCTS_DELETE") {
    await removeProduct(db, shop, id);
    return new Response();
  }
  if (!admin) return new Response(); // app uninstalled; nothing to sync

  const gid = (payload as { admin_graphql_api_id?: string }).admin_graphql_api_id ?? `gid://shopify/Product/${id}`;
  try {
    await syncProduct(db, admin.graphql, shop, gid);
  } catch (e) {
    console.error(`[setu] product sync failed for ${shop} ${gid}`, e);
    return new Response("sync failed", { status: 500 }); // Shopify retries
  }
  return new Response();
};
