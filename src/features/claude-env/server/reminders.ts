import {
	beijingMinute,
	dayMs,
	daysLeft,
	dueReminderPoint,
	maskEmail,
	ownerReminderPoint,
	reminderPoints,
} from "../domain";
import {
	type ExpiryEmailInput,
	enqueueClaudeEnvExpiryEmail,
	type SendExpiryEmail,
} from "./customer-email";
import { type Deliver, eventStatement } from "./shared";

type Candidate = {
	id: string;
	user_id: string;
	plan: string;
	ip: string | null;
	expires_at: number;
	account_email: string | null;
	subscription_email: string;
	contact_email: string | null;
	order_locale: string | null;
};

/**
 * Customer expiry reminders at expires_at − 7 / 5 / 3 days, active
 * subscriptions only. A row in claude_env_reminders (unique per subscription,
 * expires_at and point) is claimed before anything is sent, so overlapping
 * cron runs never send twice. Renewal moves expires_at: the old date's
 * reminders no longer match and the new date's points apply.
 */
export async function sendExpiryReminders(input: {
	db: D1Database;
	now: number;
	deliver: Deliver;
	sendEmail?: SendExpiryEmail;
}) {
	const { db, now } = input;
	const sendEmail = input.sendEmail ?? enqueueClaudeEnvExpiryEmail;
	const maxPoint = Math.max(...reminderPoints);
	const rows = await db
		.prepare(
			`SELECT s.id, s.user_id, s.plan, s.ip, s.expires_at, u.email AS account_email, s.email AS subscription_email,
			 o.normalized_contact_email AS contact_email, o.locale AS order_locale
			 FROM claude_env_subscriptions s
			 LEFT JOIN users u ON u.id = s.user_id
			 LEFT JOIN shop_orders o ON o.id = s.order_id
			 WHERE s.status = 'active' AND s.expires_at IS NOT NULL AND s.expires_at > ? AND s.expires_at <= ?
			 ORDER BY s.expires_at LIMIT 50`,
		)
		.bind(now, now + maxPoint * dayMs)
		.all<Candidate>();
	const outcome = { sent: 0, skipped: 0, failed: 0, owner: 0 };
	for (const row of rows.results) {
		const point = dueReminderPoint(row.expires_at, now);
		if (point === null) continue;
		// IPRoyal re-reads may move expires_at by seconds; a point already sent
		// for (almost) the same date is not repeated. Renewals move it by ≥30 days.
		const sentNearby = await db
			.prepare(
				"SELECT 1 AS found FROM claude_env_reminders WHERE subscription_id = ? AND point = ? AND ABS(expires_at - ?) < ? LIMIT 1",
			)
			.bind(row.id, point, row.expires_at, dayMs)
			.first<{ found: number }>();
		if (sentNearby) continue;
		const n = daysLeft(row.expires_at, now);
		// users.preferred_locale is NOT NULL DEFAULT 'en-US' and cannot tell an
		// English buyer apart; the order's storefront locale can.
		const locale =
			row.order_locale === "en-US" ? ("en-US" as const) : ("zh-CN" as const);
		const reminderId = crypto.randomUUID();
		const claim = await db
			.prepare(
				`INSERT INTO claude_env_reminders (id, subscription_id, expires_at, point, days_left, locale, status, owner_alerted, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, 'sending', 0, ?, ?)
				 ON CONFLICT (subscription_id, expires_at, point) DO NOTHING`,
			)
			.bind(reminderId, row.id, row.expires_at, point, n, locale, now, now)
			.run();
		if (Number(claim.meta.changes ?? 0) !== 1) continue;

		const accountEmail = (row.account_email ?? row.subscription_email)
			.trim()
			.toLowerCase();
		const recipients: Array<{ to: string; kind: "account" | "order" }> = [
			{ to: accountEmail, kind: "account" },
		];
		const contact = row.contact_email?.trim().toLowerCase();
		if (contact && contact !== accountEmail)
			recipients.push({ to: contact, kind: "order" });
		const results: Array<Record<string, string>> = [];
		for (const recipient of recipients) {
			const email: ExpiryEmailInput = {
				subscriptionId: row.id,
				userId: row.user_id,
				to: recipient.to,
				recipientKind: recipient.kind,
				point,
				daysLeft: n,
				expiresAt: row.expires_at,
				plan: row.plan,
				locale,
			};
			try {
				const result = await sendEmail(db, email);
				results.push({
					recipient: recipient.kind,
					status: result.status,
					...(result.reason ? { reason: result.reason } : {}),
					...(result.deliveryId ? { deliveryId: result.deliveryId } : {}),
				});
			} catch (error) {
				results.push({
					recipient: recipient.kind,
					status: "failed",
					reason:
						error instanceof Error ? error.message.slice(0, 120) : "error",
				});
			}
		}
		const status = results.some((r) => r.status === "queued")
			? "sent"
			: results.some((r) => r.status === "failed")
				? "failed"
				: "skipped";
		outcome[status] += 1;

		let ownerAlerted = 0;
		if (point === ownerReminderPoint) {
			await input
				.deliver(
					[
						`⏰ Claude 专属环境还有 ${n} 天到期（客户还没续费）`,
						`客户 ${maskEmail(accountEmail)}｜IP ${row.ip ?? "?"}`,
						`到期 ${beijingMinute(row.expires_at)} 北京时间`,
						"可以在微信提醒客户续费；不续费到期立即停用，IP 释放后无法找回。",
					].join("\n"),
				)
				.catch(() => undefined);
			ownerAlerted = 1;
			outcome.owner += 1;
		}
		await db.batch([
			db
				.prepare(
					"UPDATE claude_env_reminders SET status = ?, detail = ?, owner_alerted = ?, updated_at = ? WHERE id = ?",
				)
				.bind(status, JSON.stringify(results), ownerAlerted, now, reminderId),
			eventStatement(
				db,
				row.id,
				"expiry_reminder",
				`${point} 天提醒（剩 ${n} 天）：${results.map((r) => `${r.recipient}=${r.status}${r.reason ? `(${r.reason})` : ""}`).join("，")}`,
				now,
			),
		]);
	}
	return outcome;
}
