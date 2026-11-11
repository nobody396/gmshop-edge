const REQUEUE_BATCH_LIMIT = 10;
const REQUEUE_MAX_AGE_MS = 7 * 24 * 60 * 60_000;

type BlockedSupplierOrder = {
	id: string;
	quantity: number;
	updated_at: number;
	binding_snapshot_json: string;
	reference_cost_minor: string | null;
};

type FundingAccount = {
	id: string;
	balance_minor: string | null;
	reserve_balance_minor: string;
	max_order_cost_minor: string | null;
	balance_synced_at: number | null;
};

/**
 * Reopens supplier orders that failed only because no supplier account could
 * pay for them, once a balance synced after the failure covers the cost. The
 * reopened order goes through the normal supplier queue, which re-checks live
 * balance, stock and max cost before buying.
 */
export async function requeueFundedSupplierOrders(
	db: D1Database,
	now = Date.now(),
) {
	const blocked = await db
		.prepare(
			`SELECT so.id, so.quantity, so.updated_at, so.binding_snapshot_json,
			        binding.reference_cost_minor
			 FROM supplier_orders so
			 JOIN delivery_records delivery ON delivery.id = so.delivery_record_id
			 JOIN shop_orders shop_order ON shop_order.id = so.order_id
			 LEFT JOIN supplier_bindings binding ON binding.id = so.supplier_binding_id
			 WHERE so.state = 'failed'
			   AND so.last_error_code = 'supplier_accounts_exhausted'
			   AND so.selected_account_id IS NULL
			   AND so.account_locked_at IS NULL
			   AND so.created_at >= ?
			   AND delivery.status = 'awaiting_supply'
			   AND shop_order.status IN ('paid', 'fulfilling')
			 ORDER BY so.created_at, so.id LIMIT ?`,
		)
		.bind(now - REQUEUE_MAX_AGE_MS, REQUEUE_BATCH_LIMIT)
		.all<BlockedSupplierOrder>();
	let requeued = 0;
	for (const order of blocked.results) {
		const snapshot = parseSnapshot(order.binding_snapshot_json);
		if (!snapshot) continue;
		const unitCost = cheaperCost(
			order.reference_cost_minor,
			snapshot.maxCostMinor,
		);
		const totalCost = BigInt(unitCost) * BigInt(Math.max(1, order.quantity));
		if (
			!(await hasFundedAccount(db, snapshot, order.updated_at, totalCost, now))
		)
			continue;
		const outboxId = crypto.randomUUID();
		const [reopened] = await db.batch([
			db
				.prepare(
					`UPDATE supplier_orders SET state = 'pending', next_retry_at = ?,
					 last_error_code = NULL, updated_at = ?
					 WHERE id = ? AND state = 'failed'
					 AND last_error_code = 'supplier_accounts_exhausted'
					 AND selected_account_id IS NULL AND account_locked_at IS NULL`,
				)
				.bind(now, now, order.id),
			db
				.prepare(
					`INSERT INTO outbox_events
					 (id, event_type, aggregate_type, aggregate_id, idempotency_key,
					  payload, status, attempt_count, created_at, updated_at)
					 SELECT ?, 'supplier.requested', 'supplier_order', ?, ?, ?,
					  'pending', 0, ?, ?
					 WHERE EXISTS (SELECT 1 FROM supplier_orders
					  WHERE id = ? AND state = 'pending' AND updated_at = ?)`,
				)
				.bind(
					outboxId,
					order.id,
					`supplier-funded-requeue:${order.id}:${now}`,
					JSON.stringify({ supplierOrderId: order.id }),
					now,
					now,
					order.id,
					now,
				),
		]);
		if (Number(reopened?.meta.changes ?? 0) === 1) requeued += 1;
	}
	return { requeued };
}

async function hasFundedAccount(
	db: D1Database,
	snapshot: {
		provider: string;
		normalizedApiOrigin: string;
		protocolVersion: string;
	},
	failedAt: number,
	totalCost: bigint,
	now: number,
) {
	const accounts = await db
		.prepare(
			`SELECT id, balance_minor, reserve_balance_minor, max_order_cost_minor,
			        balance_synced_at
			 FROM supplier_accounts WHERE provider = ?
			 AND normalized_api_origin = ? AND protocol_version = ?
			 AND enabled = 1 AND health_status <> 'unavailable'
			 AND (cooldown_until IS NULL OR cooldown_until <= ?)
			 AND balance_minor IS NOT NULL AND balance_synced_at > ?`,
		)
		.bind(
			snapshot.provider,
			snapshot.normalizedApiOrigin,
			snapshot.protocolVersion,
			now,
			failedAt,
		)
		.all<FundingAccount>();
	for (const account of accounts.results) {
		if (
			account.max_order_cost_minor !== null &&
			totalCost > BigInt(account.max_order_cost_minor)
		)
			continue;
		const commitments = await db
			.prepare(
				`SELECT COALESCE(SUM(CAST(total_cost_minor AS INTEGER)), 0) AS committed
				 FROM supplier_orders WHERE selected_account_id = ?
				 AND state IN ('submitting', 'uncertain')`,
			)
			.bind(account.id)
			.first<{ committed: number }>();
		const available =
			BigInt(account.balance_minor ?? "0") -
			BigInt(account.reserve_balance_minor) -
			BigInt(commitments?.committed ?? 0);
		if (available >= totalCost) return true;
	}
	return false;
}

function cheaperCost(reference: string | null, max: string) {
	if (reference === null || !/^\d+$/.test(reference)) return max;
	return BigInt(reference) < BigInt(max) ? reference : max;
}

function parseSnapshot(value: string) {
	try {
		const parsed = JSON.parse(value) as Record<string, unknown>;
		if (
			typeof parsed.provider !== "string" ||
			typeof parsed.normalizedApiOrigin !== "string" ||
			typeof parsed.protocolVersion !== "string" ||
			typeof parsed.maxCostMinor !== "string" ||
			!/^\d+$/.test(parsed.maxCostMinor)
		)
			return null;
		return {
			provider: parsed.provider,
			normalizedApiOrigin: parsed.normalizedApiOrigin,
			protocolVersion: parsed.protocolVersion,
			maxCostMinor: parsed.maxCostMinor,
		};
	} catch {
		return null;
	}
}
