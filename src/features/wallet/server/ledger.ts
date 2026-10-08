import { DomainError } from "#/lib/domain-error";
import { walletAmountSchema } from "../schema";

export type WalletMutation = {
	userId: string;
	direction: "credit" | "debit";
	amountMinor: string;
	currency: string;
	sourceType:
		| "topup"
		| "adjustment"
		| "shop_order"
		| "supplier_order"
		| "refund";
	sourceId: string;
	idempotencyKey: string;
	reason?: string | null;
	actorUserId?: string | null;
};

export async function mutateWallet(db: D1Database, input: WalletMutation) {
	const amount = BigInt(walletAmountSchema.parse(input.amountMinor));
	if (amount === 0n)
		throw new DomainError(
			"wallet_amount_invalid",
			400,
			"Amount must be positive",
		);
	const replay = await findEntry(db, input.idempotencyKey);
	if (replay) return { ...replay, duplicate: true as const };
	for (let attempt = 0; attempt < 4; attempt += 1) {
		const user = await db
			.prepare(
				"SELECT balance_minor, balance_version FROM users WHERE id = ? AND enabled = 1 LIMIT 1",
			)
			.bind(input.userId)
			.first<{ balance_minor: string; balance_version: number }>();
		if (!user)
			throw new DomainError("wallet_user_not_found", 404, "User not found");
		const before = BigInt(user.balance_minor);
		if (input.direction === "debit" && before < amount)
			throw new DomainError(
				"wallet_insufficient_balance",
				409,
				"Insufficient balance",
			);
		const after =
			input.direction === "credit" ? before + amount : before - amount;
		if (after > 9_223_372_036_854_775_807n)
			throw new DomainError(
				"wallet_balance_limit",
				409,
				"Balance limit exceeded",
			);
		const now = Date.now();
		const entryId = crypto.randomUUID();
		const nextVersion = user.balance_version + 1;
		try {
			const results = await db.batch([
				db
					.prepare(
						`UPDATE users SET balance_minor = ?, balance_version = ?, updated_at = ?
						 WHERE id = ? AND enabled = 1 AND balance_version = ?`,
					)
					.bind(
						after.toString(),
						nextVersion,
						now,
						input.userId,
						user.balance_version,
					),
				db
					.prepare(
						`INSERT INTO wallet_entries
						 (id, user_id, direction, amount_minor, balance_before_minor,
						  balance_after_minor, currency, source_type, source_id,
						  idempotency_key, reason, actor_user_id, created_at)
						 SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
						 FROM users WHERE id = ? AND balance_version = ? AND changes() = 1`,
					)
					.bind(
						entryId,
						input.userId,
						input.direction,
						amount.toString(),
						before.toString(),
						after.toString(),
						input.currency,
						input.sourceType,
						input.sourceId,
						input.idempotencyKey,
						input.reason ?? null,
						input.actorUserId ?? null,
						now,
						input.userId,
						nextVersion,
					),
			]);
			if (Number(results[0]?.meta.changes ?? 0) === 1)
				return {
					id: entryId,
					balanceMinor: after.toString(),
					duplicate: false as const,
				};
		} catch (error) {
			const duplicate = await findEntry(db, input.idempotencyKey);
			if (duplicate) return { ...duplicate, duplicate: true as const };
			throw error;
		}
	}
	throw new DomainError("wallet_conflict", 409, "Balance changed; retry");
}

export async function getWallet(db: D1Database, userId: string) {
	type WalletEntryRow = {
		id: string;
		direction: "credit" | "debit";
		amount_minor: string;
		balance_after_minor: string;
		currency: string;
		source_type: string;
		source_id: string;
		reason: string | null;
		created_at: number;
	};
	const [user, settings, entries] = await Promise.all([
		db
			.prepare(
				"SELECT balance_minor,reward_balance_minor FROM users WHERE id = ? LIMIT 1",
			)
			.bind(userId)
			.first<{ balance_minor: string; reward_balance_minor: string }>(),
		db
			.prepare(
				"SELECT key, value FROM system_settings WHERE key IN ('commerce.default_currency', 'commerce.currency_decimals')",
			)
			.all<{ key: string; value: string }>(),
		db
			.prepare(
				"SELECT id, direction, amount_minor, balance_after_minor, currency, source_type, source_id, reason, created_at FROM wallet_entries WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 100",
			)
			.bind(userId)
			.all<WalletEntryRow>(),
	]);
	if (!user)
		throw new DomainError("wallet_user_not_found", 404, "User not found");
	const values = new Map(
		settings.results.map((row) => [row.key, JSON.parse(row.value)]),
	);
	return {
		balanceMinor: user.balance_minor,
		rewardBalanceMinor: user.reward_balance_minor,
		currency: String(values.get("commerce.default_currency") ?? "USD"),
		currencyDecimals: Number(values.get("commerce.currency_decimals") ?? 2),
		entries: entries.results,
	};
}

async function findEntry(db: D1Database, idempotencyKey: string) {
	const row = await db
		.prepare(
			"SELECT id, balance_after_minor FROM wallet_entries WHERE idempotency_key = ? LIMIT 1",
		)
		.bind(idempotencyKey)
		.first<{ id: string; balance_after_minor: string }>();
	return row ? { id: row.id, balanceMinor: row.balance_after_minor } : null;
}
