import { reconcileAgentAccess } from "#/features/agent-access/server/fulfillment";
import { runWithdrawalAlerts } from "#/features/agent-program/server/withdrawal-alerts";
import { publishAuthSecurityAlert } from "#/features/auth/server/security-alerts";
import { publishPendingBuilds } from "#/features/builds/server/outbox";
import { reconcileIproyalOrders } from "#/features/claude-env/server/reconcile";
import { runClaudeEnv } from "#/features/claude-env/server/scheduler";
import { runCustomerPriceGuard } from "#/features/customer-pricing/server/telegram";
import { publishPendingDeliveries } from "#/features/fulfillment/server/outbox";
import { publishPendingNotifications } from "#/features/notifications/server/delivery";
import { fanOutPendingCommerceNotifications } from "#/features/notifications/server/fanout";
import { publishPendingOwnerSaleAlerts } from "#/features/notifications/server/owner-sale-alerts";
import { runBalanceGuard } from "#/features/ops-automation/server/balance-guard";
import { runPriceDropNotices } from "#/features/ops-automation/server/price-drop-notice";
import { runPricingGuard } from "#/features/ops-automation/server/pricing-guard";
import { runProcurementAlerts } from "#/features/ops-automation/server/procurement-alerts";
import { runWeeklyReport } from "#/features/ops-automation/server/weekly-report";
import { settlePromotionRewards } from "#/features/promotions/server/balance";
import {
	runBulkProcurements,
	topUpBulkCodeStock,
} from "#/features/redeem-warehouse/server/bulk-procurement";
import { runRedemptionExceptionTodos } from "#/features/redeem-warehouse/server/exception-todos";
import { runRenewalReminders } from "#/features/renewals/server/scheduler";
import { expireStoreOrders } from "#/features/shop-orders/server/expiration";
import { publishPendingRefunds } from "#/features/shop-payments/server/refunds";
import { reconcilePendingShopPayments } from "#/features/shop-payments/server/service";
import { publishPendingInventoryEvents } from "#/features/supplier-api/server/inventory-events";
import { publishPendingSupplierOrders } from "#/features/suppliers/server/outbox";
import { runTelegramMaintenance } from "#/features/telegram/server/maintenance";
import { ensureOwnerAlertWebhook } from "#/features/telegram/server/owner-actions";
import { runMaintenance } from "#/server/scheduled/maintenance";

export { runMaintenance };

export function handleScheduled(
	controller: ScheduledController,
	env: Env,
	context: ExecutionContext,
): void {
	context.waitUntil(
		runScheduledCommerceWork(env, controller.cron, controller.scheduledTime),
	);
}

export async function runScheduledCommerceWork(
	env: Env,
	cron: string,
	scheduledAt: number,
) {
	const agentAccess = await reconcileAgentAccess(env.DB);
	const publishBatchSize = await loadPublishBatchSize(env.DB);
	const payments = await reconcilePendingShopPayments(
		env.DB,
		fetch,
		scheduledAt,
	);
	const expired = await expireStoreOrders(env.DB, scheduledAt);
	const promotionRewards = await settlePromotionRewards(env.DB, scheduledAt);
	const deliveries = await publishPendingDeliveries(
		env.DB,
		env.COMMERCE_QUEUE,
		publishBatchSize,
	);
	const suppliers = await publishPendingSupplierOrders(
		env.DB,
		env.COMMERCE_QUEUE,
		publishBatchSize,
	);
	const inventoryEvents = await publishPendingInventoryEvents(
		env.DB,
		env.COMMERCE_QUEUE,
		publishBatchSize,
	);
	const ownerSaleAlerts = await publishPendingOwnerSaleAlerts({
		db: env.DB,
		limit: publishBatchSize,
		now: scheduledAt,
	});
	const builds = await publishPendingBuilds(
		env.DB,
		env.COMMERCE_QUEUE,
		publishBatchSize,
	);
	const refunds = await publishPendingRefunds(
		env.DB,
		env.COMMERCE_QUEUE,
		publishBatchSize,
	);
	const notificationEvents = await fanOutPendingCommerceNotifications(
		env.DB,
		publishBatchSize,
	);
	const notifications = await publishPendingNotifications(
		env.DB,
		env.COMMERCE_QUEUE,
		publishBatchSize,
	);
	const telegram = await runTelegramMaintenance(env.DB, scheduledAt);
	const ownerWebhook = await ensureOwnerAlertWebhook(env.DB, {
		now: scheduledAt,
	}).catch(() => ({ status: "failed" as const }));
	const maintenance = await runMaintenance(env, cron, undefined, scheduledAt);
	const securityAlert = await publishAuthSecurityAlert(
		env.DB,
		scheduledAt,
	).catch(() => ({ status: "failed" }));
	const bulkProcurements = await runBulkProcurements({
		db: env.DB,
		now: scheduledAt,
	}).catch(() => ({ status: "failed" as const }));
	const bulkCodeTopUp = await topUpBulkCodeStock({
		db: env.DB,
		now: scheduledAt,
	}).catch(() => ({ status: "failed" as const }));
	const redemptionExceptions = await runRedemptionExceptionTodos({
		db: env.DB,
	}).catch(() => ({ status: "failed", changed: 0, accepted: 0 }));
	// Renewal reminders are optional marketing work: they run last, with their
	// own D1 budget, so they can never delay or break the jobs above.
	const renewals = await runRenewalReminders(env.DB, {
		now: scheduledAt,
	}).catch(() => ({ status: "failed" as const }));
	// Owner automation (balance guard, pricing guard, weekly report): each is
	// off by default, self-throttled per Beijing period and isolated from the rest.
	const balanceGuard = await runBalanceGuard({
		db: env.DB,
		now: scheduledAt,
	}).catch(() => ({ status: "failed" as const }));
	const procurementAlerts = await runProcurementAlerts({
		db: env.DB,
		now: scheduledAt,
	}).catch(() => ({ status: "failed" as const }));
	const pricingGuard = await runPricingGuard({
		db: env.DB,
		now: scheduledAt,
	}).catch(() => ({ status: "failed" as const }));
	const priceDropNotices = await runPriceDropNotices({
		db: env.DB,
		files: env.FILES,
		now: scheduledAt,
	}).catch(() => ({ status: "failed" as const }));
	const customerPriceGuard = await runCustomerPriceGuard({
		db: env.DB,
		now: scheduledAt,
	}).catch(() => ({ status: "failed" as const }));
	const weeklyReport = await runWeeklyReport({
		db: env.DB,
		now: scheduledAt,
	}).catch(() => ({ status: "failed" as const }));
	const withdrawalAlerts = await runWithdrawalAlerts({
		db: env.DB,
		token: env.AGENT_SHOP_PROGRAM_TOKEN,
		now: scheduledAt,
	}).catch(() => ({ status: "failed" as const }));
	// Claude 专属环境 control center: idle unless claude_env.automation_enabled.
	const claudeEnv = await runClaudeEnv({
		db: env.DB,
		iproyalToken: env.IPROYAL_API_TOKEN,
		now: scheduledAt,
	}).catch(() => ({ status: "failed" as const }));
	// Every IPRoyal order must be known; runs even with the flag off (GET only,
	// at most every 10 minutes) so a purchase from anywhere is noticed.
	const iproyalReconcile = await reconcileIproyalOrders({
		db: env.DB,
		iproyalToken: env.IPROYAL_API_TOKEN,
		now: scheduledAt,
	}).catch(() => ({ status: "failed" as const }));
	// A Claude env activated in this tick queued its ready email after the
	// publish above ran; send it now instead of a minute later.
	if (
		"activated" in claudeEnv &&
		typeof claudeEnv.activated === "object" &&
		"activated" in claudeEnv.activated &&
		claudeEnv.activated.activated > 0
	)
		await publishPendingNotifications(
			env.DB,
			env.COMMERCE_QUEUE,
			publishBatchSize,
		).catch(() => undefined);
	return {
		claudeEnv,
		iproyalReconcile,
		balanceGuard,
		procurementAlerts,
		pricingGuard,
		priceDropNotices,
		customerPriceGuard,
		weeklyReport,
		withdrawalAlerts,
		agentAccess,
		promotionRewards,
		payments,
		redemptionExceptions,
		bulkProcurements,
		bulkCodeTopUp,
		expired,
		deliveries,
		suppliers,
		inventoryEvents,
		ownerSaleAlerts,
		builds,
		refunds,
		notificationEvents,
		renewals,
		notifications,
		telegram,
		ownerWebhook,
		maintenance,
		securityAlert,
	};
}

async function loadPublishBatchSize(db: D1Database) {
	const row = await db
		.prepare(
			"SELECT value FROM system_settings WHERE key = 'queue.publish_batch_size' LIMIT 1",
		)
		.first<{ value: string }>();
	if (!row) return 25;
	try {
		const value: unknown = JSON.parse(row.value);
		return typeof value === "number" && value >= 1 && value <= 100 ? value : 25;
	} catch {
		return 25;
	}
}
