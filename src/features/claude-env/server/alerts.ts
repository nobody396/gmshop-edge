import { displayCity, maskEmail } from "../domain";

type LabelRow = {
	id: string;
	email: string;
	ip: string | null;
	ip_city: string | null;
	iproyal_order_id: string | null;
	order_number: string | null;
};

/** Owner-facing one-liner: order number, masked email, IP and city. */
export async function subscriptionLabel(
	db: D1Database,
	subscriptionId: string,
) {
	const row = await db
		.prepare(
			`SELECT s.id, s.email, s.ip, s.ip_city, s.iproyal_order_id, o.order_number
			 FROM claude_env_subscriptions s LEFT JOIN shop_orders o ON o.id = s.order_id
			 WHERE s.id = ?`,
		)
		.bind(subscriptionId)
		.first<LabelRow>();
	if (!row) return { text: subscriptionId, row: null };
	return { text: formatLabel(row), row };
}

export function formatLabel(row: LabelRow) {
	return [
		`订单 ${row.order_number ?? "?"}`,
		`客户 ${maskEmail(row.email)}`,
		row.ip
			? `IP ${row.ip}${row.ip_city ? `（${displayCity(row.ip_city)}）` : ""}`
			: null,
		row.iproyal_order_id ? `IPRoyal 订单 ${row.iproyal_order_id}` : null,
		`订阅 ${row.id}`,
	]
		.filter(Boolean)
		.join("｜");
}

export function needsReplaceAlert(label: string, reason: string) {
	return [
		"⚠️ Claude 专属环境：IP 质检不合格",
		label,
		`原因：${reason}`,
		"请 24 小时内找 IPRoyal 客服换 IP（系统不会自动换）。换好后在后台「Claude 专属环境」里填新 IP 信息，系统会重新质检并自动发货。",
	].join("\n");
}
