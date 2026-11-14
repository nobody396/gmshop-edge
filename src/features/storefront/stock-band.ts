/**
 * Customers see a stock band, never the exact count (owner 2026-11-14): exact
 * numbers let competitors read our inventory. Change the thresholds here only.
 *
 * - `plenty`  可售数 ≥ 20   「库存充足」
 * - `limited` 5–19          「库存一般」
 * - `low`     1–4           「库存紧缺」
 * - `out`     0 (or below the minimum order quantity) — the existing sold-out copy
 * - `unlimited` not stock-tracked (manual / non-stock delivery) — no stock label
 *
 * Server code keeps validating orders against the real count; only the value
 * sent to browsers is reduced to a band.
 */
export const STOCK_BAND_THRESHOLDS = {
	plenty: 20,
	limited: 5,
} as const;

export type StockBand = "unlimited" | "plenty" | "limited" | "low" | "out";

export function stockBand(stock: number, minimumQuantity = 1): StockBand {
	if (stock < 0) return "unlimited";
	if (stock === 0 || stock < Math.max(1, minimumQuantity)) return "out";
	if (stock >= STOCK_BAND_THRESHOLDS.plenty) return "plenty";
	if (stock >= STOCK_BAND_THRESHOLDS.limited) return "limited";
	return "low";
}

export function stockBandInStock(band: StockBand) {
	return band !== "out";
}

/**
 * Largest quantity the picker offers. It is bounded by the band's ceiling, not
 * the real count, so the picker never reveals the exact stock; anything above
 * the real count is still refused by the server as "not enough stock".
 */
export function stockBandPurchaseMaximum(
	band: StockBand,
	maximumQuantity: number,
) {
	switch (band) {
		case "unlimited":
		case "plenty":
			return maximumQuantity;
		case "limited":
			return Math.min(maximumQuantity, STOCK_BAND_THRESHOLDS.plenty - 1);
		case "low":
			return Math.min(maximumQuantity, STOCK_BAND_THRESHOLDS.limited - 1);
		case "out":
			return 0;
	}
}
