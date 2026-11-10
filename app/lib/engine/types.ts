// Types for the duty calculation engine. The engine is pure: it receives the
// cart, the destination and the configured components, and returns a
// breakdown. It has no access to Shopify checkout and never changes it.

export type ChargeType = "percentage" | "fixed";
export type CalculationBasis =
  | "product_value"
  | "value_plus_prior"
  | "value_plus_selected"
  | "not_applicable";
export type ChargeScope =
  | "per_product_value"
  | "per_unit"
  | "per_line"
  | "per_hsn_group"
  | "per_vendor_shipment"
  | "per_cart";

/** Amounts are decimal strings in the cart currency ("100.00"). */
export interface EngineLine {
  key: string;
  productTitle: string;
  variantTitle?: string | null;
  quantity: number;
  /** Line value used as the duty base (after discounts when that setting is on). */
  value: string;
  hsn: string | null;
  /** Informational only; no charge is calculated per vendor. */
  vendor?: string | null;
}

export interface EngineComponent {
  id: string;
  name: string;
  chargeType: ChargeType;
  /** Percent for percentage components (10 = 10%), amount for fixed. */
  rateValue: string;
  currency: string | null;
  basis: CalculationBasis;
  basisIncludes: string[];
  calcOrder: number;
  scope: ChargeScope;
  minAmount: string | null;
  maxAmount: string | null;
  /** "YYYY-MM-DD" or null */
  effectiveFrom: string | null;
  effectiveTo: string | null;
  active: boolean;
}

export interface EngineProfile {
  hsn: string;
  hsnDescription: string | null;
  active: boolean;
  components: EngineComponent[];
}

export interface EngineInput {
  lines: EngineLine[];
  /** ISO code of the chosen destination, or null when the customer has not chosen. */
  destination: string | null;
  currency: string;
  /** Keyed by HSN code. Missing key = no profile for this HSN + destination. */
  profiles: Record<string, EngineProfile | undefined>;
  /** "YYYY-MM-DD" in the shop's timezone, for effective dates. */
  today: string;
  /** Currency configured for the destination (e.g. USD for the USA). */
  destinationCurrency?: string | null;
}

export type IssueType =
  | "missing_hsn"
  | "no_profile"
  | "no_active_components"
  | "currency_mismatch"
  | "fixed_missing_currency"
  | "unsupported_scope";

export interface EngineIssue {
  type: IssueType;
  hsn?: string;
  component?: string;
  componentCurrency?: string | null;
  /** Configured fixed amount, in componentCurrency, for currency issues. */
  componentAmount?: string | null;
  lineKeys: string[];
  productTitles: string[];
  message: string;
}

export interface ComponentResult {
  name: string;
  chargeType: ChargeType;
  scope: ChargeScope;
  /** Percent as entered ("10"), null for fixed. */
  ratePercent: string | null;
  /** Fixed amount per unit/line/group/shipment, null for percentage. */
  fixedAmount: string | null;
  base: string | null;
  /** How many times a fixed charge was applied (units, lines, vendors …). */
  multiplier: number | null;
  amount: string;
}

export interface GroupResult {
  hsn: string;
  hsnDescription: string | null;
  value: string;
  lines: { key: string; productTitle: string; variantTitle?: string | null; quantity: number; value: string }[];
  components: ComponentResult[];
  total: string;
}

/** A per-cart fixed charge (e.g. MPF), applied once to the whole cart. */
export type ShipmentChargeResult = ComponentResult;

export interface SummaryRow {
  name: string;
  chargeType: ChargeType;
  scope: ChargeScope;
  /** Single rate when every group used the same percent, "varies" otherwise, null for fixed. */
  ratePercent: string | null;
  amount: string;
}

export interface EngineResult {
  status: "complete" | "partial" | "no_destination" | "empty";
  currency: string;
  destination: string | null;
  subtotal: string;
  /** Value of lines that could be calculated. */
  calculatedValue: string;
  groups: GroupResult[];
  shipmentCharges: ShipmentChargeResult[];
  summary: SummaryRow[];
  totalCharges: string;
  /** subtotal + totalCharges; only meaningful when status is "complete". */
  landedCost: string;
  issues: EngineIssue[];
  /**
   * Set when the cart currency differs from the destination's configured
   * currency. Percentages are still correct (they use the cart's own amounts);
   * fixed charges in the other currency are left out, never converted.
   */
  currencyNote: { cartCurrency: string; destinationCurrency: string; message: string } | null;
}
