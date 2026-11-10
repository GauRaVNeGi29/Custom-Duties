-- CreateEnum
CREATE TYPE "ChargeType" AS ENUM ('percentage', 'fixed');

-- CreateEnum
CREATE TYPE "CalculationBasis" AS ENUM ('product_value', 'value_plus_prior', 'value_plus_selected', 'not_applicable');

-- CreateEnum
CREATE TYPE "ChargeScope" AS ENUM ('per_product_value', 'per_unit', 'per_line', 'per_hsn_group', 'per_vendor_shipment', 'per_cart');

-- CreateEnum
CREATE TYPE "VendorSource" AS ENUM ('product_vendor', 'product_metafield');

-- CreateEnum
CREATE TYPE "ImportMode" AS ENUM ('merge', 'replace_profiles');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('previewed', 'committed', 'failed');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopSettings" (
    "shop" TEXT NOT NULL,
    "hsnMetafieldNamespace" TEXT NOT NULL DEFAULT 'setu',
    "hsnMetafieldKey" TEXT NOT NULL DEFAULT 'hsn_code',
    "hsnSourceOrder" TEXT[] DEFAULT ARRAY['variant_metafield', 'product_metafield', 'shopify_hs_code']::TEXT[],
    "vendorSource" "VendorSource" NOT NULL DEFAULT 'product_vendor',
    "vendorMetafieldNamespace" TEXT,
    "vendorMetafieldKey" TEXT,
    "defaultOrigin" CHAR(2) NOT NULL DEFAULT 'IN',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "useDiscountedValue" BOOLEAN NOT NULL DEFAULT true,
    "showLandedCost" BOOLEAN NOT NULL DEFAULT true,
    "prefillFromCustomer" BOOLEAN NOT NULL DEFAULT true,
    "prefillFromMarketCountry" BOOLEAN NOT NULL DEFAULT false,
    "disclaimer" TEXT NOT NULL DEFAULT 'Estimated import duties and taxes based on Setu Store''s configured rates. Not added to your checkout total. Any duties collected at checkout or on delivery are charged separately.',
    "lastFullSyncAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopSettings_pkey" PRIMARY KEY ("shop")
);

-- CreateTable
CREATE TABLE "Hsn" (
    "id" UUID NOT NULL,
    "shop" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Hsn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Destination" (
    "id" UUID NOT NULL,
    "shop" TEXT NOT NULL,
    "countryCode" CHAR(2) NOT NULL,
    "displayName" TEXT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 100,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Destination_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateProfile" (
    "id" UUID NOT NULL,
    "shop" TEXT NOT NULL,
    "hsnId" UUID NOT NULL,
    "originCountry" CHAR(2) NOT NULL DEFAULT 'IN',
    "destinationId" UUID NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxComponent" (
    "id" UUID NOT NULL,
    "profileId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "chargeType" "ChargeType" NOT NULL,
    "rateValue" DECIMAL(14,4) NOT NULL,
    "currency" CHAR(3),
    "basis" "CalculationBasis" NOT NULL,
    "basisIncludes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "calcOrder" INTEGER NOT NULL DEFAULT 100,
    "scope" "ChargeScope" NOT NULL,
    "minAmount" DECIMAL(14,4),
    "maxAmount" DECIMAL(14,4),
    "effectiveFrom" DATE,
    "effectiveTo" DATE,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxComponent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductHsn" (
    "shop" TEXT NOT NULL,
    "variantId" BIGINT NOT NULL,
    "productId" BIGINT NOT NULL,
    "productTitle" TEXT NOT NULL,
    "variantTitle" TEXT,
    "sku" TEXT,
    "vendor" TEXT,
    "hsnVariantMetafield" TEXT,
    "hsnProductMetafield" TEXT,
    "hsnShopify" TEXT,
    "hsnResolved" TEXT,
    "hsnSource" TEXT,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductHsn_pkey" PRIMARY KEY ("shop","variantId")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" BIGSERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "actor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportJob" (
    "id" UUID NOT NULL,
    "shop" TEXT NOT NULL,
    "fileName" TEXT,
    "mode" "ImportMode" NOT NULL,
    "status" "ImportStatus" NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "summary" JSONB NOT NULL,
    "issues" JSONB NOT NULL,
    "actor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committedAt" TIMESTAMP(3),

    CONSTRAINT "ImportJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Hsn_shop_description_idx" ON "Hsn"("shop", "description");

-- CreateIndex
CREATE UNIQUE INDEX "Hsn_shop_code_key" ON "Hsn"("shop", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Destination_shop_countryCode_key" ON "Destination"("shop", "countryCode");

-- CreateIndex
CREATE INDEX "RateProfile_shop_destinationId_originCountry_idx" ON "RateProfile"("shop", "destinationId", "originCountry");

-- CreateIndex
CREATE UNIQUE INDEX "RateProfile_hsnId_originCountry_destinationId_key" ON "RateProfile"("hsnId", "originCountry", "destinationId");

-- CreateIndex
CREATE INDEX "TaxComponent_profileId_calcOrder_idx" ON "TaxComponent"("profileId", "calcOrder");

-- CreateIndex
CREATE UNIQUE INDEX "TaxComponent_profileId_name_key" ON "TaxComponent"("profileId", "name");

-- CreateIndex
CREATE INDEX "ProductHsn_shop_productId_idx" ON "ProductHsn"("shop", "productId");

-- CreateIndex
CREATE INDEX "ProductHsn_shop_hsnResolved_idx" ON "ProductHsn"("shop", "hsnResolved");

-- CreateIndex
CREATE INDEX "AuditLog_shop_entity_createdAt_idx" ON "AuditLog"("shop", "entity", "createdAt");

-- CreateIndex
CREATE INDEX "ImportJob_shop_createdAt_idx" ON "ImportJob"("shop", "createdAt");

-- AddForeignKey
ALTER TABLE "RateProfile" ADD CONSTRAINT "RateProfile_hsnId_fkey" FOREIGN KEY ("hsnId") REFERENCES "Hsn"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RateProfile" ADD CONSTRAINT "RateProfile_destinationId_fkey" FOREIGN KEY ("destinationId") REFERENCES "Destination"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxComponent" ADD CONSTRAINT "TaxComponent_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "RateProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;
