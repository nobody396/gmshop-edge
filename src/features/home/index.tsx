"use client";

import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Boxes, Search } from "lucide-react";
import { type SyntheticEvent, useEffect, useState } from "react";
import type { z } from "zod";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "#/components/ui/select";
import { trackCommerceEvent } from "#/features/storefront/commerce-events";
import {
	StorefrontProductCard,
	StorefrontProductCardSkeleton,
} from "#/features/storefront/components/product-card";
import type { storefrontListSchema } from "#/features/storefront/schema";
import { usePublicHeaderHeight } from "#/features/storefront/sticky-top";
import { m } from "#/paraglide/messages";
import { getLocale } from "#/paraglide/runtime";
import { storefrontCatalogQueryOptions } from "./catalog-query";
import { SelfServiceRecharge } from "./self-service-recharge";

export function HomePage({
	searchParams,
}: {
	searchParams: z.infer<typeof storefrontListSchema>;
}) {
	const navigate = useNavigate({ from: "/" });
	const [draftSearch, setDraftSearch] = useState(searchParams.search);
	const locale = getLocale();
	const catalog = useQuery(
		storefrontCatalogQueryOptions({ ...searchParams, locale }),
	);
	useEffect(() => {
		trackCommerceEvent({ eventType: "catalog_viewed" });
	}, []);
	function submit(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
		event.preventDefault();
		void navigate({
			search: { ...searchParams, search: draftSearch.trim() },
		});
	}
	function clearFilters() {
		setDraftSearch("");
		void navigate({
			search: {
				search: "",
				tag: "",
				sort: searchParams.sort,
			},
		});
	}
	const hasFilters = Boolean(searchParams.search || searchParams.tag);
	const headerHeight = usePublicHeaderHeight();
	return (
		<div className="min-h-[70vh]">
			<section className="container px-4 pt-5 sm:pt-7">
				<div className="flex flex-wrap items-center gap-x-8 gap-y-4">
					<div className="min-w-0 flex-[1_1_26rem]">
						<h1 className="text-balance font-bold text-2xl leading-tight tracking-tight sm:text-[2rem]">
							{m.store_home_title()}
						</h1>
						<p className="mt-1.5 text-muted-foreground text-sm">
							{m.store_home_subtitle()}
						</p>
					</div>
					<form
						className="relative w-full min-w-0 flex-[1_1_22rem] lg:max-w-[32.5rem]"
						onSubmit={submit}
					>
						<Search className="pointer-events-none absolute start-4 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
						<Input
							aria-label={m.store_search_placeholder()}
							className="h-11 rounded-xl bg-muted/45 ps-10 pe-24 text-base shadow-none sm:h-12"
							value={draftSearch}
							onChange={(event) => setDraftSearch(event.target.value)}
							placeholder={m.store_search_placeholder()}
						/>
						<Button
							className="absolute end-1 top-1 h-9 rounded-lg px-4 sm:h-10"
							type="submit"
						>
							{m.common_search()}
						</Button>
					</form>
				</div>
				{hasFilters ? null : <SelfServiceRecharge />}
			</section>
			<div
				className="sticky z-30 mt-3 bg-background/95 backdrop-blur-xl"
				data-home-category-bar
				style={{ top: headerHeight }}
			>
				<div className="container flex items-center gap-3 px-4 py-2">
					<div className="flex min-w-0 flex-1 gap-1.5 overflow-x-auto sm:flex-wrap sm:overflow-visible">
						<Button
							className="shrink-0 rounded-full"
							size="sm"
							variant={searchParams.tag ? "outline" : "default"}
							onClick={() =>
								void navigate({ search: { ...searchParams, tag: "" } })
							}
						>
							{m.store_all_tags()}
						</Button>
						{catalog.data?.tags.map((item) => (
							<Button
								className="shrink-0 rounded-full"
								key={item.name}
								size="sm"
								variant={searchParams.tag === item.name ? "default" : "outline"}
								onClick={() =>
									void navigate({
										search: { ...searchParams, tag: item.name },
									})
								}
							>
								{item.name}
							</Button>
						))}
					</div>
					<Select
						onValueChange={(sort) =>
							void navigate({
								search: {
									...searchParams,
									sort: sort as typeof searchParams.sort,
								},
							})
						}
						value={searchParams.sort}
					>
						<SelectTrigger
							aria-label={m.store_sort_label()}
							className="shrink-0 self-start"
							size="sm"
						>
							<SelectValue />
						</SelectTrigger>
						<SelectContent align="end">
							<SelectItem value="featured">
								{m.store_sort_featured()}
							</SelectItem>
							<SelectItem value="newest">{m.store_sort_newest()}</SelectItem>
							<SelectItem value="price_asc">
								{m.store_sort_price_asc()}
							</SelectItem>
							<SelectItem value="price_desc">
								{m.store_sort_price_desc()}
							</SelectItem>
							<SelectItem value="popular">{m.store_sort_popular()}</SelectItem>
						</SelectContent>
					</Select>
				</div>
			</div>
			<section className="container px-4 pt-3 pb-12">
				{hasFilters ? (
					<div className="mb-4 flex items-center justify-between gap-4">
						<div>
							<h2 className="font-semibold text-lg">
								{m.store_catalog_results()}
							</h2>
							{catalog.data ? (
								<p className="text-muted-foreground text-sm">
									{m.store_catalog_count({
										count: catalog.data.products.length,
									})}
								</p>
							) : null}
						</div>
						<Button
							className="rounded-full"
							onClick={clearFilters}
							size="sm"
							variant="ghost"
						>
							{m.store_clear_filters()}
						</Button>
					</div>
				) : (
					<h2 className="sr-only">{m.store_catalog_featured()}</h2>
				)}
				{catalog.isLoading ? (
					<ProductGridSkeleton />
				) : catalog.data?.products.length ? (
					<div className={productGridClassName}>
						{catalog.data.products.map((product) => (
							<StorefrontProductCard key={product.id} product={product} />
						))}
					</div>
				) : (
					<div className="grid min-h-72 place-items-center rounded-3xl bg-muted/30 text-center">
						<div>
							<Boxes className="mx-auto size-10 text-muted-foreground" />
							<h2 className="mt-4 font-semibold text-xl">
								{hasFilters
									? m.store_empty_title()
									: m.store_no_products_title()}
							</h2>
							<p className="mt-2 text-muted-foreground text-sm">
								{hasFilters
									? m.store_empty_description()
									: m.store_no_products_description()}
							</p>
							{hasFilters ? (
								<Button
									className="mt-5 rounded-full"
									onClick={clearFilters}
									size="sm"
								>
									{m.store_clear_filters()}
								</Button>
							) : null}
						</div>
					</div>
				)}
				<p className="mt-8 flex flex-wrap gap-x-2 gap-y-1 border-border/60 border-t pt-4 text-muted-foreground text-xs sm:text-sm">
					<span>{m.store_home_footer_warranty()}</span>
					<span aria-hidden="true">·</span>
					<span>{m.store_home_footer_support()}</span>
				</p>
			</section>
		</div>
	);
}

/** Phones: one card per row. Wider: as many ~268px cards as fit (about four at 1240px). */
const productGridClassName =
	"grid gap-2.5 sm:grid-cols-[repeat(auto-fill,minmax(13.5rem,1fr))] sm:gap-3";

export function ProductGridSkeleton() {
	return (
		<output
			aria-busy="true"
			aria-label={m.common_loading()}
			className={productGridClassName}
			data-skeleton-layout="product-grid"
		>
			{["a", "b", "c", "d", "e", "f", "g", "h"].map((key) => (
				<StorefrontProductCardSkeleton key={key} />
			))}
		</output>
	);
}
