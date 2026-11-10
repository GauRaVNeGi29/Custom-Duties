import "@shopify/shopify-app-react-router/adapters/node";
import {
  ApiVersion,
  AppDistribution,
  shopifyApp,
} from "@shopify/shopify-app-react-router/server";
import { PrismaSessionStorage } from "@shopify/shopify-app-session-storage-prisma";
import prisma from "./db.server";
import { ensureHsnDefinitions, getSettings, startFullSync } from "./lib/products/sync.server";

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || "",
  apiVersion: ApiVersion.October26,
  scopes: process.env.SCOPES?.split(","),
  appUrl: process.env.SHOPIFY_APP_URL || "",
  authPathPrefix: "/auth",
  sessionStorage: new PrismaSessionStorage(prisma),
  // Custom app, installed on Setu Store only.
  distribution: AppDistribution.SingleMerchant,
  hooks: {
    // Runs after every install / re-auth: create the HSN metafield definitions
    // and, on first install, ask Shopify to export the catalogue. The export
    // runs inside Shopify; the home page applies it once it is ready.
    afterAuth: async ({ session, admin }) => {
      const settings = await getSettings(prisma, session.shop);
      await ensureHsnDefinitions(admin.graphql, settings);
      if (!settings.lastFullSyncAt && !settings.syncBulkOpId) {
        await startFullSync(prisma, admin.graphql, session.shop).catch((e) =>
          console.error(`[setu] could not start product export for ${session.shop}`, e),
        );
      }
    },
  },
  future: {
    expiringOfflineAccessTokens: true,
  },
  ...(process.env.SHOP_CUSTOM_DOMAIN
    ? { customShopDomains: [process.env.SHOP_CUSTOM_DOMAIN] }
    : {}),
});

export default shopify;
export const apiVersion = ApiVersion.October26;
export const addDocumentResponseHeaders = shopify.addDocumentResponseHeaders;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
export const login = shopify.login;
export const registerWebhooks = shopify.registerWebhooks;
export const sessionStorage = shopify.sessionStorage;
