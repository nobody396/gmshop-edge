"use client";

import { Link } from "@tanstack/react-router";
import { Activity } from "lucide-react";
import { useSiteBrand } from "#/context/site-brand-provider";
import { AppTitle } from "#/layouts/components/app-title";
import { m } from "#/paraglide/messages";

export function PublicFooter() {
	const brand = useSiteBrand();
	return (
		<footer className="mt-12 w-full pt-5 pb-[calc(1.25rem+var(--safe-bottom))]">
			<div className="container flex flex-col gap-4 px-4 sm:flex-row sm:items-center">
				<Link className="inline-flex shrink-0" to="/">
					<AppTitle />
				</Link>
				<div className="flex w-full items-center justify-between gap-4 text-muted-foreground text-xs sm:ms-auto sm:w-auto sm:justify-end">
					<p className="min-w-0 truncate">
						{m.public_footer_copyright({
							year: new Date().getFullYear(),
							name: brand.name,
						})}
					</p>
					<Link
						className="shrink-0 transition-colors hover:text-foreground"
						to="/guides"
					>
						{m.public_footer_guides()}
					</Link>
					<Link
						aria-label={m.public_footer_ready()}
						className="inline-flex shrink-0 items-center gap-1.5 text-primary transition-opacity hover:opacity-70"
						to="/status"
					>
						<Activity className="size-3.5" />
						<span>{m.public_footer_ready()}</span>
					</Link>
				</div>
			</div>
		</footer>
	);
}
