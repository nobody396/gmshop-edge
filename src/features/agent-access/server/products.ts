import { agentAccessProducts, agentAccessRefundPolicy } from "../products";
// Explicit administrator action, never a startup migration or automatic listing.
export async function prepareAgentProducts(db: D1Database) {
	const now = Date.now();
	const statements: D1PreparedStatement[] = [];
	for (const p of Object.values(agentAccessProducts)) {
		statements.push(
			db
				.prepare(
					`INSERT INTO products(id,name,description,product_type,status,created_at,updated_at) VALUES (?,?,?,'automation','draft',?,?) ON CONFLICT(id) DO NOTHING`,
				)
				.bind(
					p.productId,
					p.name,
					p === agentAccessProducts.subsite
						? "3 个月一期，不含采购余额。仅本人购买，需验证邮箱。付款后自动开通，账号及教程在订单页领取；已有分站再次购买即续费 3 个月。"
						: "一次性开通，不含采购余额。仅本人购买，需验证邮箱。付款后自动开通，账号及教程在订单页领取。已有同种资格请勿重复购买。",
					now,
					now,
				),
		);
		statements.push(
			db
				.prepare(
					`INSERT INTO product_sellable_items(id,product_id,name,price_minor,currency,currency_decimals,renewal_mode,email_mode,allow_resend,minimum_quantity,maximum_quantity,maximum_per_customer,policy_json,created_at,updated_at) VALUES (?,?,? ,?,'CNY',2,'disabled','none',0,1,1,?,?,?,?) ON CONFLICT(id) DO NOTHING`,
				)
				.bind(
					p.itemId,
					p.productId,
					p === agentAccessProducts.subsite ? "3个月" : "一次性开通",
					p.priceMinor,
					// Sub-sites are bought again to renew; one live order at a
					// time is still enforced by agent_access_orders.active_key.
					p === agentAccessProducts.subsite ? null : 1,
					JSON.stringify({
						delivery: "付款后自动开通",
						deliveryTime: "订单页显示实时进度，异常自动重试或转售后处理",
						coverage:
							p === agentAccessProducts.subsite
								? "3 个月有效期，到期前邮件提醒；再次购买自动续费 3 个月；到期未续费暂停接单；不含采购余额"
								: "一次性资格，不设到期时间；不含采购余额",
						warranty: agentAccessRefundPolicy["zh-CN"],
						restrictions:
							p === agentAccessProducts.subsite
								? "仅本人购买，需验证身份；续费请用开通时的同一账号"
								: "仅本人购买，需验证身份；已有同种资格无需重复购买",
					}),
					now,
					now,
				),
		);
	}
	await db.batch(statements);
	return { prepared: true, published: false };
}
