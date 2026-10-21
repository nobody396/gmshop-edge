-- SEO/GEO guide articles published through the ops API without a deploy.
CREATE TABLE `guides` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`body_md` text NOT NULL,
	`faq_json` text DEFAULT '[]' NOT NULL,
	`related_product_ids` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`published_at` integer,
	`source` text DEFAULT 'manual' NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT "guides_slug_check" CHECK("guides"."slug" GLOB '[a-z0-9]*' AND "guides"."slug" NOT GLOB '*[^a-z0-9-]*' AND length("guides"."slug") BETWEEN 2 AND 80),
	CONSTRAINT "guides_status_check" CHECK("guides"."status" IN ('draft','published')),
	CONSTRAINT "guides_source_check" CHECK("guides"."source" IN ('manual','auto')),
	CONSTRAINT "guides_faq_json_check" CHECK(json_valid("guides"."faq_json") AND json_type("guides"."faq_json") = 'array'),
	CONSTRAINT "guides_related_product_ids_check" CHECK(json_valid("guides"."related_product_ids") AND json_type("guides"."related_product_ids") = 'array'),
	CONSTRAINT "guides_revision_check" CHECK("guides"."revision" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `guides_slug_uidx` ON `guides` (`slug`);
--> statement-breakpoint
CREATE INDEX `guides_status_updated_idx` ON `guides` (`status`,`updated_at`);
