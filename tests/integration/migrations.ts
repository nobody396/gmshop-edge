import { readdir, readFile } from "node:fs/promises";

export async function applyMigrations(database: D1Database, through?: string) {
	const directory = new URL("../../drizzle/", import.meta.url);
	const files = (await readdir(directory))
		.filter(
			(name) => /^\d+_.+\.sql$/.test(name) && (!through || name <= through),
		)
		.sort();
	for (const file of files) {
		const migration = await readFile(new URL(file, directory), "utf8");
		for (const statement of migration
			.split("--> statement-breakpoint")
			.map((value) => value.trim())
			.filter(Boolean))
			await database.prepare(statement).run();
	}
}
