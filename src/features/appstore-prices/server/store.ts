import { ZodError } from "zod";
import { requireRestockAuthorization } from "#/features/catalog/server/restock-api";
import { DomainError } from "#/lib/domain-error";
import type { CloudflareBindings } from "#/server/runtime/cloudflare";
import { appStorePriceApps, appStoreRegions } from "../config";
import {
	type AppStorePriceSnapshot,
	appStoreIngestSchema,
	buildAppStoreSnapshot,
	parseAppStoreSnapshot,
} from "../snapshot";

/** Display names for other storefronts (the agent shop) reading the JSON. */
function appStorePricesLayout() {
	return {
		regions: appStoreRegions,
		apps: appStorePriceApps.map((app) => ({
			id: app.id,
			title: app.title,
			titleEn: app.titleEn,
			tiers: app.tiers.map((tier) => ({
				id: tier.id,
				label: tier.label,
				labelEn: tier.labelEn,
				period: tier.period,
				hint: tier.hint ?? null,
				hintEn: tier.hintEn ?? null,
			})),
		})),
	};
}

export const appStorePricesSettingKey = "appstore_prices.snapshot";
const maxIngestBytes = 200_000;

export async function loadAppStoreSnapshot(
	db: D1Database,
): Promise<AppStorePriceSnapshot | null> {
	const row = await db
		.prepare("SELECT value FROM system_settings WHERE key = ? LIMIT 1")
		.bind(appStorePricesSettingKey)
		.first<{ value: string }>();
	if (!row) return null;
	try {
		return parseAppStoreSnapshot(JSON.parse(row.value));
	} catch {
		return null;
	}
}

async function saveAppStoreSnapshot(
	db: D1Database,
	snapshot: AppStorePriceSnapshot,
	now: number,
) {
	await db
		.prepare(
			`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
			 VALUES (?, ?, 0, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value,
			 updated_at = excluded.updated_at`,
		)
		.bind(appStorePricesSettingKey, JSON.stringify(snapshot), now, now)
		.run();
}

/**
 * POST /api/ops/appstore-prices — Bearer APPSTORE_PRICES_TOKEN. The daily
 * scraper (agent-shop host cron) posts raw listings; we merge and store them.
 */
export async function handleAppStorePricesIngest(
	request: Request,
	env: CloudflareBindings,
	now = Date.now(),
) {
	try {
		const db = env.DB;
		const token = env.APPSTORE_PRICES_TOKEN?.trim();
		if (!db || !token)
			throw new DomainError("appstore_prices_unavailable", 503, "Unavailable");
		if (request.method !== "POST")
			throw new DomainError("method_not_allowed", 405, "POST only");
		await requireRestockAuthorization(request, db, token);
		const body = await request.text();
		if (body.length > maxIngestBytes)
			throw new DomainError("appstore_prices_too_large", 413, "Too large");
		const ingest = appStoreIngestSchema.parse(JSON.parse(body));
		const previous = await loadAppStoreSnapshot(db);
		const snapshot = buildAppStoreSnapshot(ingest, previous);
		if (!snapshot)
			throw new DomainError(
				"appstore_prices_no_rates",
				422,
				"No exchange rates",
			);
		await saveAppStoreSnapshot(db, snapshot, now);
		let filled = 0;
		let fresh = 0;
		for (const app of snapshot.apps)
			for (const tier of app.tiers)
				for (const cell of Object.values(tier.cells)) {
					if (!cell) continue;
					filled += 1;
					if (cell.fetchedAt === snapshot.updatedAt) fresh += 1;
				}
		return json(
			{ ok: true, filled, fresh, ratesDate: snapshot.rates.date },
			200,
		);
	} catch (error) {
		if (error instanceof DomainError)
			return json({ ok: false, error: error.code }, error.status);
		if (error instanceof ZodError || error instanceof SyntaxError)
			return json({ ok: false, error: "invalid_request" }, 400);
		return json({ ok: false, error: "internal_error" }, 500);
	}
}

/** GET /api/public/appstore-prices — read-only, any origin, edge-cacheable. */
export async function handleAppStorePricesPublic(env: CloudflareBindings) {
	const headers = {
		"access-control-allow-origin": "*",
		"cross-origin-resource-policy": "cross-origin",
	};
	if (!env.DB)
		return Response.json(
			{ ok: false, error: "unavailable" },
			{ status: 503, headers: { ...headers, "cache-control": "no-store" } },
		);
	const snapshot = await loadAppStoreSnapshot(env.DB);
	return Response.json(
		{ ok: true, layout: appStorePricesLayout(), snapshot },
		{
			headers: {
				...headers,
				"cache-control": snapshot
					? "public, max-age=600, s-maxage=1800"
					: "public, max-age=60",
			},
		},
	);
}

function json(payload: unknown, status: number) {
	return Response.json(payload, {
		status,
		headers: { "Cache-Control": "no-store" },
	});
}
