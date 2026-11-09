"use client";

import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, PackageSearch, Search, ShieldCheck } from "lucide-react";
import { type SyntheticEvent, useState } from "react";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { authClient } from "#/features/auth/auth-client";
import { writeGuestOrderEmail } from "#/features/storefront/order-access-storage";
import { storeOrderLookupSchema } from "#/features/storefront/schema";
import { cn } from "#/lib/utils";
import { m } from "#/paraglide/messages";

export function OrderLookupPage() {
	const navigate = useNavigate();
	const session = authClient.useSession();
	const signedIn = Boolean(session.data?.user);
	const [orderNumber, setOrderNumber] = useState("");
	const [email, setEmail] = useState("");
	const access = storeOrderLookupSchema.safeParse({ orderNumber, email });
	const canSubmit = access.success;
	function submit(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
		event.preventDefault();
		if (!access.success) return;
		writeGuestOrderEmail(access.data.orderNumber, access.data.email);
		void navigate({
			to: "/orders/$orderNumber",
			params: { orderNumber: access.data.orderNumber },
		});
	}
	return (
		<div className="container flex justify-center px-4 py-8 sm:py-14">
			<div className="grid w-full max-w-md gap-4">
				<form
					className="grid gap-5 rounded-3xl border bg-card p-6 shadow-sm sm:p-8"
					onSubmit={submit}
				>
					<div>
						<span className="grid size-10 place-items-center rounded-xl bg-primary/10 text-primary">
							<PackageSearch className="size-5" />
						</span>
						{signedIn ? (
							<p className="mt-4 font-medium text-primary text-sm">
								{m.store_lookup_other_guest_order()}
							</p>
						) : null}
						<h1
							className={cn(
								"text-balance font-semibold text-2xl tracking-[-0.03em] sm:text-3xl",
								signedIn ? "mt-1" : "mt-4",
							)}
						>
							{m.store_lookup_title()}
						</h1>
						<p className="mt-2 text-pretty text-muted-foreground text-sm leading-6">
							{m.store_lookup_description()}
						</p>
					</div>
					<div className="grid gap-2">
						<Label htmlFor="order-number">{m.store_order_number()}</Label>
						<Input
							autoComplete="off"
							id="order-number"
							maxLength={80}
							minLength={8}
							placeholder="GM-…"
							required
							value={orderNumber}
							onChange={(event) => setOrderNumber(event.target.value)}
						/>
					</div>
					<div className="grid gap-2">
						<Label htmlFor="order-email">{m.store_contact_email()}</Label>
						<Input
							autoComplete="email"
							id="order-email"
							maxLength={320}
							placeholder="name@example.com"
							required
							type="email"
							value={email}
							onChange={(event) => setEmail(event.target.value)}
						/>
					</div>
					<Button className="h-11" disabled={!canSubmit} type="submit">
						<Search />
						{m.store_find_order()}
					</Button>
					<div className="flex items-start gap-2 text-muted-foreground text-xs leading-5">
						<ShieldCheck className="mt-0.5 size-4 shrink-0" />
						<span>{m.store_lookup_security_notice()}</span>
					</div>
				</form>
				{signedIn ? (
					<div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-primary/8 p-4">
						<div className="min-w-0 flex-1">
							<p className="font-medium text-sm">
								{m.store_lookup_signed_in_title()}
							</p>
							<p className="mt-0.5 text-muted-foreground text-xs leading-5">
								{m.store_lookup_signed_in_description()}
							</p>
						</div>
						<Button asChild size="sm">
							<Link to="/account/orders">
								{m.store_lookup_signed_in_action()}
								<ArrowRight />
							</Link>
						</Button>
					</div>
				) : null}
			</div>
		</div>
	);
}
