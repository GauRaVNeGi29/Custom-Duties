import Decimal from "decimal.js";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { SUPPORTED_ORIGINS, toCountryCode } from "../countries";
import type { CalculationBasis, ChargeScope, ChargeType } from "../engine/types";

/**
 * Setu Store rate CSV – one row per tax component.
 *
 * Columns (from setustore_import_duty_rates_example.csv):
 *   origin_country, destination_country, hsn_code, hsn_description,
 *   component_name, component_type, rate_value, currency,
 *   calculation_basis, calculation_order, charge_scope, is_active,
 *   effective_from, effective_to, notes
 * Optional extra columns:
 *   basis_components  – for value_plus_selected, earlier component names separated by "|"
 *   min_amount, max_amount – optional floor / cap per component
 *   shipment_value_above, shipment_value_up_to – apply the component only
 *     when the whole cart's goods value is above / at most this amount
 *     (charge currency), e.g. US MPF: formal entry over US$2,500.
 * A percentage with charge_scope per_cart is a percentage of the whole cart's
 * goods value, applied once (min_amount / max_amount apply to that total).
 */

export const CSV_COLUMNS = [
  "origin_country", "destination_country", "hsn_code", "hsn_description",
  "component_name", "component_type", "rate_value", "currency",
  "calculation_basis", "calculation_order", "charge_scope", "is_active",
  "effective_from", "effective_to", "notes",
  "basis_components", "min_amount", "max_amount",
  "shipment_value_above", "shipment_value_up_to",
] as const;

const REQUIRED = [
  "origin_country", "destination_country", "hsn_code",
  "component_name", "component_type", "rate_value",
] as const;

export interface RateRow {
  line: number; // line number in the file (header = 1)
  origin: string;
  destination: string;
  hsnCode: string;
  hsnDescription: string | null;
  componentName: string;
  chargeType: ChargeType;
  rateValue: string;
  currency: string | null;
  basis: CalculationBasis;
  basisIncludes: string[];
  calcOrder: number;
  scope: ChargeScope;
  active: boolean;
  effectiveFrom: string | null; // YYYY-MM-DD
  effectiveTo: string | null;
  notes: string | null;
  minAmount: string | null;
  maxAmount: string | null;
  shipmentValueAbove: string | null;
  shipmentValueUpTo: string | null;
}

export interface RowIssue {
  line: number;
  column?: string;
  severity: "error" | "warning";
  message: string;
}

export interface ParseResult {
  rows: RateRow[];
  issues: RowIssue[];
  errorCount: number;
  warningCount: number;
}

const TYPE_ALIASES: Record<string, ChargeType> = {
  percentage: "percentage", percent: "percentage", "%": "percentage", pct: "percentage",
  fixed: "fixed", flat: "fixed", amount: "fixed",
};

const BASIS_VALUES: CalculationBasis[] = [
  "product_value", "value_plus_prior", "value_plus_selected", "not_applicable",
];
const BASIS_ALIASES: Record<string, CalculationBasis> = {
  na: "not_applicable", "n/a": "not_applicable", none: "not_applicable",
  value: "product_value", product: "product_value",
};

const SCOPE_VALUES: ChargeScope[] = [
  "per_product_value", "per_unit", "per_line", "per_hsn_group", "per_vendor_shipment", "per_cart",
];
const SCOPE_ALIASES: Record<string, ChargeScope> = {
  per_product: "per_unit", per_item: "per_unit", per_quantity: "per_unit",
  per_cart_line: "per_line", per_line_item: "per_line",
  per_hsn: "per_hsn_group",
  per_vendor: "per_vendor_shipment", per_seller: "per_vendor_shipment", per_seller_shipment: "per_vendor_shipment",
  per_shipment: "per_cart", per_order: "per_cart",
};
// per_vendor_shipment stays in the vocabulary only to give a clear error: whether
// vendors ship separately is decided at checkout, so it is never charged on the cart.
const FIXED_SCOPES = new Set<ChargeScope>(["per_unit", "per_line", "per_hsn_group", "per_cart"]);
const CURRENCIES = new Set(Intl.supportedValuesOf("currency"));

const key = (s: string) => s.trim().toLowerCase().replace(/[\s-]+/g, "_");

/** Accepts YYYY-MM-DD, or DD-MM-YYYY / DD/MM/YYYY (Indian day-first convention). */
export function parseDate(raw: string): string | null | "invalid" {
  const s = raw.trim();
  if (!s) return null;
  let y: number, m: number, day: number;
  let match = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) [y, m, day] = [+match[1], +match[2], +match[3]];
  else if ((match = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/))) [day, m, y] = [+match[1], +match[2], +match[3]];
  else return "invalid";
  const dt = new Date(Date.UTC(y, m - 1, day));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== day) return "invalid";
  return dt.toISOString().slice(0, 10);
}

function parseBool(raw: string): boolean | "invalid" {
  const s = raw.trim().toLowerCase();
  if (s === "") return true;
  if (["true", "yes", "y", "1", "active", "enabled"].includes(s)) return true;
  if (["false", "no", "n", "0", "inactive", "disabled"].includes(s)) return false;
  return "invalid";
}

function parseDecimal(raw: string): Decimal | null | "invalid" {
  const s = raw.trim().replace(/%$/, "").replace(/,/g, "");
  if (!s) return null;
  try {
    const v = new Decimal(s);
    return v.isFinite() ? v : "invalid";
  } catch {
    return "invalid";
  }
}

export interface ParseOptions {
  /**
   * Currency Shopify carts are charged in (INR for Setu Store). Fixed charges
   * must be in this currency; a blank currency on a fixed charge means this one.
   */
  chargeCurrency?: string;
}

export function parseRatesCsv(text: string, opts: ParseOptions = {}): ParseResult {
  const chargeCurrency = opts.chargeCurrency?.toUpperCase();
  const issues: RowIssue[] = [];
  const err = (line: number, column: string | undefined, message: string) =>
    issues.push({ line, column, severity: "error", message });
  const warn = (line: number, column: string | undefined, message: string) =>
    issues.push({ line, column, severity: "warning", message });

  let records: Record<string, string>[];
  try {
    records = parse(text, {
      bom: true,
      columns: (header: string[]) => header.map((h) => key(h.replace(/^\uFEFF/, ""))),
      skip_empty_lines: true,
      trim: true,
      relax_column_count: true,
    });
  } catch (e) {
    err(1, undefined, `The file could not be read as CSV: ${(e as Error).message}`);
    return { rows: [], issues, errorCount: 1, warningCount: 0 };
  }

  const headers = records.length ? Object.keys(records[0]) : [];
  if (records.length === 0) {
    err(1, undefined, "The file has no data rows.");
  }
  for (const col of REQUIRED) {
    if (records.length && !headers.includes(col)) err(1, col, `Missing required column "${col}".`);
  }
  for (const h of headers) {
    if (!(CSV_COLUMNS as readonly string[]).includes(h)) warn(1, h, `Column "${h}" is not recognised and will be ignored.`);
  }
  if (issues.some((i) => i.severity === "error")) {
    return summarise([], issues);
  }

  const rows: RateRow[] = [];
  const orderCounter = new Map<string, number>();

  records.forEach((rec, idx) => {
    const line = idx + 2;
    const get = (c: string) => (rec[c] ?? "").trim();
    let ok = true;
    const fail = (column: string, message: string) => { ok = false; err(line, column, message); };

    // countries
    const origin = toCountryCode(get("origin_country"));
    if (!origin) fail("origin_country", `Unknown origin country "${get("origin_country")}".`);
    else if (!SUPPORTED_ORIGINS.includes(origin)) fail("origin_country", `Origin ${origin} is not supported yet; only India (IN) is enabled.`);
    const destination = toCountryCode(get("destination_country"));
    if (!destination) fail("destination_country", `Unknown destination country "${get("destination_country")}". Use a country name or ISO code, e.g. USA, UK, Germany, AU.`);

    // HSN
    const hsnRaw = get("hsn_code");
    const hsnCode = hsnRaw.replace(/[\s.]/g, "");
    if (!/^\d{4,10}$/.test(hsnCode)) fail("hsn_code", `HSN code "${hsnRaw}" must be 4 to 10 digits.`);
    else if (hsnCode.length % 2 === 1) warn(line, "hsn_code", `HSN code ${hsnCode} has an odd number of digits; check that a leading zero was not dropped by Excel.`);

    // component
    const componentName = get("component_name").replace(/\s+/g, " ");
    if (!componentName) fail("component_name", "Component name is empty.");
    if (componentName.length > 120) fail("component_name", "Component name is longer than 120 characters.");

    const chargeType = TYPE_ALIASES[key(get("component_type"))];
    if (!chargeType) fail("component_type", `component_type must be "percentage" or "fixed", got "${get("component_type")}".`);

    const rate = parseDecimal(get("rate_value"));
    if (rate === null) fail("rate_value", "rate_value is empty.");
    else if (rate === "invalid") fail("rate_value", `rate_value "${get("rate_value")}" is not a number.`);
    else if (rate.isNegative()) fail("rate_value", "rate_value cannot be negative.");
    else if (chargeType === "percentage" && rate.gt(1000)) fail("rate_value", "A percentage above 1000% is almost certainly a typo.");

    // currency
    const currencyRaw = get("currency").toUpperCase();
    let currency = currencyRaw || null;
    if (chargeType === "fixed" && !currency && chargeCurrency) {
      currency = chargeCurrency;
      warn(line, "currency", `No currency given; read as ${chargeCurrency}.`);
    }
    if (currency && !CURRENCIES.has(currency)) fail("currency", `Currency "${currencyRaw}" is not a recognised ISO 4217 code such as USD, EUR, GBP, AUD, CAD.`);
    if (chargeType === "fixed" && !currency) fail("currency", "A fixed charge needs a currency.");
    if (chargeType === "fixed" && currency && chargeCurrency && currency !== chargeCurrency && CURRENCIES.has(currency)) {
      fail("currency", `Fixed charges must be entered in ${chargeCurrency}, the currency carts are charged in (Bucks converts it for customers). Enter the ${chargeCurrency} amount, e.g. MPF ₹255 instead of $3.`);
    }

    // basis
    const basisRaw = key(get("calculation_basis"));
    let basis: CalculationBasis | undefined =
      basisRaw === "" ? (chargeType === "fixed" ? "not_applicable" : "product_value")
        : (BASIS_VALUES as string[]).includes(basisRaw) ? (basisRaw as CalculationBasis)
          : BASIS_ALIASES[basisRaw];
    if (!basis) fail("calculation_basis", `Unknown calculation_basis "${get("calculation_basis")}". Use ${BASIS_VALUES.join(", ")}.`);
    if (chargeType === "fixed" && basis && basis !== "not_applicable") {
      warn(line, "calculation_basis", "Fixed charges ignore calculation_basis; set to not_applicable.");
      basis = "not_applicable";
    }
    if (chargeType === "percentage" && basis === "not_applicable") fail("calculation_basis", "A percentage component needs a calculation basis such as product_value.");
    const basisIncludes = get("basis_components").split("|").map((s) => s.trim()).filter(Boolean);
    if (basis === "value_plus_selected" && basisIncludes.length === 0) fail("basis_components", "value_plus_selected needs basis_components listing the earlier components to include (separated by |).");

    // scope
    const scopeRaw = key(get("charge_scope"));
    const scope: ChargeScope | undefined =
      scopeRaw === "" ? (chargeType === "percentage" ? "per_product_value" : undefined)
        : (SCOPE_VALUES as string[]).includes(scopeRaw) ? (scopeRaw as ChargeScope)
          : SCOPE_ALIASES[scopeRaw];
    if (!scope) {
      fail("charge_scope", scopeRaw === ""
        ? "A fixed charge needs charge_scope: per_unit, per_line, per_hsn_group or per_cart."
        : `Unknown charge_scope "${get("charge_scope")}".`);
    } else if (chargeType === "percentage" && scope !== "per_product_value" && scope !== "per_cart") {
      fail("charge_scope", "Percentage components use per_product_value, or per_cart for a percentage of the whole cart (e.g. US MPF).");
    } else if (chargeType === "percentage" && scope === "per_cart" && basis && basis !== "product_value") {
      fail("calculation_basis", "A per_cart percentage is taken on the cart's goods value; use calculation_basis product_value.");
    } else if (scope === "per_vendor_shipment") {
      fail("charge_scope", "Per-vendor charges are not used: whether items ship separately is only known at checkout. Use per_cart for a once-per-shipment charge such as MPF.");
    } else if (chargeType === "fixed" && !FIXED_SCOPES.has(scope)) {
      fail("charge_scope", "Fixed charges need per_unit, per_line, per_hsn_group or per_cart.");
    }
    if (scope && scope !== "per_vendor_shipment" && SCOPE_ALIASES[scopeRaw] && scopeRaw !== scope) {
      warn(line, "charge_scope", `"${scopeRaw}" was read as ${scope}.`);
    }

    // order, flags, dates
    const orderRaw = get("calculation_order");
    let calcOrder = 0;
    const profileKey = `${origin}|${destination}|${hsnCode}`;
    if (orderRaw === "") {
      calcOrder = (orderCounter.get(profileKey) ?? 0) + 10;
    } else if (/^-?\d+$/.test(orderRaw)) {
      calcOrder = parseInt(orderRaw, 10);
    } else fail("calculation_order", `calculation_order "${orderRaw}" must be a whole number.`);
    orderCounter.set(profileKey, Math.max(orderCounter.get(profileKey) ?? 0, calcOrder));

    const active = parseBool(get("is_active"));
    if (active === "invalid") fail("is_active", `is_active "${get("is_active")}" must be True or False.`);

    const from = parseDate(get("effective_from"));
    const to = parseDate(get("effective_to"));
    if (from === "invalid") fail("effective_from", `effective_from "${get("effective_from")}" must be YYYY-MM-DD or DD-MM-YYYY.`);
    if (to === "invalid") fail("effective_to", `effective_to "${get("effective_to")}" must be YYYY-MM-DD or DD-MM-YYYY.`);
    if (from && to && from !== "invalid" && to !== "invalid" && from > to) fail("effective_to", "effective_to is before effective_from.");

    const min = parseDecimal(get("min_amount"));
    const max = parseDecimal(get("max_amount"));
    if (min === "invalid") fail("min_amount", "min_amount is not a number.");
    if (max === "invalid") fail("max_amount", "max_amount is not a number.");
    if (min instanceof Decimal && max instanceof Decimal && min.gt(max)) fail("max_amount", "max_amount is below min_amount.");
    const above = parseDecimal(get("shipment_value_above"));
    const upTo = parseDecimal(get("shipment_value_up_to"));
    if (above === "invalid") fail("shipment_value_above", "shipment_value_above is not a number.");
    if (upTo === "invalid") fail("shipment_value_up_to", "shipment_value_up_to is not a number.");
    if (above instanceof Decimal && upTo instanceof Decimal && !above.lt(upTo)) fail("shipment_value_up_to", "shipment_value_up_to must be more than shipment_value_above.");

    if (!ok) return;
    rows.push({
      line,
      origin: origin!,
      destination: destination!,
      hsnCode,
      hsnDescription: get("hsn_description") || null,
      componentName,
      chargeType: chargeType!,
      rateValue: (rate as Decimal).toString(),
      currency,
      basis: basis!,
      basisIncludes,
      calcOrder,
      scope: scope!,
      active: active as boolean,
      effectiveFrom: from as string | null,
      effectiveTo: to as string | null,
      notes: get("notes") || null,
      minAmount: min instanceof Decimal ? min.toString() : null,
      maxAmount: max instanceof Decimal ? max.toString() : null,
      shipmentValueAbove: above instanceof Decimal ? above.toString() : null,
      shipmentValueUpTo: upTo instanceof Decimal ? upTo.toString() : null,
    });
  });

  crossRowChecks(rows, issues);
  const failedLines = new Set(issues.filter((i) => i.severity === "error").map((i) => i.line));
  return summarise(rows.filter((r) => !failedLines.has(r.line)), issues);
}

function crossRowChecks(rows: RateRow[], issues: RowIssue[]) {
  const profiles = new Map<string, RateRow[]>();
  for (const r of rows) {
    const k = `${r.origin}|${r.destination}|${r.hsnCode}`;
    profiles.set(k, [...(profiles.get(k) ?? []), r]);
  }
  const descriptions = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.hsnDescription) continue;
    descriptions.set(r.hsnCode, (descriptions.get(r.hsnCode) ?? new Set()).add(r.hsnDescription));
  }
  for (const [hsn, set] of descriptions) {
    if (set.size > 1) {
      issues.push({ line: 0, column: "hsn_description", severity: "warning",
        message: `HSN ${hsn} has different descriptions in the file (${[...set].join(" / ")}); the last one is kept.` });
    }
  }
  for (const list of profiles.values()) {
    const seen = new Map<string, RateRow>();
    for (const r of list) {
      const n = r.componentName.toLowerCase();
      const dup = seen.get(n);
      if (dup) {
        issues.push({ line: r.line, column: "component_name", severity: "error",
          message: `"${r.componentName}" appears twice for HSN ${r.hsnCode} → ${r.destination} (also on line ${dup.line}).` });
      } else seen.set(n, r);
    }
    for (const r of list) {
      if (r.basis !== "value_plus_selected") continue;
      for (const name of r.basisIncludes) {
        const ref = seen.get(name.toLowerCase());
        if (!ref) {
          issues.push({ line: r.line, column: "basis_components", severity: "error",
            message: `basis_components refers to "${name}", which is not a component of HSN ${r.hsnCode} → ${r.destination}.` });
        } else if (ref.calcOrder >= r.calcOrder) {
          issues.push({ line: r.line, column: "basis_components", severity: "error",
            message: `"${name}" must have a lower calculation_order than "${r.componentName}" to be included in its base.` });
        } else if (ref.scope === "per_cart") {
          issues.push({ line: r.line, column: "basis_components", severity: "error",
            message: `"${name}" is a shipment-level charge and cannot be part of a product-level base.` });
        }
      }
    }
    // a fixed charge in a currency other than the destination's others
    const currencies = new Set(list.filter((r) => r.chargeType === "fixed").map((r) => r.currency));
    if (currencies.size > 1) {
      issues.push({ line: list[0].line, column: "currency", severity: "warning",
        message: `HSN ${list[0].hsnCode} → ${list[0].destination} has fixed charges in more than one currency (${[...currencies].join(", ")}).` });
    }
  }
}

function summarise(rows: RateRow[], issues: RowIssue[]): ParseResult {
  issues.sort((a, b) => a.line - b.line);
  return {
    rows,
    issues,
    errorCount: issues.filter((i) => i.severity === "error").length,
    warningCount: issues.filter((i) => i.severity === "warning").length,
  };
}

/** Row shape for export; values already formatted as text. */
export type ExportRow = Record<(typeof CSV_COLUMNS)[number], string>;

export function toCsv(rows: ExportRow[]): string {
  return "﻿" + stringify(rows, { header: true, columns: [...CSV_COLUMNS] });
}
