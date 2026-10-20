"use client";

import { Link } from "@tanstack/react-router";
import { Ban, Zap } from "lucide-react";
import { Badge } from "#/components/ui/badge";
import { Skeleton } from "#/components/ui/skeleton";
import { useCurrency } from "#/features/exchange-rates/currency-context";
import type { listStorefrontCatalogFn } from "#/features/storefront/server/catalog";
import { m } from "#/paraglide/messages";

export type StorefrontCatalogProduct = Awaited<
	ReturnType<typeof listStorefrontCatalogFn>
>["products"][number];

export function StorefrontProductCard({
	product,
}: {
	product: StorefrontCatalogProduct;
}) {
	const currency = useCurrency();
	// Negative counts are the existing non-stock/unlimited sentinel, not inventory.
	const displayStockQuantity =
		product.displayStockQuantity != null && product.displayStockQuantity < 0
			? null
			: product.displayStockQuantity;
	const available = displayStockQuantity !== 0;
	const isFree = BigInt(product.maxPriceMinor) === 0n;
	const singlePrice = product.maxPriceMinor === product.priceMinor;
	const hasDiscount =
		singlePrice &&
		product.listPriceMinor != null &&
		BigInt(product.listPriceMinor) > BigInt(product.priceMinor);
	const availability = stockLabel(displayStockQuantity);
	const price = isFree
		? m.store_price_free()
		: currency.format(
				product.priceMinor,
				product.currency,
				product.currencyDecimals,
			);
	// Multi-option products show their lowest price as "from".
	const priceLabel =
		singlePrice || isFree ? price : m.store_card_from({ price });
	const variants =
		product.variantCount > 1
			? m.store_card_variants_other({ count: product.variantCount })
			: product.variantCount === 1
				? m.store_card_variants_one()
				: null;
	const delivery =
		available && !product.saleDisabled
			? product.hasManualFulfillment && product.hasAutomaticFulfillment
				? m.store_mixed_delivery()
				: product.hasManualFulfillment
					? m.store_manual_delivery()
					: m.store_auto_delivery()
			: null;
	const stock =
		displayStockQuantity != null && displayStockQuantity > 0
			? m.store_stock({ count: displayStockQuantity })
			: null;
	return (
		<article className="group min-w-0">
			{/* Phones: one row (cover · name · price). Wider: cover row, name, price line. */}
			<Link
				className="grid h-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded-2xl border border-border/70 bg-muted/25 p-3.5 transition-colors [grid-template-areas:'cover_name_price'_'cover_sub_price'] hover:border-primary/40 hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 sm:grid-cols-[auto_minmax(0,1fr)] sm:grid-rows-[auto_auto_1fr] sm:gap-y-3 sm:p-4.5 sm:[grid-template-areas:'cover_meta'_'name_name'_'price_price']"
				params={{ productId: product.id }}
				to="/products/$productId"
			>
				<div className="relative size-11 shrink-0 overflow-hidden rounded-xl bg-primary/10 [grid-area:cover] sm:size-12">
					{product.coverUrl ? (
						<img
							alt=""
							className="size-full object-cover"
							loading="lazy"
							src={product.coverUrl}
						/>
					) : (
						<span
							aria-hidden="true"
							className="grid size-full place-items-center font-bold text-primary"
						>
							{productMark(product.name)}
						</span>
					)}
				</div>
				<div className="hidden min-w-0 items-center gap-2 self-center [grid-area:meta] sm:flex">
					{product.tags[0] ? (
						<span className="max-w-[45%] shrink-0 truncate text-muted-foreground text-xs">
							{product.tags[0]}
						</span>
					) : null}
					<div className="ms-auto flex min-w-0 justify-end">
						{product.saleDisabled ? (
							<Badge
								className="max-w-full [&>svg]:shrink-0"
								variant="destructive"
							>
								<Ban />
								<span className="truncate">{m.store_sale_disabled()}</span>
							</Badge>
						) : delivery ? (
							<Badge
								className={
									product.hasAutomaticFulfillment
										? "max-w-full bg-primary/10 text-primary [&>svg]:shrink-0"
										: "max-w-full bg-amber-200 text-amber-950 [&>svg]:shrink-0"
								}
								title={delivery}
							>
								<Zap />
								<span className="truncate">{delivery}</span>
							</Badge>
						) : null}
					</div>
				</div>
				<div className="line-clamp-2 font-semibold text-[15px] leading-snug transition-colors [grid-area:name] group-hover:text-primary sm:text-base">
					{product.name}
				</div>
				<p className="truncate text-muted-foreground text-xs [grid-area:sub] sm:hidden">
					{[
						variants,
						product.saleDisabled ? m.store_sale_disabled() : delivery,
						stock,
						availability,
					]
						.filter(Boolean)
						.join(" · ")}
				</p>
				<div className="flex flex-col items-end text-right [grid-area:price] sm:flex-row sm:flex-wrap sm:items-baseline sm:justify-between sm:gap-x-3 sm:gap-y-1 sm:self-end sm:text-left">
					<div className="flex flex-col items-end sm:flex-row sm:flex-wrap sm:items-baseline sm:gap-x-2">
						<strong className="whitespace-nowrap text-lg text-primary sm:text-xl">
							{priceLabel}
						</strong>
						{hasDiscount && product.listPriceMinor ? (
							<span className="text-muted-foreground text-xs line-through">
								{currency.format(
									product.listPriceMinor,
									product.currency,
									product.currencyDecimals,
								)}
							</span>
						) : null}
						{variants ? (
							<span className="hidden text-muted-foreground text-xs sm:inline">
								{variants}
							</span>
						) : null}
					</div>
					{stock || availability ? (
						<span className="hidden text-muted-foreground text-xs sm:inline">
							{[stock, availability].filter(Boolean).join(" · ")}
						</span>
					) : null}
				</div>
			</Link>
		</article>
	);
}

export function StorefrontProductCardSkeleton() {
	return (
		<article className="min-w-0">
			<div className="flex h-full items-center gap-3 rounded-2xl border border-border/70 bg-muted/25 p-3.5 sm:min-h-40 sm:flex-col sm:items-stretch sm:p-4.5">
				<Skeleton className="size-11 shrink-0 rounded-xl sm:size-12" />
				<div className="grid min-w-0 flex-1 content-start gap-2">
					<Skeleton className="h-5 w-3/4" />
					<Skeleton className="h-4 w-1/3" />
				</div>
				<Skeleton className="h-6 w-16 sm:w-24" />
			</div>
		</article>
	);
}

/** Short text mark for a product without a cover: "Claude Pro" → "C", "接码" → "接". */
function productMark(name: string) {
	const first = name.trim().charAt(0);
	return first ? first.toUpperCase() : "·";
}

function stockLabel(displayStockQuantity: number | null) {
	if (displayStockQuantity === 0) return m.store_sold_out();
	return null;
}
