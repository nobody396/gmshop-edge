import type {
	GuideFaqItem,
	GuideUpsertInput,
} from "#/features/guides/server/rules";

export type GuideStatus = "draft" | "published";

export type StoredGuide = {
	id: string;
	slug: string;
	title: string;
	description: string;
	bodyMd: string;
	faq: GuideFaqItem[];
	relatedProductIds: string[];
	status: GuideStatus;
	publishedAt: number | null;
	source: "manual" | "auto";
	revision: number;
	createdAt: number;
	updatedAt: number;
};

type GuideRow = {
	id: string;
	slug: string;
	title: string;
	description: string;
	body_md: string;
	faq_json: string;
	related_product_ids: string;
	status: GuideStatus;
	published_at: number | null;
	source: "manual" | "auto";
	revision: number;
	created_at: number;
	updated_at: number;
};

function parseArray<T>(value: string): T[] {
	try {
		const parsed: unknown = JSON.parse(value);
		return Array.isArray(parsed) ? (parsed as T[]) : [];
	} catch {
		return [];
	}
}

function mapGuide(row: GuideRow): StoredGuide {
	return {
		id: row.id,
		slug: row.slug,
		title: row.title,
		description: row.description,
		bodyMd: row.body_md,
		faq: parseArray<GuideFaqItem>(row.faq_json),
		relatedProductIds: parseArray<string>(row.related_product_ids),
		status: row.status,
		publishedAt: row.published_at === null ? null : Number(row.published_at),
		source: row.source,
		revision: Number(row.revision),
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at),
	};
}

export async function getGuide(db: D1Database, slug: string) {
	const row = await db
		.prepare("SELECT * FROM guides WHERE slug = ? LIMIT 1")
		.bind(slug)
		.first<GuideRow>();
	return row ? mapGuide(row) : null;
}

export async function getPublishedGuide(db: D1Database, slug: string) {
	const row = await db
		.prepare(
			"SELECT * FROM guides WHERE slug = ? AND status = 'published' LIMIT 1",
		)
		.bind(slug)
		.first<GuideRow>();
	return row ? mapGuide(row) : null;
}

export type GuideSummary = {
	slug: string;
	title: string;
	description: string;
	status: GuideStatus;
	source: "manual" | "auto";
	revision: number;
	publishedAt: number | null;
	updatedAt: number;
};

const summaryColumns =
	"slug, title, description, status, source, revision, published_at, updated_at";

function mapSummary(row: {
	slug: string;
	title: string;
	description: string;
	status: GuideStatus;
	source: "manual" | "auto";
	revision: number;
	published_at: number | null;
	updated_at: number;
}): GuideSummary {
	return {
		slug: row.slug,
		title: row.title,
		description: row.description,
		status: row.status,
		source: row.source,
		revision: Number(row.revision),
		publishedAt: row.published_at === null ? null : Number(row.published_at),
		updatedAt: Number(row.updated_at),
	};
}

export async function listGuides(db: D1Database) {
	const result = await db
		.prepare(
			`SELECT ${summaryColumns} FROM guides ORDER BY updated_at DESC, slug LIMIT 1000`,
		)
		.all<Parameters<typeof mapSummary>[0]>();
	return result.results.map(mapSummary);
}

export async function listPublishedGuides(db: D1Database) {
	const result = await db
		.prepare(
			`SELECT ${summaryColumns} FROM guides WHERE status = 'published'
			 ORDER BY updated_at DESC, slug LIMIT 1000`,
		)
		.all<Parameters<typeof mapSummary>[0]>();
	return result.results.map(mapSummary);
}

export type GuideWriteResult =
	| { ok: true; guide: StoredGuide; created: boolean }
	| { ok: false; reason: "not_found" | "revision_conflict"; revision?: number };

/** Insert or replace the content of one guide; status is left untouched. */
export async function upsertGuide(
	db: D1Database,
	slug: string,
	input: GuideUpsertInput,
	now = Date.now(),
): Promise<GuideWriteResult> {
	const existing = await getGuide(db, slug);
	if (
		input.revision !== undefined &&
		existing &&
		existing.revision !== input.revision
	)
		return {
			ok: false,
			reason: "revision_conflict",
			revision: existing.revision,
		};
	if (input.revision !== undefined && !existing)
		return { ok: false, reason: "not_found" };
	const faq = JSON.stringify(input.faq);
	const related = JSON.stringify(input.relatedProductIds);
	if (!existing) {
		const row = await db
			.prepare(
				`INSERT INTO guides (id, slug, title, description, body_md, faq_json,
				  related_product_ids, status, source, revision, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, 1, ?, ?)
				 ON CONFLICT(slug) DO NOTHING
				 RETURNING *`,
			)
			.bind(
				crypto.randomUUID(),
				slug,
				input.title,
				input.description,
				input.bodyMd,
				faq,
				related,
				input.source,
				now,
				now,
			)
			.first<GuideRow>();
		if (!row) return { ok: false, reason: "revision_conflict" };
		return { ok: true, guide: mapGuide(row), created: true };
	}
	const row = await db
		.prepare(
			`UPDATE guides SET title = ?, description = ?, body_md = ?, faq_json = ?,
			  related_product_ids = ?, source = ?, revision = revision + 1, updated_at = ?
			 WHERE slug = ? AND revision = ?
			 RETURNING *`,
		)
		.bind(
			input.title,
			input.description,
			input.bodyMd,
			faq,
			related,
			input.source,
			now,
			slug,
			existing.revision,
		)
		.first<GuideRow>();
	if (!row) return { ok: false, reason: "revision_conflict" };
	return { ok: true, guide: mapGuide(row), created: false };
}

export async function setGuideStatus(
	db: D1Database,
	slug: string,
	status: GuideStatus,
	expectedRevision?: number,
	now = Date.now(),
): Promise<GuideWriteResult> {
	const existing = await getGuide(db, slug);
	if (!existing) return { ok: false, reason: "not_found" };
	if (expectedRevision !== undefined && existing.revision !== expectedRevision)
		return {
			ok: false,
			reason: "revision_conflict",
			revision: existing.revision,
		};
	if (existing.status === status)
		return { ok: true, guide: existing, created: false };
	const row = await db
		.prepare(
			// A first publish dates the article from going live; later
			// unpublish/republish cycles keep the last content date.
			`UPDATE guides SET status = ?,
			  updated_at = CASE WHEN ? = 'published' AND published_at IS NULL THEN ? ELSE updated_at END,
			  published_at = CASE WHEN ? = 'published' THEN COALESCE(published_at, ?) ELSE published_at END,
			  revision = revision + 1
			 WHERE slug = ? AND revision = ?
			 RETURNING *`,
		)
		.bind(status, status, now, status, now, slug, existing.revision)
		.first<GuideRow>();
	if (!row) return { ok: false, reason: "revision_conflict" };
	return { ok: true, guide: mapGuide(row), created: false };
}
