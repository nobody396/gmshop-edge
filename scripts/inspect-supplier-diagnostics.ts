/** Owner-local, read-only retrieval. Secrets never enter argv, files or stdout. */
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { decryptSecret } from "../src/lib/secrets";

async function main() {
	const { values } = parseArgs({
		options: {
			account: { type: "string" },
			database: { type: "string" },
			bucket: { type: "string", default: "gmshop-edge-files" },
			order: { type: "string" },
			exchange: { type: "string" },
		},
	});
	if (
		!values.account ||
		!values.database ||
		(!values.order && !values.exchange)
	) {
		console.error(
			"Usage: bun scripts/inspect-supplier-diagnostics.ts --account ID --database ID --order GM_ORDER_NUMBER [--exchange ID]",
		);
		process.exit(2);
	}
	const secret = spawnSync(
		"agent-switch",
		["secret", "get", "--fd", "3", "CLOUDFLARE_API_TOKEN"],
		{ stdio: ["ignore", "ignore", "ignore", "pipe"] },
	);
	const token = secret.output[3]?.toString().trim();
	if (secret.status !== 0 || !token)
		throw new Error("Cloudflare credential unavailable");
	const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(values.account)}`;
	const auth = { Authorization: `Bearer ${token}` };
	async function query(sql: string, params: string[]) {
		const response = await fetch(
			`${base}/d1/database/${encodeURIComponent(values.database ?? "")}/query`,
			{
				method: "POST",
				headers: { ...auth, "content-type": "application/json" },
				body: JSON.stringify({ sql, params }),
			},
		);
		if (!response.ok) throw new Error(`D1 returned HTTP ${response.status}`);
		const data = (await response.json()) as {
			success: boolean;
			result: Array<{ results: Array<Record<string, unknown>> }>;
		};
		if (!data.success) throw new Error("D1 query failed");
		return data.result[0]?.results ?? [];
	}
	const records = await query(
		`SELECT e.*, o.order_number, so.provider_request_no, so.state AS supplier_state, so.last_error_code AS supplier_error FROM supplier_exchange_records e
 JOIN supplier_orders so ON so.id = e.supplier_order_id JOIN shop_orders o ON o.id = so.order_id
 WHERE ${values.exchange ? "e.id = ?" : "o.order_number = ?"} ORDER BY e.started_at, e.id`,
		[values.exchange ?? values.order ?? ""],
	);
	console.log(JSON.stringify({ records }, null, 2));
	if (values.exchange && records[0]) {
		const row = records[0];
		const key = String(row.object_key);
		if (
			!/^supplier-diagnostics\/v1\/[a-zA-Z0-9-]+\/[a-zA-Z0-9-]+\.json\.enc$/.test(
				key,
			)
		)
			throw new Error("Unexpected artifact key");
		const response = await fetch(
			`${base}/r2/buckets/${encodeURIComponent(values.bucket ?? "")}/objects/${key}`,
			{ headers: auth },
		);
		if (!response.ok)
			throw new Error(`Artifact read returned HTTP ${response.status}`);
		const settings = await query(
			"SELECT value FROM system_settings WHERE key = ?",
			["runtime.data_encryption_secret"],
		);
		const keyring = JSON.parse(String(settings[0]?.value));
		const artifact = JSON.parse(
			await decryptSecret(
				await response.text(),
				keyring,
				"supplier-diagnostic",
			),
		);
		const body: string = artifact.response?.body ?? "";
		let parsed: unknown;
		try {
			parsed = JSON.parse(body);
		} catch {
			parsed = undefined;
		}
		const shape = (value: unknown, depth = 0): unknown => {
			if (depth > 4) return typeof value;
			if (value === null) return "null";
			if (Array.isArray(value))
				return {
					type: "array",
					length: value.length,
					first: shape(value[0], depth + 1),
				};
			if (typeof value === "object")
				return Object.fromEntries(
					Object.entries(value).map(([key, item]) => [
						key,
						shape(item, depth + 1),
					]),
				);
			return typeof value === "string"
				? { type: "string", length: value.length }
				: typeof value;
		};
		// Never print fulfillment values or raw HTML that could contain a CDK.
		console.log(
			JSON.stringify(
				{
					artifactDecrypted: true,
					artifactVersion: artifact.version,
					request: {
						method: artifact.request?.method,
						url: artifact.request?.url,
						headers: artifact.request?.headers,
					},
					response: {
						httpStatus: artifact.response?.httpStatus,
						headers: artifact.response?.headers,
						truncated: artifact.response?.truncated,
						bodyBytes: artifact.response?.bodyBytes,
						isJSON: parsed !== undefined,
						shape: shape(parsed),
						isHTML: /<!doctype|<html/i.test(body),
						cloudflareErrorCode:
							/^error code:\s*(\d+)\s*$/i.exec(body)?.[1] ?? null,
						containsSqlLengthError:
							/data too long for column|SQLSTATE\[22001\]/i.test(body),
						containsPhpUndefinedVariable: /Undefined variable/i.test(body),
					},
				},
				null,
				2,
			),
		);
	}
}
main().catch(() => {
	console.error(
		"Unable to inspect supplier diagnostics safely. Check CLI arguments and owner API permissions.",
	);
	process.exitCode = 1;
});
