import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
		// These suites need Bun's runtime and run through `bun test` instead.
		exclude: [
			...configDefaults.exclude,
			"tests/unit/server/node-data-operations.test.ts",
			"tests/unit/server/node-runtime-adapters.test.ts",
			"tests/unit/server/node-server-runtime.test.ts",
		],
		// Miniflare-backed D1 suites must not start concurrently; parallel
		// isolates contend for the local runtime and produce nondeterministic
		// hook/test timeouts. Test files remain independently runnable.
		fileParallelism: false,
		coverage: { reporter: ["text", "json"] },
	},
});
