import type { PrismaClient } from "@prisma/client";
import type { EngineProfile } from "./types";

const dateStr = (v: Date | null) => (v ? v.toISOString().slice(0, 10) : null);

/**
 * Load the configured profiles for a set of HSN codes and one destination,
 * shaped for the engine. Two indexed queries regardless of cart size.
 */
export async function loadProfiles(
  db: PrismaClient,
  opts: { shop: string; hsnCodes: string[]; destination: string; origin?: string },
): Promise<Record<string, EngineProfile>> {
  if (opts.hsnCodes.length === 0) return {};
  const profiles = await db.rateProfile.findMany({
    where: {
      shop: opts.shop,
      originCountry: opts.origin ?? "IN",
      destination: { countryCode: opts.destination, enabled: true },
      hsn: { code: { in: opts.hsnCodes } },
    },
    include: { hsn: true, components: true },
  });
  const out: Record<string, EngineProfile> = {};
  for (const p of profiles) {
    out[p.hsn.code] = {
      hsn: p.hsn.code,
      hsnDescription: p.hsn.description,
      active: p.active,
      components: p.components.map((c) => ({
        id: c.id,
        name: c.name,
        chargeType: c.chargeType,
        rateValue: c.rateValue.toString(),
        currency: c.currency?.trim() ?? null,
        basis: c.basis,
        basisIncludes: c.basisIncludes,
        calcOrder: c.calcOrder,
        scope: c.scope,
        minAmount: c.minAmount?.toString() ?? null,
        maxAmount: c.maxAmount?.toString() ?? null,
        shipmentValueAbove: c.shipmentValueAbove?.toString() ?? null,
        shipmentValueUpTo: c.shipmentValueUpTo?.toString() ?? null,
        effectiveFrom: dateStr(c.effectiveFrom),
        effectiveTo: dateStr(c.effectiveTo),
        active: c.active,
      })),
    };
  }
  return out;
}

/** Today's date (YYYY-MM-DD) in the shop's timezone, for effective dates. */
export function todayIn(timezone: string, now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}
