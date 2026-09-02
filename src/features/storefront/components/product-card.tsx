"use client";

import { Link } from "@tanstack/react-router";
import { Boxes, Zap } from "lucide-react";
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
	const available = product.availableStock !== 0;
	const isFree = BigInt(product.maxPriceMinor) === 0n;
	const singlePrice = product.maxPriceMinor === product.priceMinor;
	const hasDiscount =
		singlePrice &&
		product.listPriceMinor != null &&
		BigInt(product.listPriceMinor) > BigInt(product.priceMinor);
	const availability = stockLabel(product);
	let price: string = m.store_price_free();
	if (!isFree) {
		price = singlePrice
			? currency.format(
					product.priceMinor,
					product.currency,
					product.currencyDecimals,
				)
			: m.store_price_range({
					minimum: currency.format(
						product.priceMinor,
						product.currency,
						product.currencyDecimals,
					),
					maximum: currency.format(
						product.maxPriceMinor,
						product.currency,
						product.currencyDecimals,
					),
				});
	}
	return (
		<article className="group min-w-0">
			<Link
				className="flex h-full flex-col rounded-3xl bg-muted/25 p-3 transition-colors hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
				params={{ productId: product.id }}
				to="/products/$productId"
			>
				<div className="relative aspect-video overflow-hidden rounded-2xl bg-muted">
					{product.coverUrl ? (
						<img
							alt={product.name}
							className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.025]"
							loading="lazy"
							src={product.coverUrl}
						/>
					) : (
						<div className="grid size-full place-items-center bg-linear-to-br from-primary/15 via-muted to-muted">
							<Boxes className="size-12 text-primary/60" />
						</div>
					)}
					{product.deliveryTypes.includes("stock") && available ? (
						<div className="absolute end-3 top-3">
							<Badge
								className={
									product.hasAutomaticFulfillment
										? "bg-emerald-400 text-emerald-950"
										: "bg-amber-200 text-amber-950"
								}
							>
								<Zap />
								{product.hasManualFulfillment && product.hasAutomaticFulfillment
									? m.store_mixed_delivery()
									: product.hasManualFulfillment
										? m.store_manual_delivery()
										: m.store_auto_delivery()}
							</Badge>
						</div>
					) : null}
				</div>
				<div className="flex flex-1 flex-col px-2 pt-4 pb-2">
					<div className="flex min-h-5 flex-wrap gap-x-3 gap-y-1">
						{product.tags.slice(0, 3).map((tag) => (
							<Badge key={tag} variant="secondary">
								{tag}
							</Badge>
						))}
					</div>
					<div className="mt-2 font-semibold text-lg transition-colors group-hover:text-primary">
						<span className="line-clamp-1">{product.name}</span>
					</div>
					<p className="mt-2 line-clamp-2 min-h-10 text-muted-foreground text-sm">
						{product.description}
					</p>
					<div className="mt-auto flex items-end justify-between gap-3 pt-5">
						<div className="flex flex-wrap items-baseline gap-2">
							<strong className="text-primary text-xl">{price}</strong>
							{hasDiscount && product.listPriceMinor ? (
								<span className="text-muted-foreground text-xs line-through">
									{currency.format(
										product.listPriceMinor,
										product.currency,
										product.currencyDecimals,
									)}
								</span>
							) : null}
						</div>
						{product.syncedStockQuantity != null || availability ? (
							<div className="text-right text-muted-foreground text-xs">
								{product.syncedStockQuantity != null ? (
									<p className="flex items-center justify-end gap-1.5">
										<span className="font-medium text-foreground/75">
											{m.store_stock({ count: product.syncedStockQuantity })}
										</span>
									</p>
								) : null}
								{availability ? <p>{availability}</p> : null}
							</div>
						) : null}
					</div>
				</div>
			</Link>
		</article>
	);
}

export function StorefrontProductCardSkeleton() {
	return (
		<article className="min-w-0">
			<div className="flex h-full flex-col rounded-3xl bg-muted/25 p-3">
				<Skeleton className="aspect-video rounded-2xl" />
				<div className="flex flex-1 flex-col px-2 pt-4 pb-2">
					<div className="flex min-h-5 gap-2">
						<Skeleton className="h-5 w-16 rounded-full" />
						<Skeleton className="h-5 w-20 rounded-full" />
					</div>
					<Skeleton className="mt-2 h-7 w-3/4" />
					<div className="mt-2 grid min-h-10 content-start gap-2">
						<Skeleton className="h-4 w-full" />
						<Skeleton className="h-4 w-4/5" />
					</div>
					<div className="mt-auto flex items-end justify-between gap-3 pt-5">
						<Skeleton className="h-7 w-24" />
						<div className="grid justify-items-end gap-1">
							<Skeleton className="h-3 w-14" />
							<Skeleton className="h-3 w-12" />
						</div>
					</div>
				</div>
			</div>
		</article>
	);
}

function stockLabel(product: StorefrontCatalogProduct) {
	if (product.availableStock === 0) return m.store_sold_out();
	if (product.availableStock > 0 && product.availableStock <= 5)
		return m.store_low_stock({ count: product.availableStock });
	return null;
}
