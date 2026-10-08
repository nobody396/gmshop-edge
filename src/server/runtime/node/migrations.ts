import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { NodeDatabase } from "./database";

// v1.24.0 Bun already accepts the original trigger SQL. Accept only these exact
// equivalent checksums; never replay the ALTERs or weaken checks for other edits.
const equivalentPromotionChecksums: Record<
	string,
	{ previous: string; current: string }
> = {
	"0028_invitation_promotions.sql": {
		previous:
			"21fe5cedd1b1136add04c9c105dfbc07823fe6c5297ae5e5ef0e8ce244734a84",
		current: "86cfd2cc44b0a659436003e62dc4a41a6e8a9ffc9bd8cbcbdd2de5372f08d907",
	},
	"0029_promotion_wallet.sql": {
		previous:
			"8ee10f2b35f69330e5bf67c46ef65626cb476f5bb530d8d229b754873bd683ee",
		current: "930f0b9a3cf08d92b7fca768a78ef6965e815339a89803aea769141086fee357",
	},
};

const MIGRATION_PATTERN = /^\d+_.+\.sql$/;

export type NodeMigration = {
	name: string;
	sql: string;
	checksum: string;
};

export async function loadNodeMigrations(
	directory: URL | string = new URL("../../../../drizzle/", import.meta.url),
): Promise<NodeMigration[]> {
	const files = (await readdir(directory))
		.filter((name) => MIGRATION_PATTERN.test(name))
		.sort();
	return Promise.all(
		files.map(async (name) => {
			const sql = await readFile(
				typeof directory === "string"
					? new URL(name, `file://${resolve(directory)}/`)
					: new URL(name, directory),
				"utf8",
			);
			return { name, sql, checksum: sha256(sql) };
		}),
	);
}

export async function applyNodeMigrations(
	database: NodeDatabase,
	directory: URL | string = new URL("../../../../drizzle/", import.meta.url),
) {
	const migrations = await loadNodeMigrations(directory);
	const knownNames = new Set(migrations.map(({ name }) => name));

	const apply = database.sqlite.transaction(() => {
		database.sqlite.run(`CREATE TABLE IF NOT EXISTS node_migrations (
			name TEXT PRIMARY KEY NOT NULL,
			checksum TEXT NOT NULL,
			applied_at INTEGER NOT NULL
		)`);
		const record = database.sqlite.prepare(
			"INSERT INTO node_migrations (name, checksum, applied_at) VALUES (?, ?, ?)",
		);
		const appliedRows = database.sqlite
			.prepare("SELECT name, checksum FROM node_migrations")
			.all() as Array<{ name: string; checksum: string }>;
		const unknown = appliedRows.filter(({ name }) => !knownNames.has(name));
		if (unknown.length > 0)
			throw new Error(
				`Database contains unknown migrations: ${unknown.map(({ name }) => name).join(", ")}`,
			);
		const appliedChecksums = new Map(
			appliedRows.map(({ name, checksum }) => [name, checksum]),
		);
		let appliedCount = 0;
		for (const migration of migrations) {
			const existingChecksum = appliedChecksums.get(migration.name);
			if (existingChecksum) {
				const equivalent = equivalentPromotionChecksums[migration.name];
				if (
					existingChecksum !== migration.checksum &&
					!(
						equivalent?.previous === existingChecksum &&
						equivalent.current === migration.checksum
					)
				)
					throw new Error(`Applied migration changed: ${migration.name}`);
				continue;
			}
			for (const statement of splitMigration(migration.sql)) {
				if (isForeignKeysPragma(statement)) continue;
				database.sqlite.run(normalizeTemporaryTableChecks(statement));
			}
			record.run(migration.name, migration.checksum, Date.now());
			appliedCount += 1;
		}
		const foreignKeyViolations = database.sqlite
			.prepare("PRAGMA foreign_key_check")
			.all();
		if (foreignKeyViolations.length > 0)
			throw new Error(
				`Migration foreign-key check failed (${foreignKeyViolations.length} violation(s))`,
			);
		return appliedCount;
	});

	const foreignKeysEnabled =
		(
			database.sqlite.prepare("PRAGMA foreign_keys").get() as
				| { foreign_keys: number }
				| undefined
		)?.foreign_keys === 1;
	if (foreignKeysEnabled) database.sqlite.run("PRAGMA foreign_keys = OFF");
	try {
		return { applied: apply(), total: migrations.length };
	} finally {
		if (foreignKeysEnabled) database.sqlite.run("PRAGMA foreign_keys = ON");
	}
}

function splitMigration(sql: string) {
	return sql
		.split("--> statement-breakpoint")
		.map((statement) => statement.trim())
		.filter(Boolean);
}

function isForeignKeysPragma(statement: string) {
	return /^PRAGMA\s+foreign_keys\s*=\s*(?:ON|OFF)\s*;?$/iu.test(statement);
}

function normalizeTemporaryTableChecks(statement: string) {
	const temporaryTable = /^CREATE\s+TABLE\s+[`"](__new_[^`"]+)[`"]\s*\(/iu.exec(
		statement,
	)?.[1];
	if (!temporaryTable) return statement;
	return statement
		.replaceAll(`"${temporaryTable}".`, "")
		.replaceAll(`\`${temporaryTable}\`.`, "");
}

function sha256(value: string) {
	return createHash("sha256").update(value).digest("hex");
}
