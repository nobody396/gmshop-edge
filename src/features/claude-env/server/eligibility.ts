/** Add-on eligibility: a signed-in buyer with an active, unexpired subscription. */
export async function activeClaudeEnvSubscription(
	db: D1Database,
	userId: string,
	now: number,
) {
	return db
		.prepare(
			`SELECT id, email, activated_at, iproyal_order_id, ip FROM claude_env_subscriptions
			 WHERE user_id = ? AND status = 'active' AND activated_at IS NOT NULL
			 AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at DESC LIMIT 1`,
		)
		.bind(userId, now)
		.first<{
			id: string;
			email: string;
			activated_at: number;
			iproyal_order_id: string | null;
			ip: string | null;
		}>();
}
