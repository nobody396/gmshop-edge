import { z } from "zod";
import { requireRestockAuthorization } from "#/features/catalog/server/restock-api";
import { guideSlugSchema, reservedGuideSlugs } from "#/features/guides/content";
import {
	findGuideBannedWords,
	guideTexts,
	guideUpsertSchema,
} from "#/features/guides/server/rules";
import { DomainError } from "#/lib/domain-error";
import { claimFixedWindowRateLimit } from "#/server/rate-limit";
import type { CloudflareBindings } from "#/server/runtime/cloudflare";
import { findUnresolvedGuideTokens } from "./public-guide";
import {
	type GuideWriteResult,
	getGuide,
	listGuides,
	setGuideStatus,
	upsertGuide,
} from "./store";

export type GuideOpsAction = "publish" | "unpublish";

const statusBodySchema = z
	.object({ revision: z.number().int().positive().optional() })
	.default({});

const MAX_BODY_BYTES = 200_000;

/**
 * /api/ops/guides[/:slug[/publish|/unpublish]] — Bearer RESTOCK_API_TOKEN.
 * GET list / GET one / PUT upsert / POST publish|unpublish.
 */
export async function handleGuidesOpsRequest(
	request: Request,
	env: CloudflareBindings,
	route: { slug?: string; action?: GuideOpsAction } = {},
) {
	try {
		const db = env.DB;
		if (!db || !env.RESTOCK_API_TOKEN)
			throw new DomainError(
				"guides_api_unavailable",
				503,
				"Guides API unavailable",
			);
		await requireRestockAuthorization(request, db, env.RESTOCK_API_TOKEN);
		const budget = await claimFixedWindowRateLimit(db, {
			bucketKey: `guides-api:${request.headers.get("cf-connecting-ip") ?? "unknown"}`,
			limit: 60,
			windowMs: 60_000,
			now: Date.now(),
		});
		if (!budget.allowed)
			throw new DomainError("guides_rate_limited", 429, "Rate limit exceeded");

		if (route.slug === undefined) {
			if (request.method !== "GET") return methodNotAllowed("GET");
			return json({ ok: true, guides: await listGuides(db) }, 200);
		}
		const slug = parseSlug(route.slug);

		if (route.action) {
			if (request.method !== "POST") return methodNotAllowed("POST");
			const body = statusBodySchema.parse(await readJson(request, true));
			if (route.action === "publish") {
				const guide = await getGuide(db, slug);
				if (!guide) throw new DomainError("guide_not_found", 404, "Not found");
				rejectBannedWords(guideTexts(guide));
			}
			return writeResponse(
				await setGuideStatus(
					db,
					slug,
					route.action === "publish" ? "published" : "draft",
					body.revision,
				),
				200,
			);
		}

		if (request.method === "GET") {
			const guide = await getGuide(db, slug);
			if (!guide) throw new DomainError("guide_not_found", 404, "Not found");
			return json({ ok: true, guide }, 200);
		}
		if (request.method !== "PUT") return methodNotAllowed("GET, PUT");
		const input = guideUpsertSchema.parse(await readJson(request, false));
		rejectBannedWords(guideTexts(input));
		const result = await upsertGuide(db, slug, input);
		const unresolvedTokens = result.ok
			? await findUnresolvedGuideTokens(db, input.bodyMd)
			: [];
		return writeResponse(result, result.ok && result.created ? 201 : 200, {
			unresolvedTokens,
		});
	} catch (error) {
		if (error instanceof BannedWordsError)
			return json(
				{ ok: false, error: "guide_banned_words", words: error.words },
				422,
			);
		if (error instanceof DomainError)
			return json({ ok: false, error: error.code }, error.status);
		if (error instanceof z.ZodError)
			return json(
				{
					ok: false,
					error: "guide_invalid",
					issues: error.issues.map((issue) => ({
						path: issue.path.join("."),
						message: issue.message,
					})),
				},
				400,
			);
		if (error instanceof SyntaxError)
			return json({ ok: false, error: "guide_invalid_json" }, 400);
		console.error(
			JSON.stringify({
				event: "guides_api_failed",
				message: error instanceof Error ? error.message : String(error),
			}),
		);
		return json({ ok: false, error: "guides_api_failed" }, 500);
	}
}

class BannedWordsError extends Error {
	constructor(readonly words: string[]) {
		super("banned words");
	}
}

function rejectBannedWords(texts: readonly string[]) {
	const words = findGuideBannedWords(texts);
	if (words.length) throw new BannedWordsError(words);
}

function parseSlug(value: string) {
	const parsed = guideSlugSchema.safeParse(value);
	if (!parsed.success)
		throw new DomainError("guide_invalid_slug", 400, "Invalid slug");
	if (reservedGuideSlugs.has(parsed.data))
		throw new DomainError("guide_slug_reserved", 400, "Reserved slug");
	return parsed.data;
}

async function readJson(request: Request, optional: boolean) {
	const contentLength = Number(request.headers.get("content-length") ?? "0");
	if (contentLength > MAX_BODY_BYTES)
		throw new DomainError("guide_payload_too_large", 413, "Payload too large");
	const text = await request.text();
	if (text.length > MAX_BODY_BYTES)
		throw new DomainError("guide_payload_too_large", 413, "Payload too large");
	if (!text.trim()) {
		if (optional) return undefined;
		throw new SyntaxError("empty body");
	}
	return JSON.parse(text) as unknown;
}

function writeResponse(
	result: GuideWriteResult,
	status: number,
	extra: Record<string, unknown> = {},
) {
	if (result.ok)
		return json({ ok: true, guide: result.guide, ...extra }, status);
	if (result.reason === "not_found")
		return json({ ok: false, error: "guide_not_found" }, 404);
	return json(
		{
			ok: false,
			error: "guide_revision_conflict",
			...(result.revision !== undefined
				? { currentRevision: result.revision }
				: {}),
		},
		409,
	);
}

function methodNotAllowed(allow: string) {
	return new Response(null, { status: 405, headers: { Allow: allow } });
}

function json(payload: unknown, status: number) {
	return Response.json(payload, {
		status,
		headers: { "Cache-Control": "no-store" },
	});
}
