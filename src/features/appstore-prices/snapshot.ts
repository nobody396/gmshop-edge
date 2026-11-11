import { z } from "zod";
import {
	type AppStoreCurrency,
	type AppStorePeriod,
	type AppStoreRegionId,
	type AppStoreTierConfig,
	appStorePriceApps,
	appStoreRegionIds,
	appStoreRegions,
} from "./config";

/**
 * Pure snapshot logic for the App Store price comparison: the scraper posts
 * raw listings, this turns them into one stored snapshot and keeps the last
 * good value of any cell whose source failed today. Client-safe.
 */

export type AppStorePriceSource = "apple" | "opentherank";

export type AppStorePriceCell = {
	/** Decimal string in the local currency, e.g. "5299.99". */
	amount: string;
	currency: AppStoreCurrency;
	/** Rounded whole yuan at the snapshot's rates. */
	cny: number;
	source: AppStorePriceSource;
	/** When this price was read from its source (ms). */
	fetchedAt: number;
};

export type AppStorePriceSnapshot = {
	version: 1;
	/** Last successful ingest (ms). */
	updatedAt: number;
	rates: {
		/** ECB reference date from Frankfurter. */
		date: string;
		/** Yuan per one unit of each currency. */
		cnyPer: Record<AppStoreCurrency, number>;
		fetchedAt: number;
	};
	apps: {
		id: string;
		tiers: {
			id: string;
			period: AppStorePeriod;
			cells: Record<AppStoreRegionId, AppStorePriceCell | null>;
		}[];
	}[];
};

const regionSchema = z.enum(appStoreRegionIds as [string, ...string[]]);
const appIdSchema = z.enum(["chatgpt", "claude", "gemini"]);

export const appStoreIngestSchema = z.object({
	fetchedAt: z.number().int().positive(),
	/** Frankfurter response with base=CNY, or null when it failed. */
	rates: z
		.object({
			base: z.literal("CNY"),
			date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
			rates: z.record(z.string(), z.number().positive()),
		})
		.nullable(),
	apple: z
		.array(
			z.object({
				app: appIdSchema,
				region: regionSchema,
				/** False when the page could not be read; its cells keep old values. */
				ok: z.boolean(),
				items: z
					.array(
						z.object({
							name: z.string().min(1).max(200),
							price: z.string().min(1).max(60),
						}),
					)
					.max(60)
					.default([]),
			}),
		)
		.max(40),
	opentherank: z
		.array(
			z.object({
				app: appIdSchema,
				ok: z.boolean(),
				/** region → plan id → local price text. */
				regions: z
					.record(z.string(), z.record(z.string(), z.string().max(60)))
					.default({}),
			}),
		)
		.max(10),
});

export type AppStoreIngest = z.infer<typeof appStoreIngestSchema>;

/**
 * "₺5.299,99" → "5299.99", "¥3,000" → "3000", "≈ ₱6490/mo" → "6490".
 * A last separator followed by exactly two digits is the decimal point;
 * every other separator groups thousands. Null for anything unreadable.
 */
export function parseLocalAmount(text: string): string | null {
	const match = /\d[\d.,\s  ]*/.exec(text);
	if (!match) return null;
	const raw = match[0].replace(/[\s  ]/g, "").replace(/[.,]$/, "");
	const last = Math.max(raw.lastIndexOf("."), raw.lastIndexOf(","));
	let integer = raw;
	let fraction = "";
	if (last >= 0 && /^\d{1,2}$/.test(raw.slice(last + 1))) {
		integer = raw.slice(0, last);
		fraction = raw.slice(last + 1);
	}
	integer = integer.replace(/[.,]/g, "");
	if (!/^\d{1,9}$/.test(integer)) return null;
	const value = `${Number(integer)}${fraction && Number(fraction) !== 0 ? `.${fraction.padEnd(2, "0")}` : ""}`;
	return Number(value) > 0 ? value : null;
}

const normalizeName = (name: string) =>
	name
		.replace(/[\s ]+/g, " ")
		.trim()
		.toLowerCase();

const annualName = /\b(annual|yearly|year|1 year|12 months)\b/i;
const monthlyName = /\b(monthly|month)\b/i;
/** A same-name purchase this many times the cheapest one is the yearly plan. */
const yearlyRatio = 6;

type Listing = { name: string; amount: string };

function classify(items: Listing[]) {
	const byName = new Map<string, Listing[]>();
	for (const item of items) {
		const key = normalizeName(item.name);
		byName.set(key, [...(byName.get(key) ?? []), item]);
	}
	const result: { name: string; amount: string; period: AppStorePeriod }[] = [];
	for (const [name, group] of byName) {
		const min = Math.min(...group.map((item) => Number(item.amount)));
		for (const item of group) {
			const period: AppStorePeriod = annualName.test(item.name)
				? "year"
				: monthlyName.test(item.name)
					? "month"
					: Number(item.amount) >= min * yearlyRatio
						? "year"
						: "month";
			result.push({ name, amount: item.amount, period });
		}
	}
	return result;
}

/** Most frequent price (duplicates are common); ties go to the higher one. */
function mostCommon(amounts: string[]) {
	const counts = new Map<string, number>();
	for (const amount of amounts)
		counts.set(amount, (counts.get(amount) ?? 0) + 1);
	return [...counts.entries()].sort(
		(a, b) => b[1] - a[1] || Number(b[0]) - Number(a[0]),
	)[0]?.[0];
}

export function pickAppleTierAmount(
	tier: Pick<AppStoreTierConfig, "appleNames" | "period">,
	items: Listing[],
): string | null {
	const classified = classify(items);
	for (const name of tier.appleNames) {
		const key = normalizeName(name);
		const amounts = classified
			.filter((item) => item.name === key && item.period === tier.period)
			.map((item) => item.amount);
		const picked = mostCommon(amounts);
		if (picked) return picked;
	}
	return null;
}

function toCny(
	amount: string,
	currency: AppStoreCurrency,
	cnyPer: Record<AppStoreCurrency, number>,
) {
	return Math.round(Number(amount) * cnyPer[currency]);
}

function ratesFrom(
	ingest: AppStoreIngest,
	previous: AppStorePriceSnapshot | null,
) {
	const rates = ingest.rates;
	if (rates) {
		const cnyPer = {} as Record<AppStoreCurrency, number>;
		let complete = true;
		for (const region of appStoreRegions) {
			const perCny = rates.rates[region.currency];
			if (!perCny) complete = false;
			else cnyPer[region.currency] = Math.round((1 / perCny) * 1e6) / 1e6;
		}
		if (complete)
			return { date: rates.date, cnyPer, fetchedAt: ingest.fetchedAt };
	}
	return previous?.rates ?? null;
}

/**
 * Builds the next snapshot. Per cell: today's App Store price, else today's
 * OpenTheRank price, else — only when a source could not be read — the
 * previous value with its original date. A cell both sources read and did
 * not list is genuinely empty. Null when no exchange rate was ever known.
 */
export function buildAppStoreSnapshot(
	ingest: AppStoreIngest,
	previous: AppStorePriceSnapshot | null,
): AppStorePriceSnapshot | null {
	const rates = ratesFrom(ingest, previous);
	if (!rates) return null;
	const apple = new Map(
		ingest.apple.map((page) => [`${page.app}:${page.region}`, page]),
	);
	const otr = new Map(ingest.opentherank.map((page) => [page.app, page]));
	const previousCell = (app: string, tier: string, region: AppStoreRegionId) =>
		previous?.apps
			.find((entry) => entry.id === app)
			?.tiers.find((entry) => entry.id === tier)?.cells[region] ?? null;

	const apps = appStorePriceApps.map((app) => ({
		id: app.id,
		tiers: app.tiers.map((tier) => {
			const cells = {} as Record<AppStoreRegionId, AppStorePriceCell | null>;
			for (const region of appStoreRegions) {
				const make = (amount: string, source: AppStorePriceSource) => ({
					amount,
					currency: region.currency,
					cny: toCny(amount, region.currency, rates.cnyPer),
					source,
					fetchedAt: ingest.fetchedAt,
				});
				const page = apple.get(`${app.id}:${region.id}`);
				const appleItems = (page?.ok ? page.items : []).flatMap((item) => {
					const amount = parseLocalAmount(item.price);
					return amount ? [{ name: item.name, amount }] : [];
				});
				const appleAmount = page?.ok
					? pickAppleTierAmount(tier, appleItems)
					: null;
				const otrPage = otr.get(app.id);
				const otrText = tier.otrPlan
					? otrPage?.regions[region.id]?.[tier.otrPlan]
					: undefined;
				const otrAmount =
					otrPage?.ok && otrText ? parseLocalAmount(otrText) : null;
				const old = previousCell(app.id, tier.id, region.id);
				const restale = old
					? { ...old, cny: toCny(old.amount, old.currency, rates.cnyPer) }
					: null;
				const appleFailed = !page?.ok;
				const otrFailed = Boolean(tier.otrPlan) && !otrPage?.ok;
				cells[region.id] = appleAmount
					? make(appleAmount, "apple")
					: appleFailed && restale?.source === "apple"
						? restale
						: otrAmount
							? make(otrAmount, "opentherank")
							: appleFailed || otrFailed
								? restale
								: null;
			}
			return { id: tier.id, period: tier.period, cells };
		}),
	}));
	return { version: 1, updatedAt: ingest.fetchedAt, rates, apps };
}

const cellSchema = z
	.object({
		amount: z.string(),
		currency: z.string(),
		cny: z.number(),
		source: z.enum(["apple", "opentherank"]),
		fetchedAt: z.number(),
	})
	.nullable();

export const appStoreSnapshotSchema = z.object({
	version: z.literal(1),
	updatedAt: z.number(),
	rates: z.object({
		date: z.string(),
		cnyPer: z.record(z.string(), z.number()),
		fetchedAt: z.number(),
	}),
	apps: z.array(
		z.object({
			id: z.string(),
			tiers: z.array(
				z.object({
					id: z.string(),
					period: z.enum(["month", "year"]),
					cells: z.record(z.string(), cellSchema),
				}),
			),
		}),
	),
});

export function parseAppStoreSnapshot(value: unknown) {
	const parsed = appStoreSnapshotSchema.safeParse(value);
	return parsed.success ? (parsed.data as AppStorePriceSnapshot) : null;
}
