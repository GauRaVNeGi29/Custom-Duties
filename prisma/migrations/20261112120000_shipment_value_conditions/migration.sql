-- Components can apply only above / up to a cart goods value (e.g. US MPF
-- formal entry over US$2,500 vs informal entry at or below it).
ALTER TABLE "TaxComponent" ADD COLUMN "shipmentValueAbove" DECIMAL(14,4);
ALTER TABLE "TaxComponent" ADD COLUMN "shipmentValueUpTo" DECIMAL(14,4);
