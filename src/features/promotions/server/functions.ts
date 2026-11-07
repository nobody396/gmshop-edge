import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { requireStorefrontPermission } from "#/features/access/storefront-access";
import { resolveStoreAccount } from "#/features/storefront/server/account";
import { quoteStoreCouponForVisitor } from "#/features/storefront/server/multi-order";
import { getDb } from "#/server/db.server";
import { splitReferralBudget } from "../pricing";
import { openReferralCoupon } from "./coupons";

export const getPromotionAccountFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const request = getRequest(),
			db = getDb(request).$client;
		const account = await resolveStoreAccount(db, request, { required: true });
		const id = account?.user.id ?? "";
		const user = await db
			.prepare(
				"SELECT reward_balance_minor,marketing_consent FROM users WHERE id=?",
			)
			.bind(id)
			.first<{ reward_balance_minor: string; marketing_consent: number }>();
		const referral = await db
			.prepare(
				"SELECT code,enabled FROM coupons WHERE purpose='referral' AND referrer_user_id=?",
			)
			.bind(id)
			.first<{ code: string; enabled: number }>();
		const rewards = await db
			.prepare(`SELECT r.order_id,r.amount_minor,r.remaining_minor,r.state,r.available_at,r.created_at FROM promotion_rewards r
  WHERE r.user_id=? ORDER BY r.created_at DESC,r.order_id DESC LIMIT 100`)
			.bind(id)
			.all<{
				order_id: string;
				amount_minor: string;
				remaining_minor: string;
				state: string;
				available_at: number | null;
				created_at: number;
			}>();
		const coupons = await db
			.prepare(`SELECT code,ends_at,used_count FROM coupons WHERE purpose='recall' AND recipient_user_id=? AND enabled=1
  AND ends_at>? AND used_count=0 ORDER BY ends_at LIMIT 30`)
			.bind(id, Date.now())
			.all<{ code: string; ends_at: number; used_count: number }>();
		const entries = await db
			.prepare(
				"SELECT id,delta_minor,balance_after_minor,source_type,created_at FROM reward_entries WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 100",
			)
			.bind(id)
			.all<{
				id: string;
				delta_minor: string;
				balance_after_minor: string;
				source_type: string;
				created_at: number;
			}>();
		// Biggest current invitation amounts, so customers see what a share is worth.
		const examples = await db
			.prepare(`SELECT p.name AS product_name, i.name AS item_name, i.referral_budget_minor
  FROM product_sellable_items i JOIN products p ON p.id=i.product_id
  WHERE p.status='active' AND p.sale_disabled=0 AND i.enabled=1 AND i.sale_disabled=0
   AND i.currency='CNY' AND i.promotion_budget_minor<>'0' AND CAST(i.referral_budget_minor AS INTEGER)>0
  ORDER BY CAST(i.referral_budget_minor AS INTEGER) DESC, p.sort_order, i.sort_order LIMIT 8`)
			.all<{
				product_name: string;
				item_name: string;
				referral_budget_minor: string;
			}>();
		return {
			examples: examples.results.map((row) => {
				const split = splitReferralBudget(BigInt(row.referral_budget_minor));
				// "Premium｜1年" alone is ambiguous; prefix the product unless the name already says it.
				const brand = row.product_name.split(/[\s｜]/)[0] ?? "";
				return {
					name:
						brand && !row.item_name.includes(brand)
							? `${row.product_name.split("｜")[0]} · ${row.item_name}`
							: row.item_name,
					discountMinor: split.discount.toString(),
					rewardMinor: split.reward.toString(),
				};
			}),
			balanceMinor: user?.reward_balance_minor ?? "0",
			marketingConsent: user?.marketing_consent === 1,
			referral,
			rewards: rewards.results,
			coupons: coupons.results,
			entries: entries.results,
		};
	},
);
export const openReferralFn = createServerFn({ method: "POST" }).handler(
	async () => {
		const request = getRequest(),
			db = getDb(request).$client;
		const account = await resolveStoreAccount(db, request, { required: true });
		requireStorefrontPermission("customer", "checkout.create");
		return openReferralCoupon(db, account?.user.id ?? "");
	},
);
export const setMarketingConsentFn = createServerFn({ method: "POST" })
	.validator((value: { enabled: boolean }) =>
		z.object({ enabled: z.boolean() }).parse(value),
	)
	.handler(async ({ data }) => {
		const request = getRequest(),
			db = getDb(request).$client;
		const account = await resolveStoreAccount(db, request, { required: true });
		await db
			.prepare("UPDATE users SET marketing_consent=?,updated_at=? WHERE id=?")
			.bind(data.enabled ? 1 : 0, Date.now(), account?.user.id ?? "")
			.run();
		return { enabled: data.enabled };
	});

const quoteSchema = z.object({
	code: z.string().trim().toUpperCase().min(1).max(64),
	email: z.email().nullable().default(null),
	channelId: z.uuid().nullable().default(null),
	items: z
		.array(
			z.object({ id: z.uuid(), quantity: z.number().int().min(1).max(1000) }),
		)
		.min(1)
		.max(100)
		.refine((items) => new Set(items.map((i) => i.id)).size === items.length),
});
export const quotePromotionFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof quoteSchema>) => quoteSchema.parse(input))
	.handler(async ({ data }) => {
		requireStorefrontPermission("guest", "catalog.read");
		const request = getRequest(),
			db = getDb(request).$client,
			account = await resolveStoreAccount(db, request);
		return quoteStoreCouponForVisitor(
			db,
			request.headers.get("cf-connecting-ip"),
			data.code,
			data.items,
			{
				userId: account?.user.id,
				normalizedEmail: account?.user.email ?? data.email,
			},
			data.channelId ?? undefined,
		);
	});
