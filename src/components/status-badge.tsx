import { Badge } from "#/components/ui/badge";
import { m } from "#/paraglide/messages";

const successful = new Set([
	"paid",
	"overpaid",
	"confirmed",
	"succeeded",
	"delivered",
	"resolved",
	"active",
]);
const destructive = new Set([
	"failed",
	"dead",
	"expired",
	"cancelled",
	"rejected",
	"bounced",
	"suppressed",
]);

export function StatusBadge({ value }: { value: string }) {
	return (
		<Badge
			variant={
				successful.has(value)
					? "default"
					: destructive.has(value)
						? "destructive"
						: "secondary"
			}
		>
			{statusLabel(value)}
		</Badge>
	);
}

export function statusLabel(value: string) {
	const labels: Record<string, string> = {
		accepted: m.notifications_status_accepted(),
		bounced: m.notifications_status_bounced(),
		suppressed: m.notifications_status_suppressed(),
		pending: m.status_pending(),
		confirming: m.status_confirming(),
		paid: m.status_paid(),
		partially_paid: m.status_partially_paid(),
		overpaid: m.status_overpaid(),
		expired: m.status_expired(),
		cancelled: m.status_cancelled(),
		failed: m.status_failed(),
		refunded: m.status_refunded(),
		detected: m.status_detected(),
		confirmed: m.status_confirmed(),
		succeeded: m.status_succeeded(),
		queued: m.status_queued(),
		received: m.status_received(),
		processing: m.status_processing(),
		ignored: m.status_ignored(),
		ambiguous: m.status_ambiguous(),
		retrying: m.status_retrying(),
		dead: m.status_stopped(),
		rejected: m.status_rejected(),
		created: m.status_created(),
		awaiting_supply: m.status_awaiting_supply(),
		delivered: m.status_delivered(),
		dispatching: m.status_dispatching(),
		running: m.status_running(),
		open: m.status_open(),
		resolved: m.status_resolved(),
		closed: m.status_closed(),
		active: m.status_active(),
		exhausted: m.status_exhausted(),
		revoked: m.status_revoked(),
		sending: m.status_sending(),
	};
	return labels[value] ?? m.status_unknown();
}
