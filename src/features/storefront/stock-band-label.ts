import { m } from "#/paraglide/messages";
import type { StockBand } from "./stock-band";

/** Customer-facing stock copy; sold out and untracked stock return null (callers keep their own copy). */
export function stockBandLabel(band: StockBand | null | undefined) {
	switch (band) {
		case "plenty":
			return m.store_stock_plenty();
		case "limited":
			return m.store_stock_limited();
		case "low":
			return m.store_stock_low();
		default:
			return null;
	}
}
