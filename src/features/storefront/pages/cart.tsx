"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
	AlertTriangle,
	ArrowRight,
	Boxes,
	LogIn,
	Minus,
	Plus,
	RefreshCcw,
	ShoppingCart,
	Trash2,
} from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Skeleton } from "#/components/ui/skeleton";
import { authClient } from "#/features/auth/auth-client";
import { StoreMoney } from "#/features/exchange-rates/currency-context";
import {
	removeLocalCartItem,
	useLocalCart,
	writeLocalCart,
} from "#/features/storefront/cart-storage";
import { purchaseMaximum } from "#/features/storefront/product-quantity";
import {
	getStoreCartFn,
	previewStoreCartFn,
	removeStoreCartItemFn,
	setStoreCartItemFn,
	syncStoreCartFn,
} from "#/features/storefront/server/cart";
import { productThumbnailUrl } from "#/features/storefront/thumbnail";
import { m } from "#/paraglide/messages";

export function StorefrontCartPage() {
	const session = authClient.useSession();
	const local = useLocalCart();
	const client = useQueryClient();
	const merged = useRef(false);
	const cloud = useQuery({
		queryKey: ["storefront", "cart"],
		queryFn: () => getStoreCartFn(),
		enabled: Boolean(session.data?.user),
	});
	const preview = useQuery({
		queryKey: ["storefront", "cart-preview", local.items],
		queryFn: () =>
			previewStoreCartFn({
				data: { items: local.items, expectedVersion: null },
			}),
		enabled: !session.data?.user && local.items.length > 0,
	});
	const merge = useMutation({
		mutationFn: syncStoreCartFn,
		onSuccess: async () => {
			writeLocalCart([]);
			await client.invalidateQueries({ queryKey: ["storefront", "cart"] });
		},
		onError: () => toast.error(m.store_checkout_failed()),
	});
	useEffect(() => {
		if (
			session.data?.user &&
			cloud.data?.authenticated &&
			local.items.length &&
			!merged.current
		) {
			merged.current = true;
			merge.mutate({
				data: { items: local.items, expectedVersion: cloud.data.version },
			});
		}
	}, [cloud.data, local.items, merge, session.data?.user]);

	const cart = session.data?.user ? cloud.data : preview.data;
	const items = cart?.items ?? [];
	const currencies = new Set(
		items.flatMap((item) =>
			"currency" in item ? [`${item.currency}:${item.currencyDecimals}`] : [],
		),
	);
	const blocked =
		currencies.size > 1 || items.some((item) => item.issues.length > 0);
	const signInRequired =
		!session.data?.user &&
		items.some(
			(item) => "deliveryType" in item && item.deliveryType === "automation",
		);
	const total = items.reduce(
		(sum, item) =>
			"priceMinor" in item
				? sum + BigInt(item.priceMinor ?? "0") * BigInt(item.quantity)
				: sum,
		0n,
	);
	const currencyItem = items.find((item) => "currency" in item);
	const itemCount = items.reduce((sum, item) => sum + item.quantity, 0);
	const cartPending =
		session.isPending ||
		(Boolean(session.data?.user) && cloud.isPending) ||
		(!session.data?.user && local.items.length > 0 && preview.isPending);
	const cartError = session.data?.user ? cloud.isError : preview.isError;

	async function updateItem(sellableItemId: string, quantity: number) {
		try {
			if (session.data?.user && cart?.authenticated && cart.version != null) {
				await setStoreCartItemFn({
					data: { sellableItemId, quantity, expectedVersion: cart.version },
				});
				await client.invalidateQueries({ queryKey: ["storefront", "cart"] });
				return;
			}
			writeLocalCart(
				local.items.map((item) =>
					item.sellableItemId === sellableItemId ? { ...item, quantity } : item,
				),
			);
		} catch {
			toast.error(m.store_cart_update_failed());
		}
	}

	async function removeItem(sellableItemId: string) {
		try {
			if (session.data?.user && cart?.authenticated && cart.version != null) {
				await removeStoreCartItemFn({
					data: { sellableItemId, expectedVersion: cart.version },
				});
				await client.invalidateQueries({ queryKey: ["storefront", "cart"] });
				return;
			}
			removeLocalCartItem(sellableItemId);
		} catch {
			toast.error(m.store_cart_update_failed());
		}
	}

	return (
		<div className="container px-4 py-10 sm:py-14">
			<div className="mb-10">
				<div>
					<h1 className="font-semibold text-4xl tracking-[-0.035em]">
						{m.store_cart_title()}
					</h1>
					<p className="mt-2 text-muted-foreground">
						{m.store_cart_description()}
					</p>
				</div>
			</div>
			{cartPending ? (
				<CartLoadingSkeleton
					itemCount={local.items.length > 0 ? local.items.length : 2}
				/>
			) : cartError ? (
				<CartState
					action={
						<Button
							onClick={() =>
								void (session.data?.user ? cloud.refetch() : preview.refetch())
							}
						>
							<RefreshCcw />
							{m.common_retry()}
						</Button>
					}
					icon={<AlertTriangle className="text-destructive" />}
					title={m.store_cart_update_failed()}
				/>
			) : !items.length ? (
				<div className="grid min-h-80 place-items-center rounded-3xl bg-muted/30 text-center">
					<div className="max-w-sm px-6">
						<ShoppingCart className="mx-auto size-12 text-muted-foreground" />
						<h2 className="mt-4 font-semibold text-xl">
							{m.store_cart_empty()}
						</h2>
						<p className="mt-2 text-muted-foreground text-sm">
							{m.store_cart_empty_description()}
						</p>
						<Button asChild className="mt-6">
							<Link to="/">{m.store_continue_shopping()}</Link>
						</Button>
					</div>
				</div>
			) : (
				<div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_21rem] lg:gap-16">
					<div className="grid content-start gap-3">
						{items.map((item) => {
							const minimumQuantity =
								("minimumQuantity" in item ? item.minimumQuantity : 1) ?? 1;
							const maximumQuantity =
								typeof item.maximumQuantity === "number" &&
								typeof item.availableStock === "number"
									? purchaseMaximum(item)
									: 1_000;
							const quantityAdjustable = maximumQuantity > minimumQuantity;
							return (
								<div
									className="grid gap-5 rounded-2xl bg-muted/30 p-4 sm:grid-cols-[6rem_minmax(0,1fr)_auto] sm:items-center sm:p-5"
									key={item.sellableItemId}
								>
									<div>
										{"coverUrl" in item && item.coverUrl ? (
											<img
												alt={item.productName}
												className="aspect-video w-24 rounded-xl object-cover"
												src={productThumbnailUrl(item.coverUrl)}
											/>
										) : (
											<div className="grid aspect-video w-24 place-items-center rounded-xl bg-muted">
												<Boxes className="size-8 text-muted-foreground" />
											</div>
										)}
									</div>
									<div className="min-w-0">
										{"productId" in item ? (
											<Link
												className="font-semibold hover:underline"
												params={{ productId: item.productId ?? "" }}
												to="/products/$productId"
											>
												{item.productName}
											</Link>
										) : (
											<strong>{item.productName}</strong>
										)}
										{item.sellableItemName !== item.productName ? (
											<p className="text-muted-foreground text-sm">
												{item.sellableItemName}
											</p>
										) : null}
										{!quantityAdjustable && item.quantity > 1 ? (
											<p className="text-muted-foreground text-sm">
												{m.store_quantity()} × {item.quantity}
											</p>
										) : null}
										{item.issues.length ? (
											<div className="mt-3 grid gap-2">
												{item.issues.map((issue) => (
													<p
														className="flex items-start gap-2 text-destructive text-sm"
														key={issue}
													>
														<AlertTriangle className="mt-0.5 size-4 shrink-0" />
														{cartIssueMessage(issue)}
													</p>
												))}
												{item.issues.includes("price_changed") ? (
													<Button
														className="w-fit"
														onClick={() =>
															void updateItem(
																item.sellableItemId,
																item.quantity,
															)
														}
														size="sm"
														variant="outline"
													>
														{m.store_cart_accept_changes()}
													</Button>
												) : null}
											</div>
										) : null}
									</div>
									<div className="flex items-center justify-between gap-3 sm:grid sm:justify-items-end">
										{"priceMinor" in item ? (
											<strong className="text-lg">
												<StoreMoney
													amountMinor={(
														BigInt(item.priceMinor ?? "0") *
														BigInt(item.quantity)
													).toString()}
													currency={item.currency ?? "USD"}
													decimals={item.currencyDecimals ?? 2}
												/>
											</strong>
										) : null}
										<div className="flex items-center gap-1">
											{quantityAdjustable ? (
												<div className="flex h-9 items-center rounded-md bg-background">
													<Button
														aria-label={m.store_quantity_decrease()}
														disabled={item.quantity <= minimumQuantity}
														onClick={() =>
															void updateItem(
																item.sellableItemId,
																item.quantity - 1,
															)
														}
														size="icon-sm"
														type="button"
														variant="ghost"
													>
														<Minus />
													</Button>
													<Input
														aria-label={m.store_quantity()}
														className="h-9 w-12 border-0 bg-transparent px-1 text-center shadow-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
														max={maximumQuantity}
														min={minimumQuantity}
														onChange={(event) => {
															const quantity = Number(event.target.value);
															if (
																Number.isInteger(quantity) &&
																quantity >= minimumQuantity &&
																quantity <= maximumQuantity
															)
																void updateItem(item.sellableItemId, quantity);
														}}
														type="number"
														value={item.quantity}
													/>
													<Button
														aria-label={m.store_quantity_increase()}
														disabled={item.quantity >= maximumQuantity}
														onClick={() =>
															void updateItem(
																item.sellableItemId,
																item.quantity + 1,
															)
														}
														size="icon-sm"
														type="button"
														variant="ghost"
													>
														<Plus />
													</Button>
												</div>
											) : null}
											<Button
												aria-label={m.store_cart_remove()}
												className="text-muted-foreground hover:text-destructive"
												onClick={() => void removeItem(item.sellableItemId)}
												size="icon"
												variant="ghost"
											>
												<Trash2 />
											</Button>
										</div>
									</div>
								</div>
							);
						})}
					</div>
					<aside className="h-fit rounded-2xl bg-muted/30 p-6 lg:sticky lg:top-26">
						<h2 className="font-semibold text-lg">{m.store_order_total()}</h2>
						<div className="mt-5 grid gap-5">
							<p className="text-muted-foreground text-sm">
								{m.store_cart_item_count({ count: itemCount })}
							</p>
							{currencyItem && "currency" in currencyItem ? (
								<strong className="text-4xl tracking-tight">
									<StoreMoney
										amountMinor={total.toString()}
										currency={currencyItem.currency ?? "USD"}
										decimals={currencyItem.currencyDecimals ?? 2}
									/>
								</strong>
							) : null}
							{currencies.size > 1 ? (
								<p className="text-destructive text-sm">
									{m.store_cart_currency_conflict()}
								</p>
							) : null}
							{signInRequired ? (
								<>
									<p className="text-muted-foreground text-sm">
										{m.store_account_required_description()}
									</p>
									<Button asChild size="lg">
										<Link search={{ redirect: "/checkout" }} to="/sign-in">
											<LogIn />
											{m.store_sign_in_to_purchase()}
										</Link>
									</Button>
								</>
							) : (
								<Button asChild={!blocked} disabled={blocked} size="lg">
									{blocked ? (
										<span>{m.store_cart_checkout()}</span>
									) : (
										<Link to="/checkout">
											{m.store_cart_checkout()}
											<ArrowRight />
										</Link>
									)}
								</Button>
							)}
						</div>
					</aside>
				</div>
			)}
		</div>
	);
}

export function CartLoadingSkeleton({ itemCount = 2 }: { itemCount?: number }) {
	return (
		<section
			aria-busy="true"
			aria-label={m.common_loading()}
			className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_21rem] lg:gap-16"
			data-skeleton-layout="cart"
		>
			<div
				className="grid content-start gap-3"
				data-skeleton-region="cart-items"
			>
				{Array.from(
					{ length: Math.min(Math.max(itemCount, 1), 6) },
					(_, index) => `cart-item-${index}`,
				).map((key) => (
					<div
						className="grid gap-5 rounded-2xl bg-muted/30 p-4 sm:grid-cols-[6rem_minmax(0,1fr)_auto] sm:items-center sm:p-5"
						data-skeleton-item="cart"
						key={key}
					>
						<Skeleton className="aspect-video w-24 rounded-xl" />
						<div className="grid gap-2">
							<Skeleton className="h-5 w-2/3" />
							<Skeleton className="h-4 w-1/3" />
							<Skeleton className="h-4 w-1/2" />
						</div>
						<div className="flex items-center justify-between gap-3 sm:grid sm:justify-items-end">
							<Skeleton className="h-7 w-20" />
							<Skeleton className="h-9 w-28" />
						</div>
					</div>
				))}
			</div>
			<div
				className="h-fit rounded-2xl bg-muted/30 p-6 lg:sticky lg:top-26"
				data-skeleton-region="cart-summary"
			>
				<Skeleton className="h-7 w-28" />
				<div className="mt-5 grid gap-5">
					<Skeleton className="h-5 w-32" />
					<Skeleton className="h-10 w-2/3" />
					<Skeleton className="h-10 w-full rounded-md" />
				</div>
			</div>
		</section>
	);
}

function CartState({
	action,
	icon,
	title,
}: {
	action?: ReactNode;
	icon: ReactNode;
	title: string;
}) {
	return (
		<div className="grid min-h-80 place-items-center rounded-3xl bg-muted/30 p-8 text-center">
			<div className="grid max-w-sm place-items-center gap-4">
				<div className="[&>svg]:size-10">{icon}</div>
				<h2 className="font-semibold text-xl">{title}</h2>
				{action}
			</div>
		</div>
	);
}

function cartIssueMessage(issue: string) {
	if (issue === "unavailable") return m.store_cart_issue_unavailable();
	if (issue === "sold_out") return m.store_cart_issue_sold_out();
	if (issue === "quantity_unavailable") return m.store_cart_issue_quantity();
	if (issue === "price_changed") return m.store_cart_issue_price_changed();
	return m.store_cart_item_issue();
}
