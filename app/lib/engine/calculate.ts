import Decimal from "decimal.js";
import type {
  ComponentResult,
  EngineComponent,
  EngineInput,
  EngineIssue,
  EngineLine,
  EngineResult,
  GroupResult,
  ShipmentChargeResult,
  SummaryRow,
} from "./types";

/**
 * Setu Store duty engine.
 *
 *  1. Lines are grouped by HSN. Each HSN group is matched to the profile
 *     HSN + origin (India) + destination that the caller loaded.
 *  2. Group-level components (all percentages, and fixed charges scoped
 *     per unit / per line / per HSN group) run in calcOrder.
 *  3. Per-cart fixed charges (e.g. MPF) are collected from every group and
 *     applied once, de-duplicated by name. When two HSNs configure the same
 *     charge with different amounts, the higher amount is used.
 *     Per-vendor charges are not used: whether vendors ship separately is
 *     only settled at checkout, so they are never added to the cart total.
 *  Currencies are never mixed: percentages use the cart's own amounts; a
 *  fixed charge is applied only when its currency equals the cart currency.
 *  4. Nothing missing is ever filled with a guessed rate: the line or charge
 *     is reported as an issue and the result is marked "partial".
 *
 * Rounding: every component amount is rounded half-up to the currency's
 * minor unit; later bases and all totals use those rounded amounts, so the
 * breakdown always adds up to the total shown.
 */


export function currencyDigits(currency: string): number {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
      .maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

const d = (v: string | number) => new Decimal(v);
const fmt = (v: Decimal, digits: number) => v.toFixed(digits);
const cleanRate = (v: string) => new Decimal(v).toString();

export function isEffective(c: EngineComponent, today: string): boolean {
  if (!c.active) return false;
  if (c.effectiveFrom && today < c.effectiveFrom) return false;
  if (c.effectiveTo && today > c.effectiveTo) return false;
  return true;
}

function clamp(v: Decimal, min: string | null, max: string | null): Decimal {
  let out = v;
  if (min != null && out.lt(min)) out = d(min);
  if (max != null && out.gt(max)) out = d(max);
  return out;
}

export function calculate(input: EngineInput): EngineResult {
  const { lines, destination, currency, profiles, today, destinationCurrency } = input;
  const digits = currencyDigits(currency);
  const round = (v: Decimal) => v.toDecimalPlaces(digits, Decimal.ROUND_HALF_UP);

  const subtotal = lines.reduce((s, l) => s.plus(l.value), d(0));
  const base: EngineResult = {
    status: "complete",
    currency,
    destination,
    subtotal: fmt(subtotal, digits),
    calculatedValue: fmt(d(0), digits),
    groups: [],
    shipmentCharges: [],
    summary: [],
    totalCharges: fmt(d(0), digits),
    landedCost: fmt(subtotal, digits),
    issues: [],
    currencyNote: null,
  };

  if (lines.length === 0) return { ...base, status: "empty" };
  if (!destination) return { ...base, status: "no_destination" };

  const issues: EngineIssue[] = [];

  // --- group lines by HSN -------------------------------------------------
  const byHsn = new Map<string, EngineLine[]>();
  const noHsn: EngineLine[] = [];
  for (const line of lines) {
    if (!line.hsn) noHsn.push(line);
    else byHsn.set(line.hsn, [...(byHsn.get(line.hsn) ?? []), line]);
  }
  if (noHsn.length) {
    issues.push({
      type: "missing_hsn",
      lineKeys: noHsn.map((l) => l.key),
      productTitles: noHsn.map((l) => l.productTitle),
      message: "No HSN code is set for these products, so duties could not be estimated.",
    });
  }

  const groups: GroupResult[] = [];
  const shipmentCandidates: EngineComponent[] = [];
  let calculatedValue = d(0);

  for (const [hsn, groupLines] of byHsn) {
    const profile = profiles[hsn];
    const titles = groupLines.map((l) => l.productTitle);
    const keys = groupLines.map((l) => l.key);

    if (!profile || !profile.active) {
      issues.push({
        type: "no_profile",
        hsn,
        lineKeys: keys,
        productTitles: titles,
        message: `No duty configuration for HSN ${hsn} to this destination.`,
      });
      continue;
    }

    const applicable = profile.components
      .filter((c) => isEffective(c, today))
      .sort((a, b) => a.calcOrder - b.calcOrder || a.name.localeCompare(b.name));

    if (applicable.length === 0) {
      issues.push({
        type: "no_active_components",
        hsn,
        lineKeys: keys,
        productTitles: titles,
        message: `HSN ${hsn} has no active duty components for this destination today.`,
      });
      continue;
    }

    const value = groupLines.reduce((s, l) => s.plus(l.value), d(0));
    const units = groupLines.reduce((s, l) => s + l.quantity, 0);
    calculatedValue = calculatedValue.plus(value);

    const results: ComponentResult[] = [];
    const amountsByName = new Map<string, Decimal>();
    let priorSum = d(0);

    for (const c of applicable) {
      if (c.scope === "per_vendor_shipment") {
        issues.push({
          type: "unsupported_scope", hsn, component: c.name, lineKeys: keys, productTitles: titles,
          message: `${c.name} is set per vendor shipment, which is not used on the cart; it was left out.`,
        });
        continue;
      }
      if (c.chargeType === "fixed") {
        if (!c.currency) {
          issues.push({
            type: "fixed_missing_currency", hsn, component: c.name, componentCurrency: null,
            lineKeys: keys, productTitles: titles,
            message: `${c.name} has no currency configured, so it was left out.`,
          });
          continue;
        }
        if (c.currency !== currency) {
          issues.push({
            type: "currency_mismatch", hsn, component: c.name, componentCurrency: c.currency,
            componentAmount: d(c.rateValue).toString(),
            lineKeys: keys, productTitles: titles,
            message: `${c.name} (${d(c.rateValue).toString()} ${c.currency}) is not included because your cart is in ${currency} and no ${currency} amount is configured.`,
          });
          continue;
        }
        if (c.scope === "per_cart") {
          shipmentCandidates.push(c);
          continue;
        }
        const multiplier =
          c.scope === "per_unit" ? units : c.scope === "per_line" ? groupLines.length : 1;
        const amount = round(clamp(d(c.rateValue).times(multiplier), c.minAmount, c.maxAmount));
        results.push({
          name: c.name, chargeType: "fixed", scope: c.scope, ratePercent: null,
          fixedAmount: fmt(d(c.rateValue), digits), base: null, multiplier,
          amount: fmt(amount, digits),
        });
        amountsByName.set(c.name, amount);
        priorSum = priorSum.plus(amount);
        continue;
      }

      // percentage
      let componentBase = value;
      if (c.basis === "value_plus_prior") componentBase = value.plus(priorSum);
      if (c.basis === "value_plus_selected") {
        componentBase = c.basisIncludes.reduce(
          (s, name) => s.plus(amountsByName.get(name) ?? 0),
          value,
        );
      }
      const amount = round(
        clamp(componentBase.times(c.rateValue).dividedBy(100), c.minAmount, c.maxAmount),
      );
      results.push({
        name: c.name, chargeType: "percentage", scope: c.scope,
        ratePercent: cleanRate(c.rateValue), fixedAmount: null,
        base: fmt(componentBase, digits), multiplier: null, amount: fmt(amount, digits),
      });
      amountsByName.set(c.name, amount);
      priorSum = priorSum.plus(amount);
    }

    groups.push({
      hsn,
      hsnDescription: profile.hsnDescription,
      value: fmt(value, digits),
      lines: groupLines.map((l) => ({
        key: l.key, productTitle: l.productTitle, variantTitle: l.variantTitle,
        quantity: l.quantity, value: fmt(d(l.value), digits),
      })),
      components: results,
      total: fmt(results.reduce((s, r) => s.plus(r.amount), d(0)), digits),
    });
  }

  // --- per-cart charges, applied once ------------------------------------
  const shipment = new Map<string, EngineComponent>();
  for (const c of shipmentCandidates) {
    const existing = shipment.get(c.name);
    if (!existing || d(c.rateValue).gt(existing.rateValue)) shipment.set(c.name, c);
  }
  const shipmentCharges: ShipmentChargeResult[] = [...shipment.values()]
    .sort((a, b) => a.calcOrder - b.calcOrder || a.name.localeCompare(b.name))
    .map((c) => ({
      name: c.name, chargeType: "fixed", scope: c.scope, ratePercent: null,
      fixedAmount: fmt(d(c.rateValue), digits), base: null, multiplier: 1,
      amount: fmt(round(clamp(d(c.rateValue), c.minAmount, c.maxAmount)), digits),
    }));

  // --- summary, one row per component name -------------------------------
  const summaryMap = new Map<string, { row: SummaryRow; rates: Set<string>; total: Decimal }>();
  const addSummary = (r: ComponentResult) => {
    const key = `${r.name}|${r.chargeType}|${r.scope}`;
    const entry = summaryMap.get(key) ?? {
      row: { name: r.name, chargeType: r.chargeType, scope: r.scope, ratePercent: null, amount: "0" },
      rates: new Set<string>(),
      total: d(0),
    };
    if (r.ratePercent) entry.rates.add(r.ratePercent);
    entry.total = entry.total.plus(r.amount);
    summaryMap.set(key, entry);
  };
  groups.forEach((g) => g.components.forEach(addSummary));
  shipmentCharges.forEach(addSummary);
  const summary = [...summaryMap.values()].map(({ row, rates, total }) => ({
    ...row,
    ratePercent:
      row.chargeType === "percentage" ? (rates.size === 1 ? [...rates][0] : "varies") : null,
    amount: fmt(total, digits),
  }));

  const totalCharges = summary.reduce((s, r) => s.plus(r.amount), d(0));

  // The same per-cart charge (e.g. MPF) on several HSNs is one problem, not several.
  const merged: EngineIssue[] = [];
  for (const issue of issues) {
    const same = issue.type === "currency_mismatch" || issue.type === "fixed_missing_currency"
      ? merged.find((m) => m.type === issue.type && m.component === issue.component) : undefined;
    if (same) {
      same.lineKeys.push(...issue.lineKeys);
      same.productTitles.push(...issue.productTitles);
      same.hsn = undefined;
    } else merged.push({ ...issue, lineKeys: [...issue.lineKeys], productTitles: [...issue.productTitles] });
  }

  const currencyNote = destinationCurrency && destinationCurrency !== currency
    ? {
      cartCurrency: currency,
      destinationCurrency,
      message: `Your cart is priced in ${currency}. Duties are shown in ${currency}; charges set in ${destinationCurrency} are listed separately and not added.`,
    }
    : null;

  return {
    ...base,
    status: merged.length ? "partial" : "complete",
    calculatedValue: fmt(calculatedValue, digits),
    groups,
    shipmentCharges,
    summary,
    totalCharges: fmt(totalCharges, digits),
    landedCost: fmt(subtotal.plus(totalCharges), digits),
    issues: merged,
    currencyNote,
  };
}
