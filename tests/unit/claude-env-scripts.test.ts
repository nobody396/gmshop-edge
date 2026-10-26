import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeEnvScriptFiles } from "#/features/claude-env/client-scripts/scripts.generated";
import {
	claudeEnvScriptBytes,
	handleClaudeEnvScriptRequest,
} from "#/features/claude-env/server/scripts";

const root = resolve(import.meta.dirname, "../..");
const copies = join(root, "src/features/claude-env/client-scripts");
// The source repo is optional in CI; set CLAUDE_ENV_SETUP_DIR to compare locally.
const sourceDir = resolve(
	process.env.CLAUDE_ENV_SETUP_DIR ?? join(root, "..", "claude-env-setup"),
);
const names = ["claude-env.sh", "claude-env.ps1"] as const;

describe("hosted claude-env scripts", () => {
	for (const name of names) {
		it(`${name}: served bytes equal the repo copy byte-for-byte`, async () => {
			const copy = new Uint8Array(await readFile(join(copies, name)));
			const served = claudeEnvScriptBytes(name);
			expect(Buffer.from(served).equals(Buffer.from(copy))).toBe(true);
			expect(createHash("sha256").update(copy).digest("hex")).toBe(
				claudeEnvScriptFiles[name].sha256,
			);
		});

		it.skipIf(!existsSync(join(sourceDir, name)))(
			`${name}: repo copy equals claude-env-setup source`,
			async () => {
				const source = await readFile(join(sourceDir, name));
				const copy = await readFile(join(copies, name));
				expect(copy.equals(source)).toBe(true);
			},
		);
	}

	it("keeps the PowerShell UTF-8 BOM", () => {
		const bytes = claudeEnvScriptBytes("claude-env.ps1");
		expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
	});

	it("serves both scripts as text/plain with a short cache", async () => {
		for (const name of names) {
			const response = handleClaudeEnvScriptRequest(
				new Request(`https://laoshirenvip.com/${name}`),
			);
			expect(response?.status).toBe(200);
			expect(response?.headers.get("content-type")).toBe(
				"text/plain; charset=utf-8",
			);
			expect(response?.headers.get("cache-control")).toBe(
				"public, max-age=300",
			);
			const body = new Uint8Array(await (response as Response).arrayBuffer());
			expect(
				Buffer.from(body).equals(Buffer.from(claudeEnvScriptBytes(name))),
			).toBe(true);
		}
		expect(
			handleClaudeEnvScriptRequest(
				new Request("https://laoshirenvip.com/claude-env.sh", {
					method: "POST",
				}),
			),
		).toBeNull();
		expect(
			handleClaudeEnvScriptRequest(
				new Request("https://laoshirenvip.com/other.sh"),
			),
		).toBeNull();
	});
});
