import Decimal from "decimal.js";
import type { EngineLine } from "./types";

/**
 * Turning a Shopify cart (from /cart.js) into engine lines.
 *
 * Shopify cart prices are integers in the currency's subunit × 100 ("cents"),
 * in the cart's presentment currency (INR for Setu Store).
 */

export interface CartLineInput {
  key: string;
  variant_id: number;
  product_id: number;
  product_title: string;
  variant_title?: string | null;
  quantity: number;
  /** After line-level discounts. */
  final_line_price: number;
  /** Before any discount. */
  original_line_price: number;
}

export interface CalculateRequest {
  destination: string | null;
  currency: string;
  lines: CartLineInput[];
  /** Sum of cart-level (order) discounts, in cents. */
  cart_discount?: number;
}

const MAX_LINES = 250;
const isInt = (n: unknown) => typeof n === "number" && Number.isInteger(n) && n >= 0;

export function parseCalculateRequest(body: unknown): { ok: true; value: CalculateRequest } | { ok: false; error: string } {
  if (!body || typeof body !== "object") return { ok: false, error: "Body must be JSON." };
  const b = body as Record<string, unknown>;
  const destination = b.destination == null || b.destination === "" ? null : String(b.destination).toUpperCase();
  if (destination && !/^[A-Z]{2}$/.test(destination)) return { ok: false, error: "destination must be a 2-letter country code." };
  const currency = String(b.currency ?? "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, error: "currency must be a 3-letter code." };
  if (!Array.isArray(b.lines)) return { ok: false, error: "lines must be an array." };
  if (b.lines.length > MAX_LINES) return { ok: false, error: `At most ${MAX_LINES} cart lines.` };
  const lines: CartLineInput[] = [];
  for (const raw of b.lines as Record<string, unknown>[]) {
    if (!raw || typeof raw !== "object") return { ok: false, error: "Invalid line." };
    if (!isInt(raw.variant_id) || !isInt(raw.product_id) || !isInt(raw.quantity) || !isInt(raw.final_line_price) || !isInt(raw.original_line_price)) {
      return { ok: false, error: "Each line needs integer variant_id, product_id, quantity, final_line_price, original_line_price." };
    }
    lines.push({
      key: String(raw.key ?? raw.variant_id).slice(0, 200),
      variant_id: raw.variant_id as number,
      product_id: raw.product_id as number,
      product_title: String(raw.product_title ?? "").slice(0, 300),
      variant_title: raw.variant_title ? String(raw.variant_title).slice(0, 300) : null,
      quantity: raw.quantity as number,
      final_line_price: raw.final_line_price as number,
      original_line_price: raw.original_line_price as number,
    });
  }
  const cart_discount = isInt(b.cart_discount) ? (b.cart_discount as number) : 0;
  return { ok: true, value: { destination, currency, lines, cart_discount } };
}

/**
 * Line values used as the duty base.
 * useDiscountedValue: line-level discounts already in final_line_price, and
 * cart-level discounts shared across lines in proportion to their value (the
 * last line takes the rounding remainder, so shares add up exactly).
 * Otherwise: original_line_price, before any discount.
 */
export function buildEngineLines(
  req: CalculateRequest,
  hsnByVariant: Map<number, string | null>,
  useDiscountedValue: boolean,
): EngineLine[] {
  const lines = req.lines.filter((l) => l.quantity > 0);
  const base = lines.map((l) => (useDiscountedValue ? l.final_line_price : l.original_line_price));
  const total = base.reduce((s, v) => s + v, 0);
  const discount = useDiscountedValue ? Math.min(req.cart_discount ?? 0, total) : 0;
  const shares: number[] = [];
  if (discount > 0 && total > 0) {
    let allocated = 0;
    base.forEach((v, i) => {
      const share = i === base.length - 1 ? discount - allocated : Math.floor((discount * v) / total);
      shares.push(share);
      allocated += share;
    });
  }
  return lines.map((l, i) => ({
    key: l.key,
    productTitle: l.product_title,
    variantTitle: l.variant_title && l.variant_title !== "Default Title" ? l.variant_title : null,
    quantity: l.quantity,
    value: new Decimal(base[i] - (shares[i] ?? 0)).dividedBy(100).toFixed(2),
    hsn: hsnByVariant.get(l.variant_id) ?? null,
  }));
}
