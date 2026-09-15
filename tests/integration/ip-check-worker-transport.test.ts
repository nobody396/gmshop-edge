import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { createFetchMock, Miniflare } from "miniflare";
import ts from "typescript";
import { afterAll, beforeAll, expect, it } from "vitest";

let httpWorker: Miniflare;
let redirectWorker: Miniflare;
let redirectedCalls = 0;
beforeAll(async () => {
	const source = readFileSync(
		"src/features/ip-check/server/provider-transport.ts",
		"utf8",
	);
	const transport = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.ES2022,
			target: ts.ScriptTarget.ES2022,
		},
	}).outputText;
	const config = JSON.parse(readFileSync("wrangler.jsonc", "utf8"));
	const options = {
		modules: true,
		compatibilityDate: config.compatibility_date,
		compatibilityFlags: config.compatibility_flags,
		script:
			transport +
			`
 export default { async fetch(request) {
  try { const response=await fetchProvider('https://provider.example'+new URL(request.url).pathname);return Response.json({status:response.status,data:response.ok?await readProviderJson(response):null}); }
  catch(error){return Response.json({error:error.message},{status:502});}
 }}
 `,
	};
	// HTTP transport is necessary to exercise actual content-encoding decoding.
	const mock = createFetchMock();
	mock.disableNetConnect();
	mock
		.get("https://provider.example")
		.intercept({ path: "/ok" })
		.reply(200, '{"ok":true}');
	mock
		.get("https://provider.example")
		.intercept({ path: "/gzip" })
		.reply(200, gzipSync('{"ok":true}'), {
			headers: { "content-encoding": "gzip" },
		});
	mock
		.get("https://provider.example")
		.intercept({ path: "/large" })
		.reply(200, JSON.stringify({ padding: "x".repeat(70000) }));
	httpWorker = new Miniflare({ ...options, fetchMock: mock });
	// Return redirects directly at the native boundary, without HTTP mock indirection.
	redirectWorker = new Miniflare({
		...options,
		outboundService: async (request: { url: string }) => {
			redirectedCalls++;
			if (new URL(request.url).hostname !== "provider.example")
				throw new Error("Unexpected redirected request");
			return new Response(null, {
				status: 302,
				headers: { location: "https://must-not-follow.example/" },
			});
		},
	});
});
afterAll(async () => {
	await Promise.all([httpWorker.dispose(), redirectWorker.dispose()]);
});
it.each([
	"/ok",
	"/gzip",
])("decodes %s inside the actual Workers runtime", async (path) => {
	const response = await httpWorker.dispatchFetch(`https://app.example${path}`);
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ status: 200, data: { ok: true } });
});
it("does not follow provider redirects", async () => {
	const response = await redirectWorker.dispatchFetch(
		"https://app.example/redirect",
	);
	expect(await response.json()).toEqual({ status: 302, data: null });
	expect(redirectedCalls).toBe(1);
});
it("caps response bytes in the actual Workers runtime", async () => {
	const response = await httpWorker.dispatchFetch("https://app.example/large");
	expect(response.status).toBe(502);
	expect(await response.json()).toEqual({
		error: "Provider response too large",
	});
});
