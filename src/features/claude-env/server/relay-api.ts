import { z } from "zod";
import {
	claudeEnvSettingKeys,
	desiredStatuses,
	patrolFailThreshold,
	provisioningFailThreshold,
	relaySkewSeconds,
	signRelayRequest,
	timingSafeEqualHex,
	trafficPeriodStart,
} from "../domain";
import { needsReplaceAlert, subscriptionLabel } from "./alerts";
import {
	alertThrottled,
	type Crypt,
	type Deliver,
	defaultDeliver,
	eventStatement,
	loadCrypt,
	secretPurpose,
} from "./shared";

/**
 * Relay ↔ control-center API v1 (claude-env-setup/docs/CONTROL_API.md):
 *   GET  /api/claude-env/relay/v1/desired
 *   POST /api/claude-env/relay/v1/report
 */
export const relayApiPrefix = "/api/claude-env/relay/v1/";
const maxBodyBytes = 1_000_000;

type RelayRow = {
	id: string;
	hostname: string;
	secret_encrypted: string;
	status: string;
	monthly_quota_bytes: number;
	quota_alert_month: string | null;
};

export type RelayApiDeps = {
	db: D1Database;
	now?: number;
	crypt?: Crypt;
	deliver?: Deliver;
	fetcher?: typeof fetch;
};

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}

function denied(code: string, status = 401) {
	return json({ ok: false, error: code }, status);
}

/** Verifies relay id, ±300 s timestamp and HMAC; returns the relay or a 4xx response. */
export async function authenticateRelay(
	request: Request,
	body: Uint8Array,
	deps: { db: D1Database; crypt: Crypt; now: number },
): Promise<RelayRow | Response> {
	const relayId = request.headers.get("x-ce-relay-id") ?? "";
	const timestamp = request.headers.get("x-ce-timestamp") ?? "";
	const signature = (request.headers.get("x-ce-signature") ?? "").toLowerCase();
	if (
		!/^[A-Za-z0-9_-]{1,32}$/.test(relayId) ||
		!/^\d{9,12}$/.test(timestamp) ||
		!/^[0-9a-f]{64}$/.test(signature)
	)
		return denied("relay_auth_invalid");
	if (
		Math.abs(Math.floor(deps.now / 1000) - Number(timestamp)) > relaySkewSeconds
	)
		return denied("relay_auth_expired");
	const relay = await deps.db
		.prepare(
			"SELECT id, hostname, secret_encrypted, status, monthly_quota_bytes, quota_alert_month FROM claude_env_relays WHERE id = ?",
		)
		.bind(relayId)
		.first<RelayRow>();
	if (!relay) return denied("relay_unknown");
	let secret: string;
	try {
		secret = await deps.crypt.decrypt(
			relay.secret_encrypted,
			secretPurpose.relaySecret,
		);
	} catch {
		return denied("relay_secret_unavailable", 503);
	}
	const url = new URL(request.url);
	const expected = await signRelayRequest({
		secret,
		method: request.method,
		path: url.pathname + url.search,
		timestamp,
		body,
	});
	if (!timingSafeEqualHex(expected, signature))
		return denied("relay_signature_invalid");
	if (relay.status !== "active") return denied("relay_disabled", 403);
	return relay;
}

export async function handleRelayApiRequest(
	request: Request,
	deps: RelayApiDeps,
): Promise<Response> {
	const url = new URL(request.url);
	const now = deps.now ?? Date.now();
	const route = url.pathname.slice(relayApiPrefix.length);
	if (
		!url.pathname.startsWith(relayApiPrefix) ||
		!(
			(route === "desired" && request.method === "GET") ||
			(route === "report" && request.method === "POST")
		)
	)
		return denied("not_found", 404);
	const declared = Number(request.headers.get("content-length") ?? "0");
	if (declared > maxBodyBytes) return denied("body_too_large", 413);
	const body = new Uint8Array(await request.arrayBuffer());
	if (body.byteLength > maxBodyBytes) return denied("body_too_large", 413);
	let crypt: Crypt;
	try {
		crypt = deps.crypt ?? (await loadCrypt(deps.db));
	} catch {
		return denied("relay_secret_unavailable", 503);
	}
	const relay = await authenticateRelay(request, body, {
		db: deps.db,
		crypt,
		now,
	});
	if (relay instanceof Response) return relay;
	if (route === "desired")
		return json(await buildDesired(deps.db, crypt, relay.id, now));
	let parsed: z.infer<typeof reportSchema>;
	try {
		parsed = reportSchema.parse(JSON.parse(new TextDecoder().decode(body)));
	} catch {
		return denied("report_invalid", 400);
	}
	if (parsed.relay_id !== relay.id) return denied("report_relay_mismatch", 400);
	await applyReport(deps, relay, parsed, now);
	return json({ ok: true });
}

type DesiredRow = {
	id: string;
	relay_port: number;
	relay_user: string;
	relay_pass_encrypted: string;
	ip: string;
	ip_port: number;
	ip_user_encrypted: string;
	ip_pass_encrypted: string;
	status: string;
};

export async function buildDesired(
	db: D1Database,
	crypt: Crypt,
	relayId: string,
	now: number,
) {
	const rows = await db
		.prepare(
			`SELECT id, relay_port, relay_user, relay_pass_encrypted, ip, ip_port,
			 ip_user_encrypted, ip_pass_encrypted, status
			 FROM claude_env_subscriptions
			 WHERE relay_id = ? AND status IN (${desiredStatuses.map(() => "?").join(",")})
			 AND relay_port IS NOT NULL AND relay_user IS NOT NULL AND relay_pass_encrypted IS NOT NULL
			 AND ip IS NOT NULL AND ip_port IS NOT NULL AND ip_user_encrypted IS NOT NULL AND ip_pass_encrypted IS NOT NULL
			 ORDER BY relay_port`,
		)
		.bind(relayId, ...desiredStatuses)
		.all<DesiredRow>();
	const customers = [];
	for (const row of rows.results)
		customers.push({
			id: row.id,
			port: row.relay_port,
			user: row.relay_user,
			pass: await crypt.decrypt(
				row.relay_pass_encrypted,
				secretPurpose.relayPass,
			),
			upstream: {
				ip: row.ip,
				port: row.ip_port,
				user: await crypt.decrypt(
					row.ip_user_encrypted,
					secretPurpose.upstreamUser,
				),
				pass: await crypt.decrypt(
					row.ip_pass_encrypted,
					secretPurpose.upstreamPass,
				),
			},
			status: row.status,
		});
	return {
		relay_id: relayId,
		generated_at: new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z"),
		customers,
	};
}

const subId = z.string().regex(/^[A-Za-z0-9_-]{1,32}$/);
const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const reportSchema = z.object({
	report_id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
	relay_id: z.string().regex(/^[A-Za-z0-9_-]{1,32}$/),
	at: z.string().max(64).optional(),
	results: z
		.array(
			z.object({
				id: subId,
				applied: z.boolean(),
				error: z.string().max(500).nullable().optional(),
				exit_ip: z.string().max(64).nullable().optional(),
				exit_ok: z.boolean().nullable().optional(),
				anthropic_status: z.number().int().nullable().optional(),
				// Relay-measured scamalytics score (provisioning only; older relays omit it).
				scam_score: z.number().int().min(0).max(100).nullable().optional(),
			}),
		)
		.max(2000)
		.default([]),
	traffic: z
		.array(z.object({ id: subId, up_bytes: bytes, down_bytes: bytes }))
		.max(2000)
		.default([]),
	host: z
		.object({
			month: z.string().regex(/^\d{4}-\d{2}$/),
			rx_bytes: bytes,
			tx_bytes: bytes,
		})
		.nullable()
		.optional(),
});
export type RelayReport = z.infer<typeof reportSchema>;

type SubState = {
	id: string;
	status: string;
	ip: string | null;
	activated_at: number | null;
	traffic_period_start: number | null;
	relay_check_fail_streak: number;
	apply_fail_streak: number;
	exit_fail_streak: number;
	patrol_alerted: number;
};

export async function applyReport(
	deps: RelayApiDeps,
	relay: Pick<RelayRow, "id" | "monthly_quota_bytes" | "quota_alert_month">,
	report: RelayReport,
	now: number,
) {
	const { db } = deps;
	const seen = await db
		.prepare("SELECT 1 AS seen FROM claude_env_reports WHERE report_id = ?")
		.bind(report.report_id)
		.first<{ seen: number }>();
	if (seen) return { duplicate: true, alerts: [] as string[] };
	// While the feature flag is off the relay keeps being served and its
	// traffic/heartbeat recorded, but nothing changes subscription states.
	const enabled =
		(
			await db
				.prepare("SELECT value FROM system_settings WHERE key = ?")
				.bind(claudeEnvSettingKeys.enabled)
				.first<{ value: string }>()
		)?.value === "true";
	const ids = [
		...new Set([
			...report.results.map((r) => r.id),
			...report.traffic.map((t) => t.id),
		]),
	];
	const subs = new Map<string, SubState>();
	for (let i = 0; i < ids.length; i += 50) {
		const chunk = ids.slice(i, i + 50);
		const rows = await db
			.prepare(
				`SELECT id, status, ip, activated_at, traffic_period_start, relay_check_fail_streak,
				 apply_fail_streak, exit_fail_streak, patrol_alerted FROM claude_env_subscriptions
				 WHERE relay_id = ? AND id IN (${chunk.map(() => "?").join(",")})`,
			)
			.bind(relay.id, ...chunk)
			.all<SubState>();
		for (const row of rows.results) subs.set(row.id, row);
	}
	const statements: D1PreparedStatement[] = [
		db
			.prepare(
				"INSERT INTO claude_env_reports (report_id, relay_id, received_at) VALUES (?, ?, ?)",
			)
			.bind(report.report_id, relay.id, now),
	];
	const alerts: Array<{
		subscriptionId: string;
		kind: "replace" | "patrol" | "apply";
		reason: string;
	}> = [];
	let massRemoveBlocked = 0;
	for (const result of report.results) {
		if (!result.applied && result.error?.startsWith("mass_remove_blocked"))
			massRemoveBlocked += 1;
		const sub = subs.get(result.id);
		if (!sub) continue;
		statements.push(
			db
				.prepare(
					`UPDATE claude_env_subscriptions SET last_check_at = ?, last_exit_ok = ?, last_exit_ip = ?,
					 last_anthropic_status = COALESCE(?, last_anthropic_status), last_apply_error = ?, updated_at = ?
					 WHERE id = ?`,
				)
				.bind(
					now,
					result.exit_ok === undefined || result.exit_ok === null
						? null
						: result.exit_ok
							? 1
							: 0,
					result.exit_ip ?? null,
					result.anthropic_status ?? null,
					result.applied ? null : (result.error ?? "apply_failed"),
					now,
					sub.id,
				),
		);
		if (enabled && sub.status === "provisioning" && !result.applied) {
			const streak = sub.apply_fail_streak + 1;
			statements.push(
				db
					.prepare(
						"UPDATE claude_env_subscriptions SET apply_fail_streak = ? WHERE id = ? AND status = 'provisioning'",
					)
					.bind(streak, sub.id),
			);
			if (streak === provisioningFailThreshold)
				alerts.push({
					subscriptionId: sub.id,
					kind: "apply",
					reason: `中转机连续 ${streak} 次没能加上这个客户：${result.error ?? "未知原因"}`,
				});
		}
		if (enabled && sub.status === "provisioning" && result.applied) {
			if (sub.apply_fail_streak)
				statements.push(
					db
						.prepare(
							"UPDATE claude_env_subscriptions SET apply_fail_streak = 0 WHERE id = ?",
						)
						.bind(sub.id),
				);
			if (result.scam_score !== undefined && result.scam_score !== null)
				statements.push(
					db
						.prepare(
							"UPDATE claude_env_subscriptions SET relay_scam_score = ? WHERE id = ? AND status = 'provisioning'",
						)
						.bind(result.scam_score, sub.id),
				);
			const ok =
				result.exit_ok === true &&
				(!result.exit_ip || result.exit_ip === sub.ip) &&
				result.anthropic_status === 401;
			if (ok)
				statements.push(
					db
						.prepare(
							"UPDATE claude_env_subscriptions SET relay_check_ok = 1, relay_check_fail_streak = 0, updated_at = ? WHERE id = ? AND status = 'provisioning'",
						)
						.bind(now, sub.id),
				);
			else {
				const streak = sub.relay_check_fail_streak + 1;
				const reason = `中转自测不通过：出口${result.exit_ok ? "正确" : `不对（${result.exit_ip ?? "无"}）`}，Anthropic 返回 ${result.anthropic_status ?? "无"}（应为 401）`;
				if (streak >= provisioningFailThreshold) {
					statements.push(
						db
							.prepare(
								"UPDATE claude_env_subscriptions SET status = 'needs_replace', relay_check_ok = 0, relay_check_fail_streak = ?, needs_replace_reason = ?, updated_at = ? WHERE id = ? AND status = 'provisioning'",
							)
							.bind(streak, reason, now, sub.id),
						eventStatement(db, sub.id, "needs_replace", reason, now),
					);
					alerts.push({ subscriptionId: sub.id, kind: "replace", reason });
				} else
					statements.push(
						db
							.prepare(
								"UPDATE claude_env_subscriptions SET relay_check_ok = 0, relay_check_fail_streak = ?, updated_at = ? WHERE id = ? AND status = 'provisioning'",
							)
							.bind(streak, now, sub.id),
					);
			}
		}
		if (
			enabled &&
			sub.status === "active" &&
			typeof result.exit_ok === "boolean"
		) {
			if (result.exit_ok)
				statements.push(
					db
						.prepare(
							"UPDATE claude_env_subscriptions SET exit_fail_streak = 0, patrol_alerted = 0 WHERE id = ?",
						)
						.bind(sub.id),
				);
			else {
				const streak = sub.exit_fail_streak + 1;
				const alert = streak >= patrolFailThreshold && !sub.patrol_alerted;
				statements.push(
					db
						.prepare(
							"UPDATE claude_env_subscriptions SET exit_fail_streak = ?, patrol_alerted = ? WHERE id = ?",
						)
						.bind(streak, alert || sub.patrol_alerted ? 1 : 0, sub.id),
				);
				if (alert)
					alerts.push({
						subscriptionId: sub.id,
						kind: "patrol",
						reason: `连续 ${streak} 次巡检出口不通（最近出口 ${result.exit_ip ?? "无"}${result.error ? `，${result.error}` : ""}）`,
					});
			}
		}
	}
	for (const entry of report.traffic) {
		const sub = subs.get(entry.id);
		if (!sub) continue;
		const delta = entry.up_bytes + entry.down_bytes;
		if (delta === 0) continue;
		if (sub.activated_at === null) {
			statements.push(
				db
					.prepare(
						"UPDATE claude_env_subscriptions SET traffic_total_bytes = traffic_total_bytes + ? WHERE id = ?",
					)
					.bind(delta, sub.id),
			);
			continue;
		}
		const start = trafficPeriodStart(sub.activated_at, now);
		statements.push(
			db
				.prepare(
					`UPDATE claude_env_subscriptions SET
					 traffic_period_bytes = CASE WHEN traffic_period_start = ? THEN traffic_period_bytes + ? ELSE ? END,
					 traffic_period_start = ?, traffic_total_bytes = traffic_total_bytes + ? WHERE id = ?`,
				)
				.bind(start, delta, delta, start, delta, sub.id),
		);
	}
	let quotaAlert: string | null = null;
	if (report.host) {
		const used = report.host.rx_bytes + report.host.tx_bytes;
		const crossed =
			relay.monthly_quota_bytes > 0 &&
			used >= relay.monthly_quota_bytes * 0.8 &&
			relay.quota_alert_month !== report.host.month;
		statements.push(
			db
				.prepare(
					`UPDATE claude_env_relays SET host_month = ?, host_rx_bytes = ?, host_tx_bytes = ?,
					 quota_alert_month = CASE WHEN ? THEN ? ELSE quota_alert_month END WHERE id = ?`,
				)
				.bind(
					report.host.month,
					report.host.rx_bytes,
					report.host.tx_bytes,
					crossed ? 1 : 0,
					report.host.month,
					relay.id,
				),
		);
		if (crossed)
			quotaAlert = `⚠️ 中转机 ${relay.id} 本月（${report.host.month}）流量已用 ${((used / relay.monthly_quota_bytes) * 100).toFixed(0)}%（${(used / 1e12).toFixed(2)} TB / ${(relay.monthly_quota_bytes / 1e12).toFixed(2)} TB）。请考虑加流量或加第二台中转机。`;
	}
	statements.push(
		db
			.prepare(
				"UPDATE claude_env_relays SET last_report_at = ?, offline_alerted_at = NULL, updated_at = ? WHERE id = ?",
			)
			.bind(now, now, relay.id),
	);
	await db.batch(statements);
	const deliver = deps.deliver ?? defaultDeliver(db, deps.fetcher ?? fetch);
	const texts: string[] = [];
	for (const alert of alerts) {
		const { text } = await subscriptionLabel(db, alert.subscriptionId);
		texts.push(
			alert.kind === "replace"
				? needsReplaceAlert(text, alert.reason)
				: alert.kind === "apply"
					? `⚠️ Claude 专属环境：中转机加不上客户\n${text}\n${alert.reason}\n请检查中转机（ce-relay / xray 日志）。`
					: `⚠️ Claude 专属环境线路不通\n${text}\n${alert.reason}\n系统不会自动换 IP，请人工检查（中转机/IPRoyal 后台）。`,
		);
	}
	if (quotaAlert) texts.push(quotaAlert);
	if (massRemoveBlocked > 0)
		await alertThrottled(
			db,
			deliver,
			`claude_env.alert.mass_remove.${relay.id}`,
			`⚠️ 中转机 ${relay.id} 拒绝了一次性删除 ${massRemoveBlocked} 个客户（大量删除保护）。请先在后台核对这些客户确实该停用，再在中转机上运行：CE_SYNC_ALLOW_MASS_REMOVE=1 ce-relay sync`,
			now,
			6 * 3_600_000,
		);
	for (const text of texts) await deliver(text).catch(() => undefined);
	return { duplicate: false, alerts: texts };
}
