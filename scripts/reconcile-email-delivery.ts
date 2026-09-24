/** Owner-local provider readback. Dry-run by default; never sends any email. */
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { z } from "zod";
import { decryptNotificationMessage } from "../src/features/notifications/secrets";
import {
	type CloudflareEmailEvent,
	cloudflareEmailEventSchema,
	deliveryEvidenceStatements,
	planDeliveryEvidence,
} from "../src/features/notifications/server/delivery-evidence";

export async function reconcileEmailDelivery(args = process.argv.slice(2)) {
	const { values } = parseArgs({
		args,
		options: {
			account: { type: "string" },
			database: { type: "string" },
			zone: { type: "string" },
			since: { type: "string" },
			until: { type: "string" },
			execute: { type: "boolean", default: false },
		},
	});
	const { account, database, zone, since, until } = values;
	if (!account || !database || !zone || !since || !until)
		throw new Error(
			"Usage: bun scripts/reconcile-email-delivery.ts --account ID --database ID --zone ID --since ISO_UTC --until ISO_UTC [--execute]",
		);
	const start = Date.parse(z.iso.datetime().parse(since));
	const end = Date.parse(z.iso.datetime().parse(until));
	if (end <= start || end - start > 7 * 86_400_000 || end > Date.now() + 60_000)
		throw new Error("Use a past window of at most 7 days");
	const secret = spawnSync(
		"agent-switch",
		["secret", "get", "--fd", "3", "CLOUDFLARE_API_TOKEN"],
		{ stdio: ["ignore", "ignore", "ignore", "pipe"] },
	);
	const token = secret.output[3]?.toString().trim();
	if (secret.status !== 0 || !token)
		throw new Error("Cloudflare credential unavailable");
	async function api(path: string, body?: unknown) {
		const response = await fetch(
			`https://api.cloudflare.com/client/v4${path}`,
			{
				method: body === undefined ? "GET" : "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				...(body === undefined ? {} : { body: JSON.stringify(body) }),
				signal: AbortSignal.timeout(30_000),
			},
		);
		if (!response.ok) throw new Error(`Cloudflare HTTP ${response.status}`);
		return response.json();
	}
	const zoneInfo = z
		.object({
			success: z.literal(true),
			result: z.object({
				name: z.string(),
				account: z.object({ id: z.string() }),
			}),
		})
		.parse(await api(`/zones/${encodeURIComponent(zone)}`));
	if (zoneInfo.result.account.id !== account)
		throw new Error("Zone/account mismatch");
	const databasePath = `/accounts/${encodeURIComponent(account)}/d1/database/${encodeURIComponent(database)}/query`;
	async function query(sql: string, params: (string | number | null)[] = []) {
		const result = z
			.object({
				success: z.literal(true),
				result: z.array(
					z.object({
						success: z.literal(true),
						results: z.array(z.record(z.string(), z.unknown())),
					}),
				),
			})
			.parse(await api(databasePath, { sql, params }));
		return result.result[0]?.results ?? [];
	}
	const config = await query(
		"SELECT from_address FROM notification_channel_configs WHERE channel = 'email' AND provider = 'cloudflare_email'",
	);
	if (
		!config.length ||
		config.some(
			(r) =>
				!String(r.from_address).endsWith(`@${zoneInfo.result.name}>`) &&
				!String(r.from_address).endsWith(`@${zoneInfo.result.name}`),
		)
	)
		throw new Error("Sending domain/database mismatch");
	const queryText = `query EmailEvidence($zone: string!, $start: Time!, $end: Time!) { viewer { zones(filter: {zoneTag: $zone}) { emailSendingAdaptive(filter: {datetime_geq: $start, datetime_leq: $end}, limit: 500, orderBy: [datetime_DESC]) { datetime from to messageId status errorCause errorDetail isLastEvent } } } }`;
	let analyticsRequests = 0;
	async function eventsBetween(
		from: number,
		to: number,
	): Promise<CloudflareEmailEvent[]> {
		if (++analyticsRequests > 128)
			throw new Error("Too many email events; shorten the window");
		const result = z
			.object({
				errors: z.array(z.unknown()).nullish(),
				data: z
					.object({
						viewer: z.object({
							zones: z.array(
								z.object({
									emailSendingAdaptive: z.array(cloudflareEmailEventSchema),
								}),
							),
						}),
					})
					.nullish(),
			})
			.parse(
				await api("/graphql", {
					query: queryText,
					variables: {
						zone,
						start: new Date(from).toISOString(),
						end: new Date(to).toISOString(),
					},
				}),
			);
		if (result.errors?.length || result.data?.viewer.zones.length !== 1)
			throw new Error("Email analytics unavailable or unauthorized");
		const events = result.data.viewer.zones[0]?.emailSendingAdaptive;
		if (!events) throw new Error("Missing email analytics zone");
		if (events.length < 500) return events;
		if (to - from <= 1000)
			throw new Error(
				"Email analytics window saturated; refusing incomplete reconciliation",
			);
		const mid = Math.floor((from + to) / 2);
		return [
			...(await eventsBetween(from, mid)),
			...(await eventsBetween(mid, to)),
		];
	}
	const events = await eventsBetween(start, end);
	const candidates = events.filter(
		(e) => Boolean(e.isLastEvent) && e.messageId.length > 0,
	);
	const settings = await query(
		"SELECT value FROM system_settings WHERE key = 'runtime.data_encryption_secret'",
	);
	const keyring: unknown = JSON.parse(String(settings[0]?.value));
	if (typeof keyring !== "string")
		throw new Error("Unexpected encryption keyring setting");
	let matched = 0;
	for (const messageId of new Set(candidates.map((e) => e.messageId))) {
		const rows = await query(
			`SELECT n.id,n.status,n.provider_message_id,n.accepted_at,n.created_at,n.provider_event_at,n.message_encrypted,c.from_address FROM notification_deliveries n JOIN notification_channel_configs c ON c.id=n.channel_config_id WHERE n.provider_message_id=? AND c.provider='cloudflare_email' LIMIT 2`,
			[messageId],
		);
		if (!rows.length) continue;
		if (rows.length !== 1)
			throw new Error("Ambiguous provider message mapping");
		const row = z
			.object({
				id: z.string(),
				status: z.string(),
				provider_message_id: z.string(),
				accepted_at: z.number().nullable(),
				created_at: z.number(),
				provider_event_at: z.number().nullable(),
				message_encrypted: z.string(),
				from_address: z.string(),
			})
			.parse(rows[0]);
		const message = z
			.object({ to: z.email() })
			.parse(
				JSON.parse(
					await decryptNotificationMessage(row.message_encrypted, keyring),
				),
			);
		const plan = await planDeliveryEvidence(row, message.to, candidates);
		if (!plan) continue;
		matched++;
		if (values.execute) {
			for (const statement of deliveryEvidenceStatements(plan))
				await query(statement.sql, statement.params);
			const readback = await query(
				"SELECT status,provider_event_at FROM notification_deliveries WHERE id=?",
				[plan.id],
			);
			if (
				readback[0]?.status !== plan.status ||
				readback[0]?.provider_event_at !== plan.occurredAt
			)
				throw new Error("Email evidence write/readback conflict");
		}
		console.log(
			JSON.stringify({
				deliveryId: plan.id,
				status: plan.status,
				eventAt: new Date(plan.occurredAt).toISOString(),
				suppress: plan.suppress,
				applied: values.execute,
			}),
		);
	}
	console.log(
		JSON.stringify({
			matched,
			events: events.length,
			mode: values.execute ? "execute" : "dry-run",
			emailsSent: 0,
		}),
	);
}
if (import.meta.main)
	reconcileEmailDelivery().catch(() => {
		console.error(
			"Email evidence reconciliation stopped; no mail was sent. Check arguments, access, migration and provider evidence. Do not resend.",
		);
		process.exitCode = 1;
	});
