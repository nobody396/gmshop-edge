import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { systemPermission } from "#/features/access/system-rbac";
import { DomainError } from "#/lib/domain-error";
import { createAuditStatement } from "#/server/audit";
import { getAdminServerContext } from "#/server/context";
import { promotionBudgets } from "../pricing";
import { issueRecallCoupon } from "./coupons";

export const listPromotionSkusFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const { db } = await getAdminServerContext(
			systemPermission("products", "read"),
		);
		return (
			await db.$client
				.prepare(`SELECT i.id,i.name,i.promotion_budget_minor,i.currency,i.price_minor FROM product_sellable_items i
  JOIN products p ON p.id=i.product_id WHERE p.status='active' AND i.enabled=1 ORDER BY p.sort_order,p.name,i.sort_order,i.name`)
				.all<{
					id: string;
					name: string;
					promotion_budget_minor: string;
					currency: string;
					price_minor: string;
				}>()
		).results;
	},
);
const budgetSchema = z.object({
	id: z.uuid(),
	budgetMinor: z.enum(promotionBudgets),
});
export const setPromotionBudgetFn = createServerFn({ method: "POST" })
	.validator((value: z.input<typeof budgetSchema>) => budgetSchema.parse(value))
	.handler(async ({ data }) => {
		const { db, currentUser, request } = await getAdminServerContext(
			systemPermission("products", "update"),
		);
		const item = await db.$client
			.prepare(
				"SELECT currency,currency_decimals,price_minor FROM product_sellable_items WHERE id=?",
			)
			.bind(data.id)
			.first<{
				currency: string;
				currency_decimals: number;
				price_minor: string;
			}>();
		if (!item || item.currency !== "CNY" || item.currency_decimals !== 2)
			throw new DomainError(
				"promotion_configuration_invalid",
				409,
				"Only CNY SKUs can participate",
			);
		if (data.budgetMinor === "800" && BigInt(item.price_minor) < 100000n)
			throw new DomainError(
				"promotion_configuration_invalid",
				409,
				"The eight-yuan tier requires a base price of at least CNY 1000",
			);
		await db.$client.batch([
			db.$client
				.prepare(
					`UPDATE product_sellable_items SET promotion_budget_minor=?,version=version+1,updated_at=? WHERE id=? AND currency='CNY' AND currency_decimals=2`,
				)
				.bind(data.budgetMinor, Date.now(), data.id),
			createAuditStatement(db.$client, request, currentUser.id, {
				action: "promotion.budget_updated",
				targetType: "sellable_item",
				targetId: data.id,
				after: { budgetMinor: data.budgetMinor },
			}),
		]);
		return { updated: true };
	});
const campaignSchema = z.object({
	campaignKey: z.string().trim().min(1).max(80),
	userIds: z.array(z.uuid()).min(1).max(100),
	startsAt: z.number().int().positive(),
});
export const previewRecallRecipientsFn = createServerFn({
	method: "GET",
}).handler(async () => {
	const { db } = await getAdminServerContext(
		systemPermission("customers", "read"),
	);
	await getAdminServerContext(systemPermission("coupons", "create"));
	return (
		await db.$client
			.prepare(`SELECT u.id,u.email,MAX(o.paid_at) AS last_paid_at FROM users u JOIN shop_orders o ON o.user_id=u.id
  WHERE u.enabled=1 AND u.email_verified=1 AND u.marketing_consent=1 AND o.status IN ('paid','fulfilling','completed')
  GROUP BY u.id,u.email HAVING MAX(o.paid_at)<? ORDER BY last_paid_at LIMIT 100`)
			.bind(Date.now() - 30 * 86400000)
			.all<{ id: string; email: string; last_paid_at: number }>()
	).results;
});
export const issueRecallCouponsFn = createServerFn({ method: "POST" })
	.validator((value: z.input<typeof campaignSchema>) =>
		campaignSchema.parse(value),
	)
	.handler(async ({ data }) => {
		const { db, currentUser, request } = await getAdminServerContext(
			systemPermission("coupons", "create"),
		);
		await getAdminServerContext(systemPermission("customers", "read"));
		const result = [];
		for (const userId of [...new Set(data.userIds)]) {
			const row = await issueRecallCoupon(db.$client, {
				userId,
				campaignKey: data.campaignKey,
				startsAt: data.startsAt,
			});
			if (row) {
				result.push({ userId, ...row });
				await createAuditStatement(db.$client, request, currentUser.id, {
					action: "promotion.recall_issued",
					targetType: "coupon",
					targetId: row.id,
					after: { campaignKey: data.campaignKey, userId },
				}).run();
			}
		}
		return result;
	});
