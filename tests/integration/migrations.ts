import { readdir, readFile } from "node:fs/promises";

export async function applyMigrations(database: D1Database, through?: string) {
	const directory = new URL("../../drizzle/", import.meta.url);
	const files = (await readdir(directory))
		.filter(
			(name) => /^\d+_.+\.sql$/.test(name) && (!through || name <= through),
		)
		.sort();
	const statements: D1PreparedStatement[] = [];
	for (const file of files) {
		const migration = await readFile(new URL(file, directory), "utf8");
		for (const statement of migration
			.split("--> statement-breakpoint")
			.map((value) => value.trim())
			.filter(Boolean))
			statements.push(database.prepare(statement));
	}
	// One batch is a single round trip; per-statement runs cost ~3x as long
	// and every D1-backed test starts from a fresh database.
	if (statements.length) await database.batch(statements);
}
