import { type StockBand, stockBandPurchaseMaximum } from "./stock-band";

export function purchaseMaximum(item: {
	stockBand: StockBand;
	maximumQuantity: number;
}) {
	return stockBandPurchaseMaximum(item.stockBand, item.maximumQuantity);
}
