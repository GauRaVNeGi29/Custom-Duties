/*
  Warnings:

  - You are about to drop the column `vendorMetafieldKey` on the `ShopSettings` table. All the data in the column will be lost.
  - You are about to drop the column `vendorMetafieldNamespace` on the `ShopSettings` table. All the data in the column will be lost.
  - You are about to drop the column `vendorSource` on the `ShopSettings` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "ShopSettings" DROP COLUMN "vendorMetafieldKey",
DROP COLUMN "vendorMetafieldNamespace",
DROP COLUMN "vendorSource",
ALTER COLUMN "hsnMetafieldNamespace" SET DEFAULT '$app',
ALTER COLUMN "hsnSourceOrder" SET DEFAULT ARRAY['variant_metafield', 'product_metafield']::TEXT[];

-- DropEnum
DROP TYPE "VendorSource";
