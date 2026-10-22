import { StoreMoney } from "#/features/exchange-rates/currency-context";
import { paymentChannelLabel } from "#/features/storefront/payment-channel-label";
import {
	type CustomerPriceStep,
	type PriceSource,
	resolveUnitPrice,
	type VolumeStep,
} from "#/features/storefront/volume-pricing";
import { cn } from "#/lib/utils";
import { m } from "#/paraglide/messages";

export type ItemPricing = {
	volumeSteps: VolumeStep[];
	customerSteps: CustomerPriceStep[];
};

type PricedItem = {
	priceMinor: string;
	currency: string;
	currencyDecimals: number;
	maximumQuantity: number;
	channelPrices: Array<{ id: string; name: string; priceMinor: string }>;
};

/** Unit price of `item` at `quantity` on one channel (or the base price). */
export function unitPriceAt(
	item: PricedItem,
	pricing: ItemPricing | undefined,
	quantity: number,
	channel: { id: string; priceMinor: string } | null,
): { unitPriceMinor: string; source: PriceSource } {
	return resolveUnitPrice({
		listPriceMinor: channel?.priceMinor ?? item.priceMinor,
		basePriceMinor: item.priceMinor,
		channelId: channel?.id ?? null,
		quantity,
		volumeSteps: pricing?.volumeSteps ?? [],
		customerSteps: pricing?.customerSteps ?? [],
	});
}

export function PriceSourceBadge({ source }: { source: PriceSource }) {
	if (source === "list") return null;
	return (
		<span className="rounded-full bg-emerald-500/12 px-2 py-0.5 font-medium text-[11px] text-emerald-700 dark:text-emerald-300">
			{source === "customer"
				? m.store_price_badge_customer()
				: m.store_price_badge_volume()}
		</span>
	);
}

/**
 * Unit price per quantity range and payment method. Shown only when the plan
 * has volume steps or the signed-in customer has their own prices for it.
 */
export function VolumePriceTable({
	item,
	pricing,
	quantity,
}: {
	item: PricedItem;
	pricing: ItemPricing | undefined;
	quantity: number;
}) {
	if (!pricing) return null;
	const breakpoints = [
		...new Set([
			1,
			...pricing.volumeSteps.map((step) => step.minQuantity),
			...pricing.customerSteps.map((step) => step.minQuantity),
		]),
	]
		.filter((value) => value >= 1 && value <= item.maximumQuantity)
		.sort((left, right) => left - right);
	const channels: Array<{
		id: string;
		name: string;
		priceMinor: string;
	} | null> = item.channelPrices.length > 0 ? item.channelPrices : [null];
	const rows = breakpoints.map((minimum, index) => {
		const next = breakpoints[index + 1];
		return {
			minimum,
			maximum: next ? next - 1 : item.maximumQuantity,
			last: !next,
			prices: channels.map((channel) =>
				unitPriceAt(item, pricing, minimum, channel),
			),
		};
	});
	const customer = pricing.customerSteps.length > 0;
	if (rows.length < 2 && !customer) return null;
	return (
		<section className="mt-4 rounded-xl border border-border/70 bg-card/55 p-4">
			<h3 className="font-semibold text-sm">
				{customer
					? m.store_customer_prices_title()
					: m.store_volume_prices_title()}
			</h3>
			<div className="mt-3 overflow-x-auto">
				<table className="w-full min-w-64 text-sm">
					<thead>
						<tr className="text-left text-muted-foreground text-xs">
							<th className="py-1.5 pr-3 font-medium" scope="col">
								{m.store_quantity()}
							</th>
							{channels.map((channel) => (
								<th
									className="py-1.5 pr-3 text-right font-medium"
									key={channel?.id ?? "base"}
									scope="col"
								>
									{channel ? paymentChannelLabel(channel.name) : null}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{rows.map((row) => {
							const active =
								quantity >= row.minimum &&
								(row.last || quantity <= row.maximum);
							return (
								<tr
									className={cn(
										"border-border/60 border-t",
										active && "bg-primary/[0.07] font-semibold",
									)}
									key={row.minimum}
								>
									<th className="py-1.5 pr-3 text-left font-normal" scope="row">
										{row.last && row.minimum < item.maximumQuantity
											? m.store_volume_range_open({ minimum: row.minimum })
											: row.minimum === row.maximum
												? m.store_volume_range_open({ minimum: row.minimum })
												: m.store_volume_range({
														minimum: row.minimum,
														maximum: row.maximum,
													})}
									</th>
									{row.prices.map((price, index) => (
										<td
											className="py-1.5 pr-3 text-right tabular-nums"
											key={channels[index]?.id ?? "base"}
										>
											<StoreMoney
												amountMinor={price.unitPriceMinor}
												currency={item.currency}
												decimals={item.currencyDecimals}
											/>
										</td>
									))}
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
			<p className="mt-2 text-muted-foreground text-xs">
				{m.store_volume_unit_price_note()}
			</p>
		</section>
	);
}
