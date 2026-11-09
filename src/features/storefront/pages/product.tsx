"use client";

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
	ArrowLeft,
	BadgePercent,
	Ban,
	BookOpen,
	BookOpenCheck,
	Boxes,
	Check,
	ChevronLeft,
	ChevronRight,
	CircleCheck,
	Clock3,
	Globe2,
	LogIn,
	Minus,
	PackageCheck,
	PackageOpen,
	Plus,
	ReceiptText,
	RefreshCw,
	ShieldCheck,
	ShoppingCart,
	TriangleAlert,
	Zap,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Skeleton } from "#/components/ui/skeleton";
import { AgentAccessCheckout } from "#/features/agent-access/components/access";
import { agentAccessKind } from "#/features/agent-access/products";
import { authClient } from "#/features/auth/auth-client";
import {
	claudeEnvTrafficProductId,
	claudeEnvTrafficSkus,
} from "#/features/claude-env/domain";
import {
	StoreMoney,
	useCurrency,
} from "#/features/exchange-rates/currency-context";
import { gptUpgradeProduct } from "#/features/gpt-upgrade/products";
import { appleIdLoginGuidePath } from "#/features/guides/apple-id-login";
import { addLocalCartItem } from "#/features/storefront/cart-storage";
import { trackCommerceEvent } from "#/features/storefront/commerce-events";
import {
	ChatGptRegionGuide,
	chatGptRechargeProductId,
} from "#/features/storefront/components/chatgpt-region-guide";
import {
	ClaudeKycNotice,
	splitClaudeKycNotice,
} from "#/features/storefront/components/claude-product-description";
import {
	ClaudePurchaseGuide,
	claudeRechargeProductId,
} from "#/features/storefront/components/claude-purchase-guide";
import {
	StorefrontProductCard,
	StorefrontProductCardSkeleton,
} from "#/features/storefront/components/product-card";
import {
	type ItemPricing,
	PriceSourceBadge,
	unitPriceAt,
	VolumePriceTable,
} from "#/features/storefront/components/volume-price-table";
import { paymentChannelLabel } from "#/features/storefront/payment-channel-label";
import { purchaseMaximum } from "#/features/storefront/product-quantity";
import {
	productPriceSummary,
	type StorefrontProduct,
	storefrontProductQueryOptions,
} from "#/features/storefront/product-seo";
import { listStorefrontCatalogFn } from "#/features/storefront/server/catalog";
import { getProductPricingFn } from "#/features/storefront/server/price-functions";
import {
	useFitStickyTop,
	usePublicHeaderHeight,
} from "#/features/storefront/sticky-top";
import { productThumbnailUrl } from "#/features/storefront/thumbnail";
import { cn } from "#/lib/utils";
import { m } from "#/paraglide/messages";
import { getLocale } from "#/paraglide/runtime";

type Product = StorefrontProduct;
type SellableItem = Product["sellableItems"][number];
type ChannelPrice = SellableItem["channelPrices"][number];

// Delivered content is an account or activation link, not a card plus redeem URL;
// the product description carries the real instructions.
const smsGuidePaths: Record<string, string> = {
	"ff4ff1f6-cad4-4821-a195-39befdcc32d6": "/guides/claude-sms-us",
	"8f78192a-3097-4ec2-a771-5aa76d1bccab": "/guides/google-sms-us",
};

const ownUsageGuideProductIds = new Set([
	...Object.keys(smsGuidePaths),
	"2ee356de-fe69-4641-94c3-1dfea19b6967", // Muse AI 成品号
	"64812c48-9026-4ef7-874d-b332d2a39b1a", // Gemini Pro 18个月 激活链接
	"c70d10e8-b781-4782-bc98-1f034bcd069a", // Apple ID 成品号
	"e4acdd84-af47-45fd-99c6-29cb7a2d38b1", // 美区个人 Gmail：详情里自带登录步骤
	"9e8b2987-1564-417e-8441-5936c5d592fa", // Telegram Premium 礼品链接
	"f2b92a96-290c-4ffa-aaf5-a26e7a35815d", // Claude 稳定使用（订单码 + 开关打开后自动开通，见 features/claude-env）
	claudeEnvTrafficProductId, // Claude 环境流量加购：付款后自动加到本期额度
]);
const appleIdProductId = "c70d10e8-b781-4782-bc98-1f034bcd069a";

export function StorefrontProductPage({
	productId,
	preferredItemId,
	landingSource,
}: {
	productId: string;
	preferredItemId?: string;
	landingSource?: "order" | "redeem";
}) {
	const locale = getLocale();
	const session = authClient.useSession();
	const product = useQuery(
		storefrontProductQueryOptions({ locale, productId }),
	);
	const relatedProducts = useQuery({
		queryKey: [
			"storefront",
			"related-products",
			locale,
			productId,
			product.data?.tags[0] ?? "",
		],
		queryFn: () =>
			listStorefrontCatalogFn({
				data: {
					locale,
					search: "",
					tag: product.data?.tags[0] ?? "",
					sort: "featured",
				},
			}),
		enabled: Boolean(product.data),
		staleTime: 30_000,
	});
	const [selectedItemId, setSelectedItemId] = useState<string>();
	// The buy box pins just below the sticky header (72px on desktop).
	const headerHeight = usePublicHeaderHeight(72);
	const [buyBoxTop, buyBox] = useFitStickyTop(headerHeight + 24);
	const [buyActions, setBuyActions] = useState<HTMLElement | null>(null);
	const [pageEnd, setPageEnd] = useState<HTMLElement | null>(null);
	const showBuyBar = useBuyBarVisible(buyActions, pageEnd);
	const [quantity, setQuantity] = useState(1);
	// Which payment method's price the buy box shows; checkout still asks.
	const [previewChannelId, setPreviewChannelId] = useState<string>();
	// Volume steps are public; customer prices need the session, so they are
	// fetched apart from the cached product.
	const pricing = useQuery({
		queryKey: [
			"storefront",
			"product-pricing",
			productId,
			session.data?.user.id ?? "guest",
		],
		queryFn: () =>
			getProductPricingFn({
				data: {
					sellableItemIds: (product.data?.sellableItems ?? []).map(
						(item) => item.id,
					),
				},
			}),
		enabled: Boolean(product.data?.sellableItems.length) && !session.isPending,
		staleTime: 30_000,
	});
	useEffect(() => {
		if (product.data?.id)
			trackCommerceEvent({
				eventType: "product_viewed",
				productId: product.data.id,
			});
	}, [product.data?.id]);
	// Growth links (order-page cross-sell, redeem site) land here; the weekly
	// report attributes orders placed later in the same browser session.
	useEffect(() => {
		if (product.data?.id && landingSource)
			trackCommerceEvent({
				eventType:
					landingSource === "order" ? "cross_sell_landed" : "redeem_landed",
				productId: product.data.id,
				sellableItemId: preferredItemId,
			});
	}, [product.data?.id, landingSource, preferredItemId]);
	useEffect(() => {
		const first = preferredItemId
			? product.data?.sellableItems.find((item) => item.id === preferredItemId)
			: (product.data?.sellableItems.find(
					(item) => isAvailable(item) && !item.saleDisabled,
				) ?? product.data?.sellableItems.find(isAvailable));
		if (!selectedItemId && first) {
			setSelectedItemId(first.id);
			setQuantity(first.minimumQuantity);
		}
	}, [product.data, selectedItemId, preferredItemId]);
	useEffect(() => {
		if (product.data && preferredItemId)
			document
				.getElementById("purchase-options")
				?.scrollIntoView?.({ block: "start" });
	}, [product.data, preferredItemId]);
	if (product.isLoading) return <ProductLoadingSkeleton />;
	if (!product.data) return null;
	const data = product.data;
	const selectedItem =
		data.sellableItems.find((item) => item.id === selectedItemId) ??
		(preferredItemId
			? data.sellableItems.find((item) => item.id === preferredItemId)
			: data.sellableItems[0]);
	const selectItem = (item: SellableItem) => {
		setSelectedItemId(item.id);
		setQuantity(item.minimumQuantity);
	};
	const requiresSignIn =
		((selectedItem?.deliveryType === "automation" &&
			!agentAccessKind(selectedItem.id) &&
			selectedItem.id !== gptUpgradeProduct.itemId) ||
			Boolean(selectedItem && claudeEnvTrafficSkus[selectedItem.id])) &&
		!session.isPending &&
		!session.data?.user;
	const checkoutPath = selectedItem
		? `/checkout?mode=buy-now&sellableItemId=${encodeURIComponent(selectedItem.id)}&quantity=${quantity}`
		: "/checkout";
	const maximumQuantity = selectedItem
		? purchaseMaximum(selectedItem)
		: undefined;
	const canPurchase =
		selectedItem != null &&
		!data.saleDisabled &&
		!selectedItem.saleDisabled &&
		isAvailable(selectedItem) &&
		Number.isInteger(quantity) &&
		quantity >= selectedItem.minimumQuantity &&
		maximumQuantity != null &&
		quantity <= maximumQuantity;
	const entitlement = selectedItem ? entitlementSummary(selectedItem) : null;
	const delivery = selectedItem
		? agentAccessKind(selectedItem.id)
			? m.agent_access_automatic_delivery()
			: deliveryPromise(selectedItem)
		: null;
	const purchaseLimit = selectedItem
		? purchaseLimitSummary(selectedItem)
		: null;
	const planGroups = groupPlans(data.sellableItems);
	const claudeKyc =
		data.id === claudeRechargeProductId && data.description
			? splitClaudeKycNotice(data.description)
			: null;
	const description = claudeKyc ? claudeKyc.remaining : data.description;
	// Short copy sits under the title; long copy gets its own section below.
	const longDescription =
		Boolean(description) &&
		((description?.length ?? 0) > 90 || description?.includes("\n"));
	const showPurchaseOptions =
		Boolean(preferredItemId) ||
		data.sellableItems.length > 1 ||
		data.id === "a48aeca2-90bf-4adf-8cfa-f18204373435";
	const previewChannel =
		selectedItem?.channelPrices.find(
			(channel) => channel.id === previewChannelId,
		) ??
		selectedItem?.channelPrices[0] ??
		null;
	const extraMedia = data.media.filter((media) => !media.cover);
	const recommendations =
		relatedProducts.data?.products
			.filter((relatedProduct) => relatedProduct.id !== data.id)
			.slice(0, 3) ?? [];
	const primaryAction = (className?: string) => (
		<PrimaryBuyAction
			canPurchase={canPurchase}
			checkoutPath={checkoutPath}
			className={className}
			requiresSignIn={requiresSignIn}
			saleDisabled={data.saleDisabled || Boolean(selectedItem?.saleDisabled)}
			selectedItem={selectedItem}
		/>
	);
	const addToCart = () => {
		if (!selectedItem || maximumQuantity == null) return;
		const added = addLocalCartItem(selectedItem.id, quantity, maximumQuantity);
		if (!added) {
			toast.error(m.store_cart_limit_reached());
			return;
		}
		trackCommerceEvent({
			eventType: "cart_item_added",
			productId: data.id,
			sellableItemId: selectedItem.id,
		});
		toast.success(m.store_cart_added());
	};
	const notices: PurchaseNotice[] = [
		...(data.saleDisabled
			? [
					{
						key: "sale-disabled",
						icon: Ban,
						tone: "danger" as const,
						content: m.store_sale_disabled_description(),
					},
				]
			: []),
		...(claudeKyc
			? [
					{
						key: "claude-kyc",
						icon: TriangleAlert,
						tone: "warn" as const,
						content: (
							<ClaudeKycNotice
								notice={claudeKyc.notice}
								title={claudeKyc.title}
							/>
						),
					},
				]
			: []),
		...(data.id === claudeRechargeProductId
			? [
					{
						key: "claude-channel",
						icon: ShieldCheck,
						content: m.store_claude_channel_notice(),
					},
					{
						key: "claude-guide",
						icon: BookOpen,
						tone: "warn" as const,
						content: (
							<a className={noticeLinkClass} href="#claude-purchase-guide">
								{m.store_claude_preflight_link()}
							</a>
						),
					},
					{
						key: "claude-check",
						icon: Globe2,
						content: (
							<a className={noticeLinkClass} href="#claude-ip-check">
								{m.store_claude_preflight_ip_title()}
							</a>
						),
					},
				]
			: []),
		...(data.id === chatGptRechargeProductId
			? [
					{
						key: "chatgpt-region",
						icon: Globe2,
						content: (
							<a className={noticeLinkClass} href="#chatgpt-region-guide">
								{m.store_chatgpt_region_notice()}
							</a>
						),
					},
				]
			: []),
		...(smsGuidePaths[data.id]
			? [
					{
						key: "sms-guide",
						icon: BookOpen,
						content: (
							<a className={noticeLinkClass} href={smsGuidePaths[data.id]}>
								{m.store_sms_usage_guide()}
							</a>
						),
					},
				]
			: []),
		...(data.id === appleIdProductId
			? [
					{
						key: "apple-id-guide",
						icon: BookOpen,
						content: (
							<a className={noticeLinkClass} href={appleIdLoginGuidePath}>
								查看图文教程：买到的 Apple ID 怎么登录 App Store
							</a>
						),
					},
				]
			: []),
		...(requiresSignIn
			? [
					{
						key: "sign-in",
						icon: LogIn,
						content: m.store_account_required_description(),
					},
				]
			: []),
		...(entitlement
			? [{ key: "entitlement", icon: Clock3, content: entitlement }]
			: []),
		// Upgrades charge the exact quote on every channel, so the Alipay surcharge note would mislead.
		...(data.id === gptUpgradeProduct.productId
			? []
			: [
					{
						key: "alipay-fee",
						icon: BadgePercent,
						content: m.store_alipay_fee_notice(),
					},
				]),
	];
	return (
		<div className="container px-4 py-6 sm:py-8">
			<Link
				className="mb-5 inline-flex items-center gap-2 text-muted-foreground text-sm transition-colors hover:text-foreground"
				to="/"
			>
				<ArrowLeft className="size-4" />
				{m.store_continue_shopping()}
			</Link>
			{/* Mobile reads header → options → buy box → notices → details; desktop pins the buy box in the right column. */}
			<div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:grid-rows-[auto_1fr] lg:gap-x-10 xl:grid-cols-[minmax(0,1fr)_24rem] xl:gap-x-14">
				<div className="min-w-0 lg:col-start-1 lg:row-start-1">
					<ProductHeader
						description={longDescription ? null : description}
						product={data}
						selectedItem={selectedItem}
					/>
					{showPurchaseOptions ? (
						<div className="mt-7">
							{preferredItemId && !selectedItem ? (
								<p role="alert" className="mb-3 text-destructive">
									{m.guide_unavailable()}
								</p>
							) : null}
							<PlanPicker
								channelId={previewChannel?.id ?? null}
								groups={planGroups}
								items={data.sellableItems}
								onSelect={selectItem}
								selectedItem={selectedItem}
							/>
						</div>
					) : null}
				</div>
				<aside
					aria-label={m.store_buybox_label()}
					className="min-w-0 self-start rounded-2xl border border-border/70 bg-card p-5 shadow-sm sm:p-6 lg:sticky lg:col-start-2 lg:row-span-2 lg:row-start-1"
					ref={buyBox}
					style={{ top: buyBoxTop }}
				>
					{selectedItem ? (
						<>
							<p className="text-muted-foreground text-sm leading-6">
								{m.store_buybox_selected()}{" "}
								<span className="font-medium text-foreground">
									{selectedItem.name}
								</span>
							</p>
							<BuyBoxPrice
								channel={previewChannel}
								pricing={pricing.data?.[selectedItem.id]}
								quantity={quantity}
								sellableItem={selectedItem}
							/>
							{selectedItem.id !== gptUpgradeProduct.itemId &&
							selectedItem.channelPrices.length > 1 ? (
								<PaymentPricePicker
									onSelect={setPreviewChannelId}
									pricing={pricing.data?.[selectedItem.id]}
									quantity={quantity}
									selectedChannelId={previewChannel?.id ?? null}
									sellableItem={selectedItem}
								/>
							) : null}
							{selectedItem.minimumQuantity !== selectedItem.maximumQuantity ? (
								<div className="mt-5 flex items-center justify-between gap-4">
									<Label htmlFor="product-quantity">{m.store_quantity()}</Label>
									<div className="flex h-10 items-center rounded-xl border border-border/70 bg-background p-0.5">
										<Button
											aria-label={m.store_quantity_decrease()}
											className="size-9 rounded-lg"
											disabled={quantity <= selectedItem.minimumQuantity}
											onClick={() =>
												setQuantity((current) =>
													Math.max(selectedItem.minimumQuantity, current - 1),
												)
											}
											size="icon"
											type="button"
											variant="ghost"
										>
											<Minus />
										</Button>
										<Input
											className="h-9 w-14 border-0 bg-transparent px-1 text-center font-medium tabular-nums shadow-none focus-visible:ring-0 dark:bg-transparent"
											id="product-quantity"
											max={maximumQuantity}
											min={selectedItem.minimumQuantity}
											onChange={(event) =>
												setQuantity(Number(event.target.value))
											}
											type="number"
											value={quantity}
										/>
										<Button
											aria-label={m.store_quantity_increase()}
											className="size-9 rounded-lg"
											disabled={
												maximumQuantity == null || quantity >= maximumQuantity
											}
											onClick={() =>
												setQuantity((current) =>
													Math.min(maximumQuantity ?? current, current + 1),
												)
											}
											size="icon"
											type="button"
											variant="ghost"
										>
											<Plus />
										</Button>
									</div>
								</div>
							) : null}
							{purchaseLimit ? (
								<p className="mt-2 text-end text-muted-foreground text-xs">
									{purchaseLimit}
								</p>
							) : null}
							<PriceStepsHint
								item={{
									...selectedItem,
									maximumQuantity:
										maximumQuantity ?? selectedItem.maximumQuantity,
								}}
								pricing={pricing.data?.[selectedItem.id]}
								quantity={quantity}
							/>
						</>
					) : (
						<p className="text-muted-foreground">{m.store_select_plan()}</p>
					)}
					<div className="mt-5 grid gap-2.5" ref={setBuyActions}>
						{primaryAction("h-12 w-full rounded-xl text-base")}
						{selectedItem?.id !== gptUpgradeProduct.itemId ? (
							<Button
								className="h-11 w-full rounded-xl"
								disabled={!canPurchase}
								onClick={addToCart}
								variant="outline"
							>
								<ShoppingCart />
								{m.store_add_to_cart()}
							</Button>
						) : null}
					</div>
					{selectedItem ? (
						<p className="mt-3 flex items-start justify-center gap-1.5 text-center text-muted-foreground text-xs leading-5">
							<ShieldCheck
								aria-hidden="true"
								className="mt-0.5 size-3.5 shrink-0 text-primary"
							/>
							<span>
								{[delivery, m.store_buybox_order_page()]
									.filter(Boolean)
									.join(" · ")}
							</span>
						</p>
					) : null}
					{selectedItem && agentAccessKind(selectedItem.id) ? (
						<AgentAccessCheckout
							key={selectedItem.id}
							itemId={selectedItem.id}
						/>
					) : null}
				</aside>
				<div className="grid min-w-0 content-start gap-5 lg:col-start-1 lg:row-start-2">
					<PurchaseNotices notices={notices} />
					{selectedItem ? <SkuPolicyPanel sellableItem={selectedItem} /> : null}
					{longDescription ? (
						<section className="rounded-2xl border border-border/70 bg-card/55 p-5 shadow-sm">
							<h2 className="font-semibold text-primary text-xs uppercase tracking-[0.16em]">
								{m.store_product_intro()}
							</h2>
							<p className="mt-3 whitespace-pre-wrap text-muted-foreground text-sm leading-7">
								{description}
							</p>
						</section>
					) : null}
					{extraMedia.length ? (
						<ProductGallery media={extraMedia} name={data.name} />
					) : null}
					{selectedItem &&
					data.productType === "stock" &&
					!ownUsageGuideProductIds.has(data.id) ? (
						<UsageGuide
							isChatGpt={data.id === chatGptRechargeProductId}
							sellableItem={selectedItem}
						/>
					) : null}
					{data.id === chatGptRechargeProductId ? <ChatGptRegionGuide /> : null}
					{data.id === claudeRechargeProductId ? <ClaudePurchaseGuide /> : null}
				</div>
			</div>
			{relatedProducts.isLoading ? (
				<RelatedProductsLoadingSkeleton />
			) : recommendations.length ? (
				<section className="mt-20 sm:mt-28">
					<div className="mb-6 flex items-end justify-between gap-5">
						<div>
							<h2 className="font-semibold text-2xl tracking-tight">
								{m.store_related_products()}
							</h2>
							<p className="mt-2 text-muted-foreground text-sm">
								{m.store_related_products_description()}
							</p>
						</div>
						<a
							className="shrink-0 text-primary text-sm transition-opacity hover:opacity-70"
							href={
								data.tags[0]
									? `/?search=&tag=${encodeURIComponent(data.tags[0])}&sort=featured`
									: "/?search=&tag=&sort=featured"
							}
						>
							{m.store_view_more_products()}
						</a>
					</div>
					<div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
						{recommendations.map((relatedProduct) => (
							<StorefrontProductCard
								key={relatedProduct.id}
								product={relatedProduct}
							/>
						))}
					</div>
				</section>
			) : null}
			<div aria-hidden="true" ref={setPageEnd} />
			{selectedItem ? (
				<section
					aria-label={m.store_buybar_label()}
					className={cn(
						"fixed inset-x-0 bottom-0 z-40 border-border/70 border-t bg-background/95 pb-[var(--safe-bottom)] shadow-[0_-12px_32px_-20px_rgb(0_0_0/0.45)] backdrop-blur-xl transition-transform duration-300 lg:hidden",
						showBuyBar ? "translate-y-0" : "translate-y-full",
					)}
					inert={!showBuyBar}
				>
					<div className="container flex items-center gap-3 px-4 py-3">
						<div className="min-w-0 flex-1">
							<p className="truncate text-muted-foreground text-xs">
								{selectedItem.name}
							</p>
							<p className="truncate font-semibold text-primary text-xl tabular-nums">
								<OrderTotal
									channel={previewChannel}
									pricing={pricing.data?.[selectedItem.id]}
									quantity={quantity}
									sellableItem={selectedItem}
								/>
							</p>
						</div>
						{primaryAction("h-11 shrink-0 rounded-xl px-6")}
					</div>
				</section>
			) : null}
		</div>
	);
}

/**
 * The fixed mobile buy bar appears once the buy box's buttons scroll out of
 * view and hides again near the end of the page, so it never covers the
 * footer or doubles the buttons already on screen.
 */
function useBuyBarVisible(
	actions: HTMLElement | null,
	pageEnd: HTMLElement | null,
) {
	const [actionsVisible, setActionsVisible] = useState(true);
	const [atEnd, setAtEnd] = useState(false);
	useEffect(() => {
		if (!actions || typeof IntersectionObserver === "undefined") return;
		const observer = new IntersectionObserver(([entry]) =>
			setActionsVisible(Boolean(entry?.isIntersecting)),
		);
		observer.observe(actions);
		return () => observer.disconnect();
	}, [actions]);
	useEffect(() => {
		if (!pageEnd || typeof IntersectionObserver === "undefined") return;
		const observer = new IntersectionObserver(([entry]) =>
			setAtEnd(
				Boolean(entry?.isIntersecting) ||
					(entry?.boundingClientRect.top ?? 1) < 0,
			),
		);
		observer.observe(pageEnd);
		return () => observer.disconnect();
	}, [pageEnd]);
	return !actionsVisible && !atEnd;
}

function PrimaryBuyAction({
	canPurchase,
	checkoutPath,
	className,
	requiresSignIn,
	saleDisabled,
	selectedItem,
}: {
	canPurchase: boolean;
	checkoutPath: string;
	className?: string;
	requiresSignIn: boolean;
	saleDisabled: boolean;
	selectedItem: SellableItem | undefined;
}) {
	if (requiresSignIn && canPurchase)
		return (
			<Button asChild className={className}>
				<Link search={{ redirect: checkoutPath }} to="/sign-in">
					<LogIn />
					{m.store_sign_in_to_purchase()}
				</Link>
			</Button>
		);
	if (requiresSignIn)
		return (
			<Button className={className} disabled>
				<LogIn />
				{m.store_sign_in_to_purchase()}
			</Button>
		);
	return (
		<Button
			className={className}
			disabled={!canPurchase}
			onClick={() => {
				if (!selectedItem) return;
				window.location.assign(
					selectedItem.id === gptUpgradeProduct.itemId
						? gptUpgradeProduct.quoteUrl
						: checkoutPath,
				);
			}}
		>
			<Zap />
			{saleDisabled
				? m.store_sale_disabled()
				: selectedItem?.id === gptUpgradeProduct.itemId
					? m.upgrade_get_quote()
					: m.store_buy_now()}
		</Button>
	);
}

function ProductHeader({
	description,
	product,
	selectedItem,
}: {
	description: string | null;
	product: Product;
	selectedItem: SellableItem | undefined;
}) {
	const manual = selectedItem?.fulfillmentSource === "manual";
	const warrantyDays = selectedItem
		? warrantyPeriodDays(selectedItem.policy.warranty)
		: null;
	return (
		<div>
			<div className="flex items-start gap-4">
				<div className="grid size-16 shrink-0 place-items-center overflow-hidden rounded-2xl border border-border/70 bg-muted sm:size-[4.5rem]">
					{product.coverUrl ? (
						<img
							alt=""
							className="size-full object-cover"
							src={productThumbnailUrl(product.coverUrl)}
						/>
					) : (
						<Boxes aria-hidden="true" className="size-8 text-primary/50" />
					)}
				</div>
				<div className="min-w-0">
					{product.tags.length ? (
						<div className="flex flex-wrap gap-x-2 text-muted-foreground text-sm">
							{product.tags.map((tag) => (
								<a
									className="transition-colors hover:text-foreground"
									href={`/?search=&tag=${encodeURIComponent(tag)}&sort=featured`}
									key={tag}
								>
									{tag}
								</a>
							))}
						</div>
					) : null}
					<h1 className="mt-0.5 text-balance font-semibold text-2xl tracking-[-0.03em] sm:text-3xl lg:text-[2.125rem]">
						{product.name}
					</h1>
					<ProductPriceLine product={product} />
				</div>
			</div>
			{selectedItem ? (
				<div className="mt-4 flex flex-wrap gap-2">
					<span
						className={cn(
							headerChipClass,
							manual
								? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
								: "border-primary/30 bg-primary/10 text-primary",
						)}
					>
						{manual ? (
							<Clock3 aria-hidden="true" className="size-3.5" />
						) : (
							<Zap aria-hidden="true" className="size-3.5" />
						)}
						{manual
							? m.store_manual_procurement()
							: selectedItem.deliveryType === "stock"
								? m.store_auto_delivery()
								: m.store_local_delivery()}
					</span>
					{warrantyDays ? (
						<span className={headerChipClass}>
							<ShieldCheck aria-hidden="true" className="size-3.5" />
							{m.store_chip_warranty({ days: warrantyDays })}
						</span>
					) : null}
					<a
						className={cn(headerChipClass, "hover:text-foreground")}
						href="/invoice"
					>
						<ReceiptText aria-hidden="true" className="size-3.5" />
						{m.store_chip_invoice()}
					</a>
				</div>
			) : null}
			{description ? (
				<p className="mt-4 max-w-2xl whitespace-pre-wrap text-muted-foreground text-sm leading-6">
					{description}
				</p>
			) : null}
		</div>
	);
}

const headerChipClass =
	"inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-background px-2.5 py-1 font-medium text-muted-foreground text-xs transition-colors";

/** "质保30天订阅" / "30-day warranty" → 30; nothing when the policy names no period. */
export function warrantyPeriodDays(warranty: string | null | undefined) {
	const match =
		warranty?.match(/质保\s*(\d+)\s*天/) ??
		warranty?.match(/(\d+)[\s-]*days?\b[^.;]*warranty/i) ??
		warranty?.match(/warranty[^.;]*?\b(\d+)[\s-]*days?\b/i);
	const days = match ? Number(match[1]) : 0;
	return days > 0 ? days : null;
}

/**
 * Tier tabs then the variants of that tier when the names group
 * ("ChatGPT Plus｜菲区｜1个月"); one card grid otherwise. Native radios keep
 * arrow-key selection and screen-reader semantics.
 */
function PlanPicker({
	channelId,
	groups,
	items,
	onSelect,
	selectedItem,
}: {
	channelId: string | null;
	groups: ReturnType<typeof groupPlans>;
	items: SellableItem[];
	onSelect: (item: SellableItem) => void;
	selectedItem: SellableItem | undefined;
}) {
	const currency = useCurrency();
	// One tier is no choice at all: show its variants directly, with short labels.
	if (!groups || groups.length === 1) {
		const options =
			groups?.[0]?.options ?? items.map((item) => ({ item, label: item.name }));
		return (
			<fieldset className="scroll-mt-24" id="purchase-options">
				<legend className="mb-3 font-medium">{m.store_select_plan()}</legend>
				<div className="grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-2.5">
					{options.map(({ item, label }) => (
						<PlanOption
							channelId={channelId}
							item={item}
							key={item.id}
							label={label ?? item.name}
							onSelect={onSelect}
							selected={item.id === selectedItem?.id}
						/>
					))}
				</div>
				<CoverageHint sellableItem={selectedItem} />
			</fieldset>
		);
	}
	const activeGroup =
		groups.find((group) =>
			group.options.some(({ item }) => item.id === selectedItem?.id),
		) ?? groups[0];
	return (
		<div className="grid scroll-mt-24 gap-6" id="purchase-options">
			<fieldset>
				<legend className="mb-3 flex items-center gap-2 font-medium">
					<StepNumber value={1} />
					{m.store_pick_tier()}
				</legend>
				<div className="flex flex-wrap gap-2">
					{groups.map((group) => {
						const lowest = lowestPrice(
							group.options.map(({ item }) => item),
							channelId,
						);
						return (
							<label
								className="group/tier inline-flex min-h-11 cursor-pointer items-baseline gap-2 rounded-xl border border-border/70 bg-card/60 px-3.5 py-2.5 ring-offset-background transition-[background-color,border-color,color,transform] duration-200 hover:border-primary/50 active:scale-[0.97] has-checked:border-primary has-checked:bg-primary has-checked:text-primary-foreground has-focus-visible:ring-2 has-focus-visible:ring-ring has-focus-visible:ring-offset-2"
								key={group.label}
							>
								<input
									checked={group === activeGroup}
									className="sr-only"
									name="plan-tier"
									onChange={() => {
										const options = group.options.map(({ item }) => item);
										const next =
											options.find(
												(item) => isAvailable(item) && !item.saleDisabled,
											) ??
											options.find(isAvailable) ??
											options[0];
										if (next) onSelect(next);
									}}
									type="radio"
									value={group.label}
								/>
								<span className="font-semibold text-sm">{group.label}</span>
								{lowest ? (
									<span className="text-muted-foreground text-xs tabular-nums group-has-checked/tier:text-primary-foreground/80">
										{m.store_card_from({
											price: currency.format(
												lowest.priceMinor,
												lowest.item.currency,
												lowest.item.currencyDecimals,
											),
										})}
									</span>
								) : null}
							</label>
						);
					})}
				</div>
			</fieldset>
			{activeGroup ? (
				<fieldset>
					<legend className="mb-3 flex items-center gap-2 font-medium">
						<StepNumber value={2} />
						{m.store_pick_variant()}
					</legend>
					<div className="grid grid-cols-[repeat(auto-fill,minmax(10rem,1fr))] gap-2.5">
						{activeGroup.options.map(({ item, label }) => (
							<PlanOption
								channelId={channelId}
								item={item}
								key={item.id}
								label={label ?? item.name}
								onSelect={onSelect}
								selected={item.id === selectedItem?.id}
							/>
						))}
					</div>
					<CoverageHint sellableItem={selectedItem} />
				</fieldset>
			) : null}
		</div>
	);
}

function StepNumber({ value }: { value: number }) {
	return (
		<span
			aria-hidden="true"
			className="grid size-5 place-items-center rounded-full bg-primary font-semibold text-[11px] text-primary-foreground"
		>
			{value}
		</span>
	);
}

/** Price of a plan on the payment method the buy box is showing. */
function channelPriceMinor(item: SellableItem, channelId: string | null) {
	return (
		item.channelPrices.find((channel) => channel.id === channelId)
			?.priceMinor ?? item.priceMinor
	);
}

/** Cheapest plan a buyer can actually pay for, for the "from" hint on tier tabs. */
function lowestPrice(items: SellableItem[], channelId: string | null) {
	if (items.some((item) => item.id === gptUpgradeProduct.itemId)) return null;
	const purchasable = items.filter((item) => !item.saleDisabled);
	let lowest: { item: SellableItem; priceMinor: bigint } | null = null;
	for (const item of purchasable.length ? purchasable : items) {
		const priceMinor = BigInt(channelPriceMinor(item, channelId));
		if (!lowest || priceMinor < lowest.priceMinor)
			lowest = { item, priceMinor };
	}
	return lowest;
}

function PlanOption({
	channelId,
	item,
	label,
	onSelect,
	selected,
}: {
	channelId: string | null;
	item: SellableItem;
	label: string;
	onSelect: (item: SellableItem) => void;
	selected: boolean;
}) {
	const available = isAvailable(item);
	const price = channelPriceMinor(item, channelId);
	return (
		<label
			className={cn(
				"relative grid min-h-24 cursor-pointer content-between gap-2 rounded-xl border border-border/70 bg-card/60 p-3.5 ring-offset-background transition-[background-color,border-color,box-shadow,transform] duration-200 hover:border-primary/50 active:scale-[0.98] has-checked:border-primary has-checked:bg-primary/[0.07] has-checked:shadow-sm has-checked:ring-1 has-checked:ring-primary has-focus-visible:ring-2 has-focus-visible:ring-ring has-focus-visible:ring-offset-2",
				!available &&
					"cursor-not-allowed opacity-50 hover:border-border/70 active:scale-100",
			)}
		>
			<input
				checked={selected}
				className="sr-only"
				disabled={!available}
				name="sellable-item"
				onChange={() => onSelect(item)}
				type="radio"
				value={item.id}
			/>
			<span className="flex items-start justify-between gap-2">
				<span className="font-medium text-sm leading-snug">{label}</span>
				{selected ? (
					<span className="grid size-5 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground motion-safe:animate-in motion-safe:zoom-in-50 motion-safe:duration-200">
						<Check aria-hidden="true" className="size-3 stroke-[3]" />
					</span>
				) : (
					<span
						aria-hidden="true"
						className="size-5 shrink-0 rounded-full border border-border"
					/>
				)}
			</span>
			<span className="whitespace-nowrap font-semibold text-base text-primary tabular-nums">
				{item.id === gptUpgradeProduct.itemId ? (
					m.upgrade_price_by_quote()
				) : (
					<StoreMoney
						amountMinor={price}
						currency={item.currency}
						decimals={item.currencyDecimals}
					/>
				)}
			</span>
			<span className="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
				<span
					className={cn(
						"tabular-nums",
						item.saleDisabled && "text-destructive",
					)}
				>
					{item.saleDisabled
						? m.store_sale_disabled()
						: !available
							? m.store_sold_out()
							: item.availableStock >= 0
								? m.store_stock({ count: item.availableStock })
								: null}
				</span>
				<span
					className={cn(
						"font-medium",
						item.fulfillmentSource === "manual"
							? "text-amber-700 dark:text-amber-300"
							: "text-primary/80",
					)}
				>
					{item.fulfillmentSource === "supplier" ||
					claudeEnvTrafficSkus[item.id]
						? m.store_auto_delivery()
						: item.fulfillmentSource === "manual"
							? m.store_manual_procurement()
							: m.store_local_delivery()}
				</span>
			</span>
		</label>
	);
}

/** The selected plan's coverage rule, right where the choice is made. */
function CoverageHint({
	sellableItem,
}: {
	sellableItem: SellableItem | undefined;
}) {
	const line = policyLines(sellableItem?.policy.coverage)[0];
	if (!line) return null;
	return (
		<p className="mt-3 flex w-fit max-w-full items-start gap-2 rounded-xl bg-muted/40 px-3.5 py-2.5 text-muted-foreground text-sm leading-6">
			<RefreshCw
				aria-hidden="true"
				className="mt-1 size-3.5 shrink-0 text-primary"
			/>
			<span
				key={sellableItem?.id}
				className="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-300"
			>
				{line}
			</span>
		</p>
	);
}

/** Total for the chosen quantity on one payment method, with the applied unit price. */
function OrderTotal({
	channel,
	pricing,
	quantity,
	sellableItem,
}: {
	channel: ChannelPrice | null;
	pricing: ItemPricing | undefined;
	quantity: number;
	sellableItem: SellableItem;
}) {
	if (sellableItem.id === gptUpgradeProduct.itemId)
		return m.upgrade_price_by_quote();
	if (!channel && BigInt(sellableItem.priceMinor) === 0n)
		return m.store_price_free();
	const count = billableQuantity(quantity, sellableItem);
	const unit = unitPriceAt(sellableItem, pricing, count, channel);
	return (
		<StoreMoney
			amountMinor={BigInt(unit.unitPriceMinor) * BigInt(count)}
			currency={sellableItem.currency}
			decimals={sellableItem.currencyDecimals}
		/>
	);
}

/** Typing in the quantity box can leave it empty or out of range for a moment. */
function billableQuantity(quantity: number, sellableItem: SellableItem) {
	return Number.isInteger(quantity) && quantity >= 1
		? quantity
		: sellableItem.minimumQuantity;
}

function BuyBoxPrice({
	channel,
	pricing,
	quantity,
	sellableItem,
}: {
	channel: ChannelPrice | null;
	pricing: ItemPricing | undefined;
	quantity: number;
	sellableItem: SellableItem;
}) {
	const count = billableQuantity(quantity, sellableItem);
	const upgrade = sellableItem.id === gptUpgradeProduct.itemId;
	const unit = unitPriceAt(sellableItem, pricing, count, channel);
	const listUnit = channel?.priceMinor ?? sellableItem.priceMinor;
	const compareUnit =
		unit.source !== "list"
			? listUnit
			: !channel &&
					sellableItem.listPriceMinor != null &&
					BigInt(sellableItem.listPriceMinor) > BigInt(sellableItem.priceMinor)
				? sellableItem.listPriceMinor
				: null;
	return (
		<div aria-live="polite" className="mt-3">
			<div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
				<strong
					className="font-semibold text-4xl text-primary tabular-nums tracking-tight motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-300"
					key={`${sellableItem.id}:${channel?.id ?? "base"}:${count}:${unit.unitPriceMinor}`}
				>
					<OrderTotal
						channel={channel}
						pricing={pricing}
						quantity={count}
						sellableItem={sellableItem}
					/>
				</strong>
				{!upgrade && compareUnit ? (
					<span className="text-muted-foreground text-sm tabular-nums line-through">
						<StoreMoney
							amountMinor={BigInt(compareUnit) * BigInt(count)}
							currency={sellableItem.currency}
							decimals={sellableItem.currencyDecimals}
						/>
					</span>
				) : null}
				{!upgrade ? <PriceSourceBadge source={unit.source} /> : null}
			</div>
			{!upgrade && count > 1 ? (
				<p className="mt-1 text-muted-foreground text-sm tabular-nums">
					{m.store_unit_price()}{" "}
					<StoreMoney
						amountMinor={unit.unitPriceMinor}
						currency={sellableItem.currency}
						decimals={sellableItem.currencyDecimals}
					/>{" "}
					× {count}
				</p>
			) : null}
			{sellableItem.availableStock === 0 ? (
				<p className="mt-1 text-destructive text-sm">{m.store_sold_out()}</p>
			) : null}
		</div>
	);
}

/** Every payment method's real price for this quantity; picking one only changes what the box shows. */
function PaymentPricePicker({
	onSelect,
	pricing,
	quantity,
	selectedChannelId,
	sellableItem,
}: {
	onSelect: (channelId: string) => void;
	pricing: ItemPricing | undefined;
	quantity: number;
	selectedChannelId: string | null;
	sellableItem: SellableItem;
}) {
	return (
		<fieldset className="mt-5">
			<legend className="mb-2 font-medium text-muted-foreground text-xs">
				{m.store_payment_prices_title()}
			</legend>
			<div className="grid grid-cols-[repeat(auto-fit,minmax(7rem,1fr))] gap-1 rounded-xl bg-muted/60 p-1">
				{sellableItem.channelPrices.map((channel) => (
					<label
						className="grid cursor-pointer gap-0.5 rounded-lg px-3 py-2 ring-offset-background transition-[background-color,box-shadow] duration-200 hover:bg-background/60 has-checked:bg-background has-checked:shadow-sm has-checked:ring-1 has-checked:ring-primary/40 has-focus-visible:ring-2 has-focus-visible:ring-ring"
						key={channel.id}
					>
						<input
							checked={channel.id === selectedChannelId}
							className="sr-only"
							name="payment-price"
							onChange={() => onSelect(channel.id)}
							type="radio"
							value={channel.id}
						/>
						<span className="font-semibold text-sm">
							{paymentChannelLabel(channel.name)}
						</span>
						<span className="text-muted-foreground text-xs tabular-nums">
							<OrderTotal
								channel={channel}
								pricing={pricing}
								quantity={quantity}
								sellableItem={sellableItem}
							/>
							{channel.feeBps > 0
								? ` · ${m.store_payment_price_fee_included()}`
								: null}
						</span>
					</label>
				))}
			</div>
		</fieldset>
	);
}

/**
 * One quiet hint instead of a badge on every plan: volume or customer prices
 * exist for this plan, with the full table one tap away.
 */
function PriceStepsHint({
	item,
	pricing,
	quantity,
}: {
	item: SellableItem;
	pricing: ItemPricing | undefined;
	quantity: number;
}) {
	if (!pricing || item.id === gptUpgradeProduct.itemId) return null;
	const steps = [...pricing.volumeSteps, ...pricing.customerSteps].filter(
		(step) => step.minQuantity >= 1 && step.minQuantity <= item.maximumQuantity,
	);
	if (!steps.length) return null;
	return (
		<details className="group/steps mt-4 rounded-xl border border-emerald-500/25 bg-emerald-500/[0.06] px-3.5 py-2.5 text-sm">
			<summary className="flex cursor-pointer list-none items-center justify-between gap-2 font-medium text-emerald-700 dark:text-emerald-300 [&::-webkit-details-marker]:hidden">
				<span className="flex items-center gap-2">
					<BadgePercent aria-hidden="true" className="size-4" />
					{pricing.customerSteps.length > 0
						? m.store_customer_price_hint()
						: m.store_volume_hint()}
				</span>
				<ChevronRight
					aria-hidden="true"
					className="size-4 transition-transform group-open/steps:rotate-90"
				/>
			</summary>
			<VolumePriceTable item={item} pricing={pricing} quantity={quantity} />
		</details>
	);
}

type PurchaseNotice = {
	key: string;
	icon: typeof ShieldCheck;
	tone?: "warn" | "danger";
	content: ReactNode;
};

const noticeLinkClass =
	"font-medium text-foreground underline decoration-primary/40 underline-offset-4 transition-colors hover:text-primary hover:decoration-primary";

/** Every pre-order rule in one calm list instead of stacked coloured boxes. */
function PurchaseNotices({ notices }: { notices: PurchaseNotice[] }) {
	if (!notices.length) return null;
	return (
		<section
			aria-labelledby="purchase-notices-title"
			className="rounded-2xl border border-border/70 bg-card/55 p-5 shadow-sm"
		>
			<h2
				className="flex items-center gap-2 font-semibold text-base"
				id="purchase-notices-title"
			>
				<CircleCheck aria-hidden="true" className="size-4 text-primary" />
				{m.store_notice_title()}
			</h2>
			<ul className="mt-3 grid gap-3">
				{notices.map(({ key, icon: Icon, tone, content }) => (
					<li
						className={cn(
							"flex items-start gap-2.5 text-muted-foreground text-sm leading-6",
							tone === "danger" && "text-destructive",
						)}
						key={key}
					>
						<Icon
							aria-hidden="true"
							className={cn(
								"mt-1 size-4 shrink-0 text-primary",
								tone === "warn" && "text-amber-600 dark:text-amber-400",
								tone === "danger" && "text-destructive",
							)}
						/>
						<span className="min-w-0">{content}</span>
					</li>
				))}
			</ul>
		</section>
	);
}

/** Screenshots and extra images; the cover itself stays as the header icon and SEO image. */
function ProductGallery({
	media,
	name,
}: {
	media: Product["media"];
	name: string;
}) {
	const [selectedId, setSelectedId] = useState<string>();
	const selected = media.find((entry) => entry.id === selectedId) ?? media[0];
	const index = selected ? media.indexOf(selected) : 0;
	if (!selected) return null;
	return (
		<section
			aria-label={m.store_product_gallery()}
			className="grid max-w-3xl gap-3"
		>
			<div className="relative aspect-video overflow-hidden rounded-2xl bg-muted">
				<img
					alt={selected.altText ?? name}
					className="size-full object-contain"
					src={selected.url}
				/>
				{media.length > 1 ? (
					<>
						<Button
							aria-label={m.pro_pagination_previousPage()}
							className="absolute start-3 top-1/2 size-9 -translate-y-1/2 rounded-full bg-background/85 shadow-sm backdrop-blur-sm hover:bg-background"
							onClick={() =>
								setSelectedId(
									media[(index - 1 + media.length) % media.length]?.id,
								)
							}
							size="icon"
							type="button"
							variant="ghost"
						>
							<ChevronLeft />
						</Button>
						<Button
							aria-label={m.pro_pagination_nextPage()}
							className="absolute end-3 top-1/2 size-9 -translate-y-1/2 rounded-full bg-background/85 shadow-sm backdrop-blur-sm hover:bg-background"
							onClick={() =>
								setSelectedId(media[(index + 1) % media.length]?.id)
							}
							size="icon"
							type="button"
							variant="ghost"
						>
							<ChevronRight />
						</Button>
						<span className="absolute end-3 bottom-3 rounded-full bg-background/85 px-2.5 py-1 font-medium text-xs tabular-nums shadow-sm backdrop-blur-sm">
							{index + 1} / {media.length}
						</span>
					</>
				) : null}
			</div>
			{media.length > 1 ? (
				<div className="grid grid-cols-5 gap-2">
					{media.map((entry) => (
						<button
							aria-label={entry.altText ?? name}
							aria-pressed={entry.id === selected.id}
							className="aspect-video overflow-hidden rounded-xl bg-muted opacity-65 ring-offset-background transition enabled:hover:opacity-100 aria-pressed:opacity-100 aria-pressed:ring-2 aria-pressed:ring-primary aria-pressed:ring-offset-2"
							key={entry.id}
							onClick={() => setSelectedId(entry.id)}
							type="button"
						>
							<img
								alt={entry.altText ?? name}
								className="size-full object-cover"
								src={entry.url}
							/>
						</button>
					))}
				</div>
			) : null}
		</section>
	);
}

function UsageGuide({
	isChatGpt,
	sellableItem,
}: {
	isChatGpt: boolean;
	sellableItem: SellableItem;
}) {
	const automatic = sellableItem.fulfillmentSource !== "manual";
	const received = automatic
		? [
				m.store_usage_guide_auto_credential({ sku: sellableItem.name }),
				m.store_usage_guide_auto_redeem_url(),
			]
		: [
				m.store_usage_guide_manual_order_code(),
				m.store_usage_guide_manual_status(),
			];
	const steps = automatic
		? [
				m.store_usage_guide_auto_step_order(),
				m.store_usage_guide_auto_step_copy(),
				m.store_usage_guide_auto_step_open(),
				m.store_usage_guide_auto_step_submit(),
			]
		: [
				m.store_usage_guide_manual_step_order(),
				m.store_usage_guide_manual_step_copy(),
				m.store_usage_guide_manual_step_contact(),
				m.store_usage_guide_manual_step_wait(),
			];
	return (
		<section className="rounded-2xl border border-border/70 bg-card/55 p-5 shadow-sm">
			<div className="flex items-start gap-3">
				<span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
					<BookOpenCheck className="size-5" />
				</span>
				<div className="min-w-0">
					<p className="font-semibold text-primary text-xs uppercase tracking-[0.16em]">
						{m.store_usage_guide_title()}
					</p>
					<h2 className="mt-1 text-balance font-semibold text-lg">
						{sellableItem.name}
					</h2>
				</div>
			</div>
			<p className="mt-4 text-muted-foreground text-sm leading-6">
				{automatic
					? m.store_usage_guide_auto_intro()
					: m.store_usage_guide_manual_intro()}
			</p>
			<GuideSection icon={PackageOpen} title={m.store_usage_guide_receive()}>
				<ul className="grid gap-1.5">
					{received.map((item) => (
						<li className="flex gap-2" key={item}>
							<span className="mt-2 size-1 shrink-0 rounded-full bg-primary" />
							<span>{item}</span>
						</li>
					))}
				</ul>
			</GuideSection>
			{isChatGpt ? (
				<GuideSection icon={ShieldCheck} title={m.store_usage_guide_account()}>
					<p>{m.store_usage_guide_account_description()}</p>
				</GuideSection>
			) : null}
			<GuideSection icon={CircleCheck} title={m.store_usage_guide_steps()}>
				<ol className="grid gap-2">
					{steps.map((step, index) => (
						<li className="flex gap-2.5" key={step}>
							<span className="grid size-5 shrink-0 place-items-center rounded-full bg-primary/10 font-semibold text-[10px] text-primary">
								{index + 1}
							</span>
							<span>{step}</span>
						</li>
					))}
				</ol>
			</GuideSection>
		</section>
	);
}

function GuideSection({
	children,
	icon: Icon,
	title,
}: {
	children: ReactNode;
	icon: typeof PackageOpen;
	title: string;
}) {
	return (
		<div className="mt-5 border-border/70 border-t pt-4">
			<h3 className="flex items-center gap-2 font-medium text-sm">
				<Icon className="size-4 text-primary" />
				{title}
			</h3>
			<div className="mt-2 text-muted-foreground text-sm leading-6">
				{children}
			</div>
		</div>
	);
}

function SkuPolicyPanel({ sellableItem }: { sellableItem: SellableItem }) {
	const delivery =
		sellableItem.fulfillmentSource === "supplier"
			? m.store_auto_delivery()
			: sellableItem.policy.delivery;
	const deliveryTime =
		sellableItem.fulfillmentSource === "supplier"
			? m.store_supplier_delivery_time()
			: sellableItem.policy.deliveryTime;
	// Delivery method and time read as one fact, so they share a row.
	const rows: [typeof PackageCheck, string, string[]][] = [
		[
			PackageCheck,
			m.store_sku_policy_delivery(),
			[delivery, deliveryTime].filter((line): line is string => Boolean(line)),
		],
		[
			RefreshCw,
			m.store_sku_policy_coverage(),
			policyLines(sellableItem.policy.coverage),
		],
		[
			ShieldCheck,
			m.store_sku_policy_warranty(),
			policyLines(sellableItem.policy.warranty),
		],
		[
			TriangleAlert,
			m.store_sku_policy_restrictions(),
			policyLines(sellableItem.policy.restrictions),
		],
	];
	const visible = rows.filter(([, , lines]) => lines.length);
	if (!visible.length) return null;
	return (
		<section className="overflow-hidden rounded-2xl border border-border/70 bg-muted/20">
			<h2 className="border-border/70 border-b px-4 py-3 font-medium text-sm sm:px-5">
				{m.store_sku_policy_title()}
			</h2>
			<dl className="divide-y divide-border/60">
				{visible.map(([Icon, label, lines]) => (
					<div
						className="grid gap-1.5 px-4 py-3.5 sm:grid-cols-[7rem_1fr] sm:gap-4 sm:px-5"
						key={label}
					>
						<dt className="flex items-center gap-2 self-start font-medium text-foreground text-sm leading-6">
							<Icon
								aria-hidden="true"
								className="size-4 shrink-0 text-primary"
							/>
							{label}
						</dt>
						<dd className="text-muted-foreground text-sm leading-6">
							{lines.length === 1 ? (
								<p>{lines[0]}</p>
							) : (
								<ul className="grid gap-1">
									{lines.map((line, index) => (
										<li className="flex gap-2" key={line}>
											<span className="mt-[0.6875rem] size-1 shrink-0 rounded-full bg-primary/70" />
											<span className={cn(index === 0 && "text-foreground")}>
												{line}
											</span>
										</li>
									))}
								</ul>
							)}
						</dd>
					</div>
				))}
			</dl>
		</section>
	);
}

/** Policy text is written as one run of clauses; show each clause on its own line. */
function policyLines(text: string | null | undefined) {
	return (text ?? "")
		.split(/(?<=[。；;])/)
		.map((line) => line.trim().replace(/[；;]$/, ""))
		.filter(Boolean);
}

export function ProductLoadingSkeleton() {
	return (
		<section
			aria-busy="true"
			aria-label={m.common_loading()}
			className="container px-4 py-6 sm:py-8"
			data-skeleton-layout="product-detail"
		>
			<Skeleton className="mb-5 h-5 w-32" />
			<div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-x-10 xl:grid-cols-[minmax(0,1fr)_24rem] xl:gap-x-14">
				<div className="min-w-0" data-skeleton-region="product-header">
					<div className="flex items-start gap-4">
						<Skeleton className="size-16 shrink-0 rounded-2xl sm:size-[4.5rem]" />
						<div className="grid flex-1 gap-2">
							<Skeleton className="h-4 w-20" />
							<Skeleton className="h-8 w-2/3" />
							<Skeleton className="h-4 w-32" />
						</div>
					</div>
					<div className="mt-4 flex gap-2">
						<Skeleton className="h-6 w-20 rounded-full" />
						<Skeleton className="h-6 w-20 rounded-full" />
						<Skeleton className="h-6 w-20 rounded-full" />
					</div>
					<Skeleton className="mt-7 mb-3 h-5 w-28" />
					<div
						className="grid grid-cols-[repeat(auto-fill,minmax(12rem,1fr))] gap-2.5"
						data-skeleton-region="product-plans"
					>
						<Skeleton className="h-24 rounded-xl" />
						<Skeleton className="h-24 rounded-xl" />
					</div>
				</div>
				<div
					className="min-w-0 self-start rounded-2xl border border-border/70 p-5 sm:p-6 lg:sticky lg:top-24"
					data-skeleton-region="product-purchase"
				>
					<Skeleton className="h-4 w-3/4" />
					<Skeleton className="mt-4 h-10 w-40" />
					<Skeleton className="mt-5 h-14 rounded-xl" />
					<div className="mt-5 grid gap-2.5">
						<Skeleton className="h-12 rounded-xl" />
						<Skeleton className="h-11 rounded-xl" />
					</div>
				</div>
			</div>
		</section>
	);
}
function RelatedProductsLoadingSkeleton() {
	return (
		<section
			aria-busy="true"
			aria-label={m.common_loading()}
			className="mt-20 sm:mt-28"
		>
			<div className="mb-6 flex items-end justify-between gap-5">
				<div className="grid gap-2">
					<Skeleton className="h-8 w-44" />
					<Skeleton className="h-4 w-72 max-w-full" />
				</div>
				<Skeleton className="h-5 w-20" />
			</div>
			<div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
				{["related-1", "related-2", "related-3"].map((key) => (
					<StorefrontProductCardSkeleton key={key} />
				))}
			</div>
		</section>
	);
}
function purchaseLimitSummary(sellableItem: SellableItem) {
	const orderLimit =
		sellableItem.minimumQuantity === sellableItem.maximumQuantity
			? sellableItem.minimumQuantity === 1
				? null
				: m.store_purchase_exact_quantity({
						quantity: sellableItem.minimumQuantity,
					})
			: sellableItem.minimumQuantity === 1
				? m.store_purchase_maximum_quantity({
						maximum: sellableItem.maximumQuantity,
					})
				: m.store_purchase_quantity_range({
						minimum: sellableItem.minimumQuantity,
						maximum: sellableItem.maximumQuantity,
					});
	const customerLimit =
		sellableItem.maximumPerCustomer == null
			? null
			: m.store_purchase_customer_limit({
					maximum: sellableItem.maximumPerCustomer,
				});
	return [orderLimit, customerLimit].filter(Boolean).join(" · ") || null;
}

/** Lowest purchasable price and stock state, readable before any interaction. */
function ProductPriceLine({ product }: { product: Product }) {
	const currency = useCurrency();
	const summary = productPriceSummary(product);
	if (!summary) return null;
	const price = currency.format(
		summary.lowMinor,
		summary.currency,
		summary.decimals,
	);
	return (
		<p className="mt-2 flex flex-wrap items-baseline gap-x-2 text-muted-foreground text-sm">
			<span className="font-semibold text-base text-foreground tabular-nums">
				{summary.lowMinor === summary.highMinor
					? price
					: m.store_card_from({ price })}
			</span>
			<span aria-hidden="true">·</span>
			<span>
				{summary.inStock ? m.seo_product_stock_in() : m.seo_product_stock_out()}
			</span>
		</p>
	);
}

function isAvailable(sellableItem: SellableItem) {
	return (
		sellableItem.availableStock < 0 ||
		sellableItem.availableStock >= sellableItem.minimumQuantity
	);
}
function deliveryPromise(sellableItem: SellableItem) {
	if (
		sellableItem.deliveryType === "stock" &&
		sellableItem.fulfillmentSource === "manual"
	)
		return sellableItem.policy.deliveryTime;
	switch (sellableItem.deliveryType) {
		case "stock":
			return m.store_delivery_promise_card();
		case "download":
			return m.store_delivery_promise_download();
		case "automation":
			return m.store_delivery_promise_build();
		default:
			return null;
	}
}
function entitlementSummary(sellableItem: SellableItem) {
	return [
		sellableItem.durationMs == null
			? null
			: m.store_entitlement_duration({
					days: Math.ceil(sellableItem.durationMs / 86_400_000),
				}),
		...(sellableItem.deliveryType === "automation"
			? [
					sellableItem.usageLimit == null
						? null
						: m.store_entitlement_automation_runs({
								count: sellableItem.usageLimit,
							}),
				]
			: []),
		...(sellableItem.deliveryType === "download"
			? [
					sellableItem.accessLimit == null
						? null
						: m.store_entitlement_downloads({
								count: sellableItem.accessLimit,
							}),
				]
			: []),
	]
		.filter(Boolean)
		.join(" · ");
}

/**
 * Names follow "Plan｜Channel｜Term" (e.g. "ChatGPT Plus｜菲区｜1个月"). Group the
 * channels of one plan into a row when that actually merges something; otherwise
 * the flat grid reads better.
 */
export function groupPlans(items: SellableItem[]) {
	const parsed = items.map((item) => {
		const parts = item.name.split("｜").map((part) => part.trim());
		const variant = parts
			.slice(1)
			.filter((part) => !/^\d+\s*(?:个?月|months?)$/i.test(part));
		return {
			item,
			plan: parts[0] ?? item.name,
			label: variant.join("｜") || parts[1] || parts[0],
		};
	});
	const groups: { label: string; options: typeof parsed }[] = [];
	for (const entry of parsed) {
		const group = groups.find((candidate) => candidate.label === entry.plan);
		if (group) group.options.push(entry);
		else groups.push({ label: entry.plan, options: [entry] });
	}
	if (groups.length === items.length) return null;
	// Drop the brand word every row repeats ("ChatGPT Plus" → "Plus").
	const brand = groups[0]?.label.split(" ")[0];
	if (brand && groups.every((group) => group.label.startsWith(`${brand} `)))
		for (const group of groups)
			group.label = group.label.slice(brand.length + 1);
	return groups;
}
