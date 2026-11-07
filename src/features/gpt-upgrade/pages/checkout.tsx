"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { authClient } from "#/features/auth/auth-client";
import { isInternalIdentityEmail } from "#/features/auth/identity-email";
import { PaymentChannelOption } from "#/features/storefront/components/payment-channel-option";
import { writeGuestOrderEmail } from "#/features/storefront/order-access-storage";
import { safeStorePaymentUrl } from "#/features/storefront/payment-url";
import {
	checkoutStoreOrderFn,
	listCheckoutPaymentChannelsFn,
} from "#/features/storefront/server/functions";
import { formatMinorAmountWithSymbol } from "#/lib/format";
import { m } from "#/paraglide/messages";
import { getLocale } from "#/paraglide/runtime";
import { gptUpgradeProduct } from "../products";
import { upgradeQuoteTokenSchema } from "../schema";
import { getUpgradeQuoteFn } from "../server/functions";

export function UpgradeCheckoutPage() {
	const { quote: quoteToken } = useSearch({
		from: "/(public)/upgrade/checkout",
	});
	const navigate = useNavigate();
	const locale = getLocale();
	const session = authClient.useSession();
	const accountEmail = session.data?.user.email;
	const publicEmail =
		accountEmail && !isInternalIdentityEmail(accountEmail) ? accountEmail : "";
	const [email, setEmail] = useState("");
	const [selected, setSelected] = useState("");
	const [now, setNow] = useState(Date.now());
	const keys = useRef(new Map<string, string>());
	const validToken = upgradeQuoteTokenSchema.safeParse(quoteToken).success;
	const quote = useQuery({
		queryKey: ["gpt-upgrade", quoteToken],
		queryFn: () => getUpgradeQuoteFn({ data: { quote: quoteToken } }),
		enabled: validToken,
		retry: false,
		gcTime: 0,
	});
	const data = quote.data;
	const expired =
		!validToken ||
		(quote.isSuccess &&
			(!data || data.state !== "open" || data.expires_at <= now));
	const channels = useQuery({
		queryKey: ["upgrade-payment-channels"],
		queryFn: () => listCheckoutPaymentChannelsFn(),
		enabled: Boolean(data && !expired),
	});
	const channelId = selected || channels.data?.[0]?.id || "";
	const contact = publicEmail || email;
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1_000);
		return () => clearInterval(timer);
	}, []);
	const checkout = useMutation({
		mutationFn: checkoutStoreOrderFn,
		onSuccess: ({ accountOrder, order, payment }) => {
			if (!accountOrder) writeGuestOrderEmail(order.orderNumber, contact);
			const hosted =
				channels.data?.find((channel) => channel.id === channelId)?.provider ===
				"gmpay"
					? safeStorePaymentUrl(payment?.checkoutUrl ?? null)
					: null;
			if (hosted) window.location.assign(hosted);
			else
				void navigate(
					accountOrder
						? {
								to: "/account/orders/$orderNumber",
								params: { orderNumber: order.orderNumber },
								search: {},
							}
						: {
								to: "/orders/$orderNumber",
								params: { orderNumber: order.orderNumber },
							},
				);
		},
	});
	if (expired)
		return (
			<div className="container grid min-h-[60vh] place-content-center gap-5 px-4 py-12 text-center">
				<h1 className="font-semibold text-2xl">{m.upgrade_quote_expired()}</h1>
				<Button asChild>
					<a href={gptUpgradeProduct.quoteUrl} rel="noreferrer">
						{m.upgrade_get_quote()}
					</a>
				</Button>
			</div>
		);
	if (quote.isError)
		return (
			<div
				className="container grid min-h-[60vh] place-content-center gap-4 px-4 text-center"
				role="alert"
			>
				<p>{m.common_operation_failed()}</p>
				<Button onClick={() => void quote.refetch()}>{m.common_retry()}</Button>
			</div>
		);
	if (!data)
		return (
			<output className="container block py-16">{m.common_loading()}</output>
		);
	const remaining = Math.max(0, Math.ceil((data.expires_at - now) / 1_000));
	const countdown = [Math.floor(remaining / 60), remaining % 60]
		.map((n) =>
			new Intl.NumberFormat(locale, {
				minimumIntegerDigits: 2,
				useGrouping: false,
			}).format(n),
		)
		.join(":");
	const price = formatMinorAmountWithSymbol(
		data.price_minor,
		data.currency,
		data.currency_decimals,
		locale,
	);
	return (
		<div className="container max-w-5xl px-4 py-8 sm:py-12">
			<h1 className="mb-6 font-semibold text-3xl tracking-tight">
				{m.upgrade_checkout_title()}
			</h1>
			<form
				className="grid overflow-hidden rounded-3xl border lg:grid-cols-[1fr_24rem]"
				onSubmit={(event) => {
					event.preventDefault();
					if (expired || checkout.isPending || !channelId) return;
					const scope = `${quoteToken}:${channelId}:${session.data?.user.id ?? contact}`;
					let key = keys.current.get(scope);
					if (!key) {
						key = crypto.randomUUID();
						keys.current.set(scope, key);
					}
					checkout.mutate({
						data: {
							upgradeQuoteToken: quoteToken,
							items: [
								{
									sellableItemId: gptUpgradeProduct.itemId,
									quantity: 1,
									inputValues: {},
									renewedFromEntitlementId: null,
								},
							],
							email: contact || null,
							idempotencyKey: key,
							locale,
							paymentChannelId: channelId,
							paymentCurrency: "CNY",
							termsAccepted: true,
							couponCode: "",
							customerNote: "",
							commerceSessionId: null,
							walletPayment: false,
							useBalance: false,
						},
					});
				}}
			>
				<section className="grid content-start gap-6 p-5 sm:p-8 lg:p-10">
					<h2 className="font-semibold text-xl">{data.target_label}</h2>
					<dl className="grid gap-4 text-sm">
						<div className="flex flex-wrap justify-between gap-2">
							<dt className="text-muted-foreground">{m.upgrade_account()}</dt>
							<dd className="break-all">{data.account_hint}</dd>
						</div>
						<div className="flex flex-wrap justify-between gap-2">
							<dt className="text-muted-foreground">{m.upgrade_source()}</dt>
							<dd>{data.source_label}</dd>
						</div>
						<div className="flex flex-wrap justify-between gap-2">
							<dt className="text-muted-foreground">
								{m.upgrade_remaining_days()}
							</dt>
							<dd>
								{new Intl.NumberFormat(locale).format(data.remaining_days)}
							</dd>
						</div>
					</dl>
					<p className="text-muted-foreground text-sm">
						{m.upgrade_instructions()}
					</p>
					<div className="grid gap-2 border-t pt-6">
						<Label htmlFor="upgrade-email">{m.store_contact_email()}</Label>
						<Input
							id="upgrade-email"
							type="email"
							autoComplete="email"
							required={!session.data?.user}
							readOnly={Boolean(publicEmail)}
							value={contact}
							onChange={(event) => setEmail(event.target.value)}
						/>
					</div>
				</section>
				<aside className="grid content-start gap-6 border-t bg-muted/35 p-5 sm:p-8 lg:border-t-0 lg:border-l lg:p-10">
					<div>
						<p className="text-muted-foreground text-sm">
							{m.store_order_total()} · CNY
						</p>
						<strong className="mt-2 block text-4xl text-primary tracking-tight">
							{price}
						</strong>
					</div>
					<p className="text-muted-foreground text-sm">
						{m.upgrade_expires_in({ time: countdown })}
					</p>
					<fieldset
						disabled={checkout.isPending || channels.isPending}
						className="grid grid-cols-2 gap-3"
					>
						<legend className="mb-4 text-muted-foreground text-sm">
							{m.store_payment_method()}
						</legend>
						{channels.data?.map((channel) => (
							<PaymentChannelOption
								key={channel.id}
								channel={channel}
								selected={channelId}
								onSelect={setSelected}
							>
								<span className="text-primary text-xs">{price}</span>
							</PaymentChannelOption>
						))}
					</fieldset>
					{channels.isPending ? (
						<output>{m.common_loading()}</output>
					) : !channels.data?.length || channels.isError ? (
						<p role="alert">{m.store_checkout_payment_unavailable()}</p>
					) : null}
					{checkout.isError ? (
						<p role="alert" className="text-destructive text-sm">
							{m.store_checkout_failed()}{" "}
							<a
								className="underline"
								href={gptUpgradeProduct.quoteUrl}
								rel="noreferrer"
							>
								{m.upgrade_get_quote()}
							</a>
						</p>
					) : null}
					<Button
						className="h-12 rounded-xl"
						disabled={
							checkout.isPending ||
							session.isPending ||
							!channelId ||
							channels.isError
						}
					>
						{checkout.isPending ? m.common_loading() : m.store_buy_now()}
					</Button>
				</aside>
			</form>
		</div>
	);
}
