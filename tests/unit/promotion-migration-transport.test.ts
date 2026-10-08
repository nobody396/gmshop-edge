import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

for (const name of [
	"0028_invitation_promotions.sql",
	"0029_promotion_wallet.sql",
]) {
	it(`${name} protects CASE expressions from the remote D1 trigger splitter`, async () => {
		const sql = await readFile(
			new URL(`../../drizzle/${name}`, import.meta.url),
			"utf8",
		);
		const statements = sql.replace(/^--.*$/gm, "");
		expect(statements).not.toContain("\r");
		expect(statements.match(/\bCASE\b/g)?.length).toBeGreaterThan(0);
		expect(statements.match(/\bCASE\b/g)?.length).toBe(
			statements.match(/\(CASE\b/g)?.length,
		);
	});
}
