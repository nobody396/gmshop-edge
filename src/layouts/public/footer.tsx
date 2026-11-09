"use client";

import { Link } from "@tanstack/react-router";
import { Activity } from "lucide-react";
import type { ReactNode } from "react";
import { useSiteBrand } from "#/context/site-brand-provider";
import { webSupportOpenEvent } from "#/features/telegram/web-support-contract";
import { AppTitle } from "#/layouts/components/app-title";
import { redeemSiteUrl } from "#/layouts/public/header";
import { m } from "#/paraglide/messages";

const telegramGroupUrl = "https://t.me/laoshirengroup";
const telegramSupportUrl = "https://t.me/laoshirenai_support_bot";

const linkClassName =
	"text-muted-foreground text-sm transition-colors hover:text-foreground";

export function PublicFooter() {
	const brand = useSiteBrand();
	return (
		<footer className="mt-16 w-full border-border/60 border-t pb-[calc(1.25rem+var(--safe-bottom))]">
			<div className="container grid grid-cols-3 gap-x-4 gap-y-8 px-4 pt-10 pb-8 md:grid-cols-[minmax(0,1.4fr)_repeat(3,minmax(0,1fr))] md:gap-10">
				<div className="col-span-3 max-w-xs md:col-span-1">
					<Link className="inline-flex" to="/">
						<AppTitle />
					</Link>
					<p className="mt-3 text-muted-foreground text-sm leading-6">
						{m.public_footer_tagline()}
					</p>
				</div>
				<FooterColumn title={m.public_footer_shop()}>
					<Link className={linkClassName} to="/">
						{m.public_footer_all_products()}
					</Link>
					<a className={linkClassName} href={redeemSiteUrl}>
						{m.store_nav_redeem()}
					</a>
					<Link className={linkClassName} to="/cart">
						{m.store_cart_title()}
					</Link>
					<Link className={linkClassName} to="/orders">
						{m.store_nav_orders()}
					</Link>
				</FooterColumn>
				<FooterColumn title={m.public_footer_help()}>
					<Link className={linkClassName} to="/guides">
						{m.public_footer_guides()}
					</Link>
					<Link className={linkClassName} to="/invoice">
						{m.store_nav_invoice()}
					</Link>
					<Link className={linkClassName} to="/status">
						{m.public_footer_status()}
					</Link>
				</FooterColumn>
				<FooterColumn title={m.public_footer_contact()}>
					<button
						className={`${linkClassName} text-start`}
						onClick={() => window.dispatchEvent(new Event(webSupportOpenEvent))}
						type="button"
					>
						{m.public_footer_online_support()}
					</button>
					<a
						className={linkClassName}
						href={telegramGroupUrl}
						rel="noreferrer"
						target="_blank"
					>
						{m.public_footer_telegram_group()}
					</a>
					<a
						className={linkClassName}
						href={telegramSupportUrl}
						rel="noreferrer"
						target="_blank"
					>
						{m.public_footer_telegram_support()}
					</a>
				</FooterColumn>
			</div>
			<div className="container flex flex-wrap items-center gap-3 px-4 text-muted-foreground text-xs">
				<p>
					{m.public_footer_copyright({
						year: new Date().getFullYear(),
						name: brand.name,
					})}
				</p>
				<Link
					aria-label={m.public_footer_ready()}
					className="inline-flex w-fit items-center gap-1.5 rounded-full border border-primary/25 bg-primary/[0.07] px-2.5 py-1 text-primary transition-opacity hover:opacity-80"
					to="/status"
				>
					<Activity className="size-3.5" />
					<span>{m.public_footer_ready()}</span>
				</Link>
			</div>
		</footer>
	);
}

function FooterColumn({
	title,
	children,
}: {
	title: string;
	children: ReactNode;
}) {
	return (
		<nav aria-label={title} className="flex flex-col items-start gap-2.5">
			<h2 className="mb-1 font-medium text-foreground text-sm">{title}</h2>
			{children}
		</nav>
	);
}
