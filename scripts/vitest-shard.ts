// Runs one duration-balanced slice of the Vitest suite for CI.
//   bun scripts/vitest-shard.ts <index> <total>
// Refresh tests/shard-timings.json after large test changes:
//   vitest run --reporter=json --outputFile.json=/tmp/vitest.json
//   bun scripts/vitest-shard.ts --update /tmp/vitest.json
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { relative } from "node:path";

const timingsPath = new URL("../tests/shard-timings.json", import.meta.url);
const root = process.cwd();

if (process.argv[2] === "--update") {
	const report = JSON.parse(readFileSync(process.argv[3] ?? "", "utf8")) as {
		testResults: { name: string; startTime: number; endTime: number }[];
	};
	const timings = Object.fromEntries(
		report.testResults
			.map((result) => [
				relative(root, result.name),
				Math.round((result.endTime - result.startTime) / 100) / 10,
			])
			.sort(([a], [b]) => String(a).localeCompare(String(b))),
	);
	writeFileSync(timingsPath, `${JSON.stringify(timings, null, "\t")}\n`);
	process.exit(0);
}

const index = Number(process.argv[2]);
const total = Number(process.argv[3]);
if (
	!Number.isInteger(index) ||
	!Number.isInteger(total) ||
	index < 1 ||
	index > total
)
	throw new Error("usage: bun scripts/vitest-shard.ts <index> <total>");

const listed = spawnSync("bunx", ["vitest", "list", "--filesOnly", "--json"], {
	encoding: "utf8",
	maxBuffer: 64 * 1024 * 1024,
});
if (listed.status !== 0) {
	process.stderr.write(listed.stderr);
	process.exit(listed.status ?? 1);
}
const files = (JSON.parse(listed.stdout) as { file: string }[])
	.map((entry) => relative(root, entry.file))
	.sort();
const timings = JSON.parse(readFileSync(timingsPath, "utf8")) as Record<
	string,
	number
>;
const known = Object.values(timings).sort((a, b) => a - b);
// Files without a recorded time (new tests) are weighted at the median.
const fallback = known[Math.floor(known.length / 2)] ?? 1;

// Longest first onto the least-loaded shard; deterministic so every runner
// computes the same partition.
const shards = Array.from({ length: total }, () => ({
	load: 0,
	files: [] as string[],
}));
for (const file of [...files].sort(
	(a, b) =>
		(timings[b] ?? fallback) - (timings[a] ?? fallback) || a.localeCompare(b),
)) {
	const target = shards.reduce((min, shard) =>
		shard.load < min.load ? shard : min,
	);
	target.load += timings[file] ?? fallback;
	target.files.push(file);
}

const mine = shards[index - 1] ?? { load: 0, files: [] };
console.log(
	`shard ${index}/${total}: ${mine.files.length} files, ~${Math.round(mine.load)}s recorded`,
);
const run = spawnSync("bunx", ["vitest", "run", ...mine.files], {
	stdio: "inherit",
});
process.exit(run.status ?? 1);
