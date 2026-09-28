import { readFile } from "node:fs/promises";
import { Miniflare } from "miniflare";
import { expect, it } from "vitest";

it("uses a non-following download mode accepted by the actual Workers runtime", async () => {
	const source = await readFile(
		new URL(
			"../../src/features/telegram/server/web-support-attachments.ts",
			import.meta.url,
		),
		"utf8",
	);
	const redirect = source.match(/redirect:\s*"([a-z]+)"/)?.[1];
	expect(redirect).toBe("manual");
	const worker = new Miniflare({
		modules: true,
		script: `export default {fetch(){const request=new Request('https://api.telegram.org/',{redirect:${JSON.stringify(redirect)}});return Response.json({redirect:request.redirect});}}`,
	});
	try {
		const response = await worker.dispatchFetch("http://localhost/");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ redirect: "manual" });
	} finally {
		await worker.dispose();
	}
});
