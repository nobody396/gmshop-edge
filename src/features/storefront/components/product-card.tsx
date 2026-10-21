"use client";

import { Link } from "@tanstack/react-router";
import { Ban, Zap } from "lucide-react";
import { Badge } from "#/components/ui/badge";
import { Skeleton } from "#/components/ui/skeleton";
import { useCurrency } from "#/features/exchange-rates/currency-context";
import type { listStorefrontCatalogFn } from "#/features/storefront/server/catalog";
import { productThumbnailUrl } from "#/features/storefront/thumbnail";
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
	const cover = (
		<div className="relative size-11 shrink-0 overflow-hidden rounded-xl bg-primary/10 sm:size-10">
			{product.coverUrl ? (
				<img
					alt=""
					className="size-full object-cover"
					loading="lazy"
					src={productThumbnailUrl(product.coverUrl)}
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
	);
	const status = product.saleDisabled ? (
		<Badge className="max-w-full [&>svg]:shrink-0" variant="destructive">
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
	) : null;
	const listPrice =
		hasDiscount && product.listPriceMinor ? (
			<span className="text-muted-foreground text-xs line-through">
				{currency.format(
					product.listPriceMinor,
					product.currency,
					product.currencyDecimals,
				)}
			</span>
		) : null;
	return (
		<article className="group min-w-0">
			<Link
				className="flex h-full items-center gap-3 rounded-2xl border border-border/70 bg-muted/25 p-3.5 transition-colors hover:border-primary/40 hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 sm:flex-col sm:items-stretch sm:gap-2.5 sm:rounded-xl sm:p-3.5"
				params={{ productId: product.id }}
				to="/products/$productId"
			>
				{/* Phones: one row (cover · name · price). Wider: a compact card with a choose button. */}
				<div className="flex min-w-0 flex-1 items-center gap-3 sm:flex-none sm:items-start sm:justify-between">
					{cover}
					<div className="min-w-0 flex-1 sm:hidden">
						<div className="line-clamp-2 font-semibold text-[15px] leading-snug transition-colors group-hover:text-primary">
							{product.name}
						</div>
						<p className="truncate text-muted-foreground text-xs">
							{[
								variants,
								product.saleDisabled ? m.store_sale_disabled() : delivery,
								stock,
								availability,
							]
								.filter(Boolean)
								.join(" · ")}
						</p>
					</div>
					<div className="hidden min-w-0 justify-end sm:flex">{status}</div>
				</div>
				<div className="flex shrink-0 flex-col items-end text-right sm:hidden">
					<strong className="whitespace-nowrap text-lg text-primary">
						{priceLabel}
					</strong>
					{listPrice}
				</div>
				<div className="hidden min-w-0 sm:block">
					{product.tags[0] ? (
						<span className="block truncate text-muted-foreground text-xs">
							{product.tags[0]}
						</span>
					) : null}
					<div className="truncate font-semibold text-sm leading-snug transition-colors group-hover:text-primary">
						{product.name}
					</div>
				</div>
				<div className="hidden flex-wrap items-baseline gap-x-2 sm:flex">
					<strong className="whitespace-nowrap text-lg text-primary">
						{priceLabel}
					</strong>
					{listPrice}
				</div>
				<div className="hidden justify-between gap-2 text-muted-foreground text-xs sm:flex">
					<span>{variants}</span>
					<span>{[stock, availability].filter(Boolean).join(" · ")}</span>
				</div>
				<span className="mt-auto hidden h-8 items-center justify-center rounded-lg bg-primary/10 font-semibold text-primary text-sm transition-colors group-hover:bg-primary/20 sm:flex">
					{m.store_card_choose()}
				</span>
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
