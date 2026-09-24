import { z } from "zod";
import { recipientHash } from "./recipient-policy";

export const cloudflareEmailEventSchema = z.object({
	datetime: z.iso.datetime(),
	from: z.string(),
	to: z.string(),
	messageId: z.string(),
	status: z.string(),
	errorCause: z.string(),
	errorDetail: z.string(),
	isLastEvent: z.union([z.boolean(), z.number().int().min(0).max(1)]),
});
export type CloudflareEmailEvent = z.infer<typeof cloudflareEmailEventSchema>;
export type DeliveryEvidenceRow = {
	id: string;
	status: string;
	provider_message_id: string;
	accepted_at: number | null;
	created_at: number;
	provider_event_at: number | null;
	from_address: string;
};
export type DeliveryEvidencePlan = {
	id: string;
	messageId: string;
	status: "delivered" | "bounced" | "rejected";
	previousStatus: string;
	previousEventAt: number | null;
	occurredAt: number;
	errorCode: string | null;
	recipientHash: string;
	suppress: boolean;
};

function address(value: string) {
	return (value.match(/<([^<>]+)>$/)?.[1] ?? value).trim().toLowerCase();
}

// Only final events tied to this exact message, sender, recipient and time can
// change delivery evidence. Retry events and missing evidence never mean failure.
export async function planDeliveryEvidence(
	row: DeliveryEvidenceRow,
	to: string,
	events: CloudflareEmailEvent[],
	now = Date.now(),
): Promise<DeliveryEvidencePlan | null> {
	if (!["accepted", "delivered", "bounced", "rejected"].includes(row.status))
		return null;
	const matches = events
		.filter(
			(event) =>
				event.messageId === row.provider_message_id &&
				Boolean(event.isLastEvent) &&
				address(event.to) === address(to) &&
				address(event.from) === address(row.from_address) &&
				Date.parse(event.datetime) >=
					(row.accepted_at ?? row.created_at) - 60_000 &&
				Date.parse(event.datetime) <= now + 60_000 &&
				["delivered", "deliveryFailed", "spamRejection", "rejected"].includes(
					event.status,
				),
		)
		.sort((a, b) => Date.parse(b.datetime) - Date.parse(a.datetime));
	const latest = matches[0];
	if (!latest) return null;
	if (new Set(matches.map((event) => event.status)).size > 1)
		throw new Error("Conflicting final email evidence");
	const occurredAt = Date.parse(latest.datetime);
	if (row.provider_event_at != null && row.provider_event_at >= occurredAt)
		return null;
	const status =
		latest.status === "delivered"
			? "delivered"
			: latest.status === "deliveryFailed"
				? "bounced"
				: "rejected";
	if (row.status !== "accepted" && row.status !== status)
		throw new Error("Conflicting stored final email evidence");
	const cause = /^[a-z_]{1,80}$/.test(latest.errorCause)
		? latest.errorCause
		: "delivery_failed";
	return {
		id: row.id,
		messageId: row.provider_message_id,
		status,
		previousStatus: row.status,
		previousEventAt: row.provider_event_at,
		occurredAt,
		errorCode: status === "delivered" ? null : `provider_${cause}`,
		recipientHash: await recipientHash(to),
		// Do not permanently suppress temporary mailbox-full, sender-policy, or
		// transport failures. Only explicit nonexistent recipient/domain evidence.
		suppress:
			status === "bounced" &&
			(cause === "mailbox_gmail_unknown" ||
				cause === "upstream_no_psl_domain" ||
				/recipient domain does not accept email \(Null MX\)/.test(
					latest.errorDetail,
				)),
	};
}

// The same SQL is used by the owner-local reconciler and D1 integration tests.
// Does not enqueue mail, reset attempt counts, or touch entitlement/access state.
export function deliveryEvidenceStatements(plan: DeliveryEvidencePlan) {
	const statements: Array<{ sql: string; params: (string | number | null)[] }> =
		[];
	if (plan.suppress)
		statements.push({
			sql: `INSERT INTO email_recipient_suppressions (recipient_hash, reason, source_delivery_id, created_at)
		 SELECT ?, ?, id, ? FROM notification_deliveries
		 WHERE id = ? AND provider_message_id = ? AND status = ? AND provider_event_at IS ?
		 ON CONFLICT(recipient_hash) DO NOTHING`,
			params: [
				plan.recipientHash,
				plan.errorCode,
				plan.occurredAt,
				plan.id,
				plan.messageId,
				plan.previousStatus,
				plan.previousEventAt,
			],
		});
	statements.push({
		sql: `UPDATE notification_deliveries SET status = ?, provider_event_at = ?, delivered_at = ?, error_code = ?, next_attempt_at = NULL, updated_at = ?
		 WHERE id = ? AND provider_message_id = ? AND status = ? AND provider_event_at IS ?`,
		params: [
			plan.status,
			plan.occurredAt,
			plan.status === "delivered" ? plan.occurredAt : null,
			plan.errorCode,
			Date.now(),
			plan.id,
			plan.messageId,
			plan.previousStatus,
			plan.previousEventAt,
		],
	});
	return statements;
}
