import Decimal from "decimal.js";
import type { Prisma, PrismaClient, TaxComponent } from "@prisma/client";
import { countryName, exportCountryName } from "../countries";
import { getSettings } from "../products/sync.server";
import { parseRatesCsv, toCsv, type ExportRow, type RateRow, type RowIssue } from "./csv";

type Db = PrismaClient | Prisma.TransactionClient;

export type ImportModeValue = "merge" | "replace_profiles";

export interface ComponentChange {
  hsn: string;
  destination: string;
  name: string;
  changes?: Record<string, { from: unknown; to: unknown }>;
}

export interface ImportReport {
  jobId: string | null;
  committed: boolean;
  dryRun: boolean;
  mode: ImportModeValue;
  rowCount: number;
  errorCount: number;
  warningCount: number;
  issues: RowIssue[];
  summary: {
    hsnCreated: number;
    hsnUpdated: number;
    destinationsCreated: number;
    profilesCreated: number;
    componentsCreated: number;
    componentsUpdated: number;
    componentsDeleted: number;
    componentsUnchanged: number;
  };
  created: ComponentChange[];
  updated: ComponentChange[];
  deleted: ComponentChange[];
}

const profileKey = (hsn: string, origin: string, dest: string) => `${hsn}|${origin}|${dest}`;
const dateStr = (v: Date | null) => (v ? v.toISOString().slice(0, 10) : null);
const decStr = (v: Prisma.Decimal | Decimal | string | null) => (v == null ? null : new Decimal(v.toString()).toString());

function componentData(r: RateRow) {
  return {
    name: r.componentName,
    chargeType: r.chargeType,
    rateValue: r.rateValue,
    currency: r.currency,
    basis: r.basis,
    basisIncludes: r.basisIncludes,
    calcOrder: r.calcOrder,
    scope: r.scope,
    minAmount: r.minAmount,
    maxAmount: r.maxAmount,
    effectiveFrom: r.effectiveFrom ? new Date(`${r.effectiveFrom}T00:00:00Z`) : null,
    effectiveTo: r.effectiveTo ? new Date(`${r.effectiveTo}T00:00:00Z`) : null,
    active: r.active,
    notes: r.notes,
  };
}

/** Field-by-field comparison; returns only the fields that differ. */
function diffComponent(existing: TaxComponent, r: RateRow) {
  const before: Record<string, unknown> = {
    name: existing.name,
    chargeType: existing.chargeType,
    rateValue: decStr(existing.rateValue),
    currency: existing.currency?.trim() ?? null,
    basis: existing.basis,
    basisIncludes: existing.basisIncludes.join("|"),
    calcOrder: existing.calcOrder,
    scope: existing.scope,
    minAmount: decStr(existing.minAmount),
    maxAmount: decStr(existing.maxAmount),
    effectiveFrom: dateStr(existing.effectiveFrom),
    effectiveTo: dateStr(existing.effectiveTo),
    active: existing.active,
    notes: existing.notes,
  };
  const after: Record<string, unknown> = {
    name: r.componentName,
    chargeType: r.chargeType,
    rateValue: decStr(r.rateValue),
    currency: r.currency,
    basis: r.basis,
    basisIncludes: r.basisIncludes.join("|"),
    calcOrder: r.calcOrder,
    scope: r.scope,
    minAmount: decStr(r.minAmount),
    maxAmount: decStr(r.maxAmount),
    effectiveFrom: r.effectiveFrom,
    effectiveTo: r.effectiveTo,
    active: r.active,
    notes: r.notes,
  };
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of Object.keys(after)) {
    if (before[k] !== after[k]) changes[k] = { from: before[k], to: after[k] };
  }
  return changes;
}

/**
 * Validate a rate CSV and apply it.
 *  - dryRun: true  → nothing is written except the ImportJob preview record.
 *  - dryRun: false → all-or-nothing in one transaction; refused if the file has any error.
 * Rows are matched on HSN + origin + destination + component name (case-insensitive),
 * so re-uploading an edited export updates in place.
 */
export async function runRateImport(
  db: PrismaClient,
  opts: { shop: string; csvText: string; mode?: ImportModeValue; dryRun: boolean; actor?: string; fileName?: string },
): Promise<ImportReport> {
  const mode = opts.mode ?? "merge";
  const settings = await getSettings(db, opts.shop);
  const chargeCurrency = settings.chargeCurrency.trim();
  const parsed = parseRatesCsv(opts.csvText, { chargeCurrency });
  const issues = [...parsed.issues];

  const report: ImportReport = {
    jobId: null,
    committed: false,
    dryRun: opts.dryRun,
    mode,
    rowCount: parsed.rows.length + new Set(parsed.issues.filter((i) => i.severity === "error" && i.line > 1).map((i) => i.line)).size,
    errorCount: 0,
    warningCount: 0,
    issues,
    summary: {
      hsnCreated: 0, hsnUpdated: 0, destinationsCreated: 0, profilesCreated: 0,
      componentsCreated: 0, componentsUpdated: 0, componentsDeleted: 0, componentsUnchanged: 0,
    },
    created: [],
    updated: [],
    deleted: [],
  };

  const execute = async (tx: Db, write: boolean) => {
    const { shop } = opts;
    const rows = parsed.rows;

    // --- destinations ----------------------------------------------------
    const destCodes = [...new Set(rows.map((r) => r.destination))];
    const existingDest = await tx.destination.findMany({ where: { shop, countryCode: { in: destCodes } } });
    const destByCode = new Map(existingDest.map((d) => [d.countryCode, d]));
    const newDest = destCodes.filter((c) => !destByCode.has(c));
    report.summary.destinationsCreated = newDest.length;

    // --- HSN codes -------------------------------------------------------
    const hsnCodes = [...new Set(rows.map((r) => r.hsnCode))];
    const descByHsn = new Map<string, string>();
    rows.forEach((r) => r.hsnDescription && descByHsn.set(r.hsnCode, r.hsnDescription));
    const existingHsn = await tx.hsn.findMany({ where: { shop, code: { in: hsnCodes } } });
    const hsnByCode = new Map(existingHsn.map((h) => [h.code, h]));
    const newHsn = hsnCodes.filter((c) => !hsnByCode.has(c));
    const hsnDescChanges = existingHsn.filter((h) => descByHsn.has(h.code) && descByHsn.get(h.code) !== h.description);
    report.summary.hsnCreated = newHsn.length;
    report.summary.hsnUpdated = hsnDescChanges.length;

    // --- existing profiles + components ----------------------------------
    const existingProfiles = existingHsn.length && existingDest.length
      ? await tx.rateProfile.findMany({
        where: { shop, hsnId: { in: existingHsn.map((h) => h.id) }, destinationId: { in: existingDest.map((d) => d.id) } },
        include: { components: true, hsn: true, destination: true },
      })
      : [];
    const profileByKey = new Map(existingProfiles.map((p) => [profileKey(p.hsn.code, p.originCountry, p.destination.countryCode), p]));

    const rowsByProfile = new Map<string, RateRow[]>();
    for (const r of rows) {
      const k = profileKey(r.hsnCode, r.origin, r.destination);
      rowsByProfile.set(k, [...(rowsByProfile.get(k) ?? []), r]);
    }

    type Pending = { profileKey: string; row: RateRow };
    const toCreate: Pending[] = [];
    const toUpdate: { id: string; row: RateRow; changes: Record<string, { from: unknown; to: unknown }>; before: TaxComponent }[] = [];
    const toDelete: TaxComponent[] = [];
    const newProfileKeys: string[] = [];

    for (const [k, list] of rowsByProfile) {
      const profile = profileByKey.get(k);
      if (!profile) {
        newProfileKeys.push(k);
        list.forEach((row) => toCreate.push({ profileKey: k, row }));
        continue;
      }
      const byName = new Map(profile.components.map((c) => [c.name.toLowerCase(), c]));
      const seen = new Set<string>();
      for (const row of list) {
        const existing = byName.get(row.componentName.toLowerCase());
        if (!existing) { toCreate.push({ profileKey: k, row }); continue; }
        seen.add(existing.id);
        const changes = diffComponent(existing, row);
        if (Object.keys(changes).length) toUpdate.push({ id: existing.id, row, changes, before: existing });
        else report.summary.componentsUnchanged++;
      }
      if (mode === "replace_profiles") {
        profile.components.filter((c) => !seen.has(c.id)).forEach((c) => toDelete.push(c));
      }
    }

    const [hsnOf, destOf] = [(k: string) => k.split("|")[0], (k: string) => k.split("|")[2]];
    report.summary.profilesCreated = newProfileKeys.length;
    report.summary.componentsCreated = toCreate.length;
    report.summary.componentsUpdated = toUpdate.length;
    report.summary.componentsDeleted = toDelete.length;
    report.created = toCreate.map(({ profileKey: k, row }) => ({ hsn: hsnOf(k), destination: destOf(k), name: row.componentName }));
    report.updated = toUpdate.map(({ row, changes }) => ({ hsn: row.hsnCode, destination: row.destination, name: row.componentName, changes }));
    const profileOfComponent = new Map(existingProfiles.flatMap((p) => p.components.map((c) => [c.id, p] as const)));
    report.deleted = toDelete.map((c) => {
      const p = profileOfComponent.get(c.id)!;
      return { hsn: p.hsn.code, destination: p.destination.countryCode, name: c.name };
    });

    if (!write || issues.some((i) => i.severity === "error")) return;

    // --- writes ------------------------------------------------------------
    if (newDest.length) {
      await tx.destination.createMany({
        data: newDest.map((code) => ({ shop, countryCode: code, displayName: countryName(code), currency: chargeCurrency })),
      });
    }
    if (newHsn.length) {
      await tx.hsn.createMany({ data: newHsn.map((code) => ({ shop, code, description: descByHsn.get(code) ?? null })) });
    }
    for (const h of hsnDescChanges) {
      await tx.hsn.update({ where: { id: h.id }, data: { description: descByHsn.get(h.code) } });
    }

    const allHsn = new Map((await tx.hsn.findMany({ where: { shop, code: { in: hsnCodes } } })).map((h) => [h.code, h.id]));
    const allDest = new Map((await tx.destination.findMany({ where: { shop, countryCode: { in: destCodes } } })).map((d) => [d.countryCode, d.id]));

    if (newProfileKeys.length) {
      await tx.rateProfile.createMany({
        data: newProfileKeys.map((k) => {
          const [hsn, origin, dest] = k.split("|");
          return { shop, hsnId: allHsn.get(hsn)!, originCountry: origin, destinationId: allDest.get(dest)! };
        }),
        skipDuplicates: true,
      });
    }
    const profiles = await tx.rateProfile.findMany({
      where: { shop, hsnId: { in: [...allHsn.values()] }, destinationId: { in: [...allDest.values()] } },
      include: { hsn: true, destination: true },
    });
    const profileIdByKey = new Map(profiles.map((p) => [profileKey(p.hsn.code, p.originCountry, p.destination.countryCode), p.id]));

    const CHUNK = 1000;
    for (let i = 0; i < toCreate.length; i += CHUNK) {
      await tx.taxComponent.createMany({
        data: toCreate.slice(i, i + CHUNK).map(({ profileKey: k, row }) => ({ profileId: profileIdByKey.get(k)!, ...componentData(row) })),
      });
    }
    for (const u of toUpdate) {
      await tx.taxComponent.update({ where: { id: u.id }, data: componentData(u.row) });
    }
    if (toDelete.length) {
      await tx.taxComponent.deleteMany({ where: { id: { in: toDelete.map((c) => c.id) } } });
    }

    const actor = opts.actor ?? "csv-import";
    const audit: Prisma.AuditLogCreateManyInput[] = [
      ...report.created.map((c) => ({ shop, entity: "component", action: "create", after: c as unknown as Prisma.InputJsonValue, actor })),
      ...toUpdate.map((u) => ({ shop, entity: "component", entityId: u.id, action: "update", before: Object.fromEntries(Object.entries(u.changes).map(([k, v]) => [k, v.from])) as Prisma.InputJsonValue, after: Object.fromEntries(Object.entries(u.changes).map(([k, v]) => [k, v.to])) as Prisma.InputJsonValue, actor })),
      ...toDelete.map((c) => ({ shop, entity: "component", entityId: c.id, action: "delete", before: { name: c.name, rateValue: decStr(c.rateValue) } as Prisma.InputJsonValue, actor })),
    ];
    for (let i = 0; i < audit.length; i += CHUNK) await tx.auditLog.createMany({ data: audit.slice(i, i + CHUNK) });

    report.committed = true;
  };

  if (parsed.errorCount === 0 && !opts.dryRun) {
    await db.$transaction((tx) => execute(tx, true), { timeout: 300_000, maxWait: 20_000 });
  } else if (parsed.rows.length) {
    await execute(db, false);
  }

  report.errorCount = issues.filter((i) => i.severity === "error").length;
  report.warningCount = issues.filter((i) => i.severity === "warning").length;

  const job = await db.importJob.create({
    data: {
      shop: opts.shop,
      fileName: opts.fileName,
      mode,
      status: report.committed ? "committed" : report.errorCount ? "failed" : "previewed",
      rowCount: report.rowCount,
      summary: report.summary,
      issues: issues as unknown as Prisma.InputJsonValue,
      actor: opts.actor,
      committedAt: report.committed ? new Date() : null,
    },
  });
  report.jobId = job.id;
  return report;
}

/** Export every component (or one destination / HSN) in the import format. */
export async function exportRatesCsv(
  db: PrismaClient,
  opts: { shop: string; destination?: string; hsn?: string },
): Promise<string> {
  const components = await db.taxComponent.findMany({
    where: {
      profile: {
        shop: opts.shop,
        ...(opts.destination ? { destination: { countryCode: opts.destination } } : {}),
        ...(opts.hsn ? { hsn: { code: opts.hsn } } : {}),
      },
    },
    include: { profile: { include: { hsn: true, destination: true } } },
  });
  components.sort((a, b) =>
    a.profile.hsn.code.localeCompare(b.profile.hsn.code) ||
    a.profile.destination.countryCode.localeCompare(b.profile.destination.countryCode) ||
    a.calcOrder - b.calcOrder || a.name.localeCompare(b.name));

  const rows: ExportRow[] = components.map((c) => ({
    origin_country: exportCountryName(c.profile.originCountry),
    destination_country: exportCountryName(c.profile.destination.countryCode),
    hsn_code: c.profile.hsn.code,
    hsn_description: c.profile.hsn.description ?? "",
    component_name: c.name,
    component_type: c.chargeType,
    rate_value: decStr(c.rateValue) ?? "",
    currency: c.currency?.trim() ?? "",
    calculation_basis: c.basis,
    calculation_order: String(c.calcOrder),
    charge_scope: c.scope,
    is_active: c.active ? "True" : "False",
    effective_from: dateStr(c.effectiveFrom) ?? "",
    effective_to: dateStr(c.effectiveTo) ?? "",
    notes: c.notes ?? "",
    basis_components: c.basisIncludes.join("|"),
    min_amount: decStr(c.minAmount) ?? "",
    max_amount: decStr(c.maxAmount) ?? "",
  }));
  return toCsv(rows);
}
