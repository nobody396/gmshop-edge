import {
	type Deliver,
	fetchProcurementAlerts,
	formatYuan,
	loadSettings,
	type ProcurementAlerts,
	resolveDeliver,
	restockLabel,
	restockSources,
	settingStatement,
} from "./shared";

export const procurementAlertSettingKeys = {
	// On unless explicitly set to false: a failed restock must never go unnoticed.
	enabled: "ops.procurement_alerts.enabled",
	cursor: "ops.procurement_alerts.cursor",
} as const;

type Alert = ProcurementAlerts["alerts"][number];

function supplierName(source: string) {
	return (restockSources as readonly string[]).includes(source)
		? restockLabel[source as keyof typeof restockLabel]
		: source;
}

function waitingCodes(data: ProcurementAlerts, source: string) {
	return data.waiting
		.filter((row) => row.source === source && row.state === "waiting")
		.reduce((sum, row) => sum + row.codes, 0);
}

export function formatProcurementAlert(alert: Alert, data: ProcurementAlerts) {
	const supplier = supplierName(alert.source);
	const code = alert.code_suffix ? `卡密 …${alert.code_suffix}` : "一张卡密";
	if (alert.kind === "restocked")
		return `✅ 已自动补货：${alert.product_name}\n${code} 可以提交了（客户页面开着会自动继续，关了的话刷新再提交）`;
	if (alert.kind === "funds_needed") {
		const waiting = Math.max(1, waitingCodes(data, alert.source));
		const lines = [
			`⚠️ 进货失败：${supplier}余额不足`,
			`商品：${alert.product_name}（${code} 在等货）`,
		];
		if (alert.price_minor !== null && alert.balance_minor !== null) {
			const shortfall = alert.price_minor * waiting - alert.balance_minor;
			lines.push(
				`单价约 ${formatYuan(alert.price_minor)}，当前余额 ${formatYuan(alert.balance_minor)}${waiting > 1 ? `，共 ${waiting} 张在等` : ""}，至少还差 ${formatYuan(Math.max(1, shortfall))}`,
			);
		}
		lines.push(`给${supplier}充值后，系统每分钟自动补货，不用手动买。`);
		return lines.join("\n");
	}
	if (alert.kind === "needs_review")
		return [
			`⚠️ 进货结果不明，需要人工核对：${supplier}`,
			`商品：${alert.product_name}（${code} 在等货）`,
			`原因：${alert.reason ?? "未知"}`,
			"系统不会自动再买，避免重复扣钱；把这条转给 Claude 核对。",
		].join("\n");
	return [
		`⚠️ 进货被拒：${supplier}`,
		`商品：${alert.product_name}（${code} 在等货）`,
		`原因：${alert.reason ?? "未知"}`,
		"系统每 10 分钟自动重试；一直不行就把这条转给 Claude。",
	].join("\n");
}

/** Every minute: relays new warehouse procurement alerts to the owner. The cursor only moves after
 * a successful send, so an outage delays alerts but never drops them. */
export async function runProcurementAlerts(input: {
	db: D1Database;
	now?: number;
	fetcher?: typeof fetch;
	deliver?: Deliver;
	read?: (after: number) => Promise<ProcurementAlerts>;
}) {
	const now = input.now ?? Date.now();
	const fetcher = input.fetcher ?? fetch;
	const settings = await loadSettings(input.db, [
		procurementAlertSettingKeys.enabled,
		procurementAlertSettingKeys.cursor,
	]);
	if (settings.get(procurementAlertSettingKeys.enabled) === false)
		return { status: "disabled" as const };
	const stored = settings.get(procurementAlertSettingKeys.cursor);
	const after =
		typeof stored === "number" && Number.isSafeInteger(stored) && stored > 0
			? stored
			: 0;
	const data = await (
		input.read ??
		((cursor) => fetchProcurementAlerts(input.db, cursor, fetcher))
	)(after);
	if (data.alerts.length === 0) return { status: "ok" as const, sent: 0 };
	const deliver = resolveDeliver(
		input.db,
		fetcher,
		input.deliver,
		`ops-procurement-${after}`,
		now,
	);
	await deliver(
		data.alerts
			.map((alert) => formatProcurementAlert(alert, data))
			.join("\n\n"),
	);
	await settingStatement(
		input.db,
		procurementAlertSettingKeys.cursor,
		Math.max(...data.alerts.map((alert) => alert.id)),
		now,
	).run();
	return { status: "sent" as const, sent: data.alerts.length };
}
