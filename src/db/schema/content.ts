import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { timestamps } from "./common";

/** SEO/GEO guide articles, written through the ops API (see drizzle/0042). */
export const guides = sqliteTable(
	"guides",
	{
		id: text("id").primaryKey(),
		slug: text("slug").notNull(),
		title: text("title").notNull(),
		description: text("description").notNull(),
		bodyMd: text("body_md").notNull(),
		faqJson: text("faq_json", { mode: "json" })
			.$type<Array<{ q: string; a: string }>>()
			.notNull()
			.default(sql`'[]'`),
		relatedProductIds: text("related_product_ids", { mode: "json" })
			.$type<string[]>()
			.notNull()
			.default(sql`'[]'`),
		status: text("status", { enum: ["draft", "published"] })
			.notNull()
			.default("draft"),
		publishedAt: integer("published_at", { mode: "timestamp_ms" }),
		source: text("source", { enum: ["manual", "auto"] })
			.notNull()
			.default("manual"),
		revision: integer("revision").notNull().default(1),
		...timestamps,
	},
	(table) => [
		uniqueIndex("guides_slug_uidx").on(table.slug),
		index("guides_status_updated_idx").on(table.status, table.updatedAt),
		check(
			"guides_slug_check",
			sql`${table.slug} GLOB '[a-z0-9]*' AND ${table.slug} NOT GLOB '*[^a-z0-9-]*' AND length(${table.slug}) BETWEEN 2 AND 80`,
		),
		check("guides_status_check", sql`${table.status} IN ('draft','published')`),
		check("guides_source_check", sql`${table.source} IN ('manual','auto')`),
		check(
			"guides_faq_json_check",
			sql`json_valid(${table.faqJson}) AND json_type(${table.faqJson}) = 'array'`,
		),
		check(
			"guides_related_product_ids_check",
			sql`json_valid(${table.relatedProductIds}) AND json_type(${table.relatedProductIds}) = 'array'`,
		),
		check("guides_revision_check", sql`${table.revision} > 0`),
	],
);
