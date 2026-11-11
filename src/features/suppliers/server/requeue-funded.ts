const REQUEUE_BATCH_LIMIT = 10;
const REQUEUE_SCAN_LIMIT = 200;
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
};

type SnapshotRoute = {
	provider: string;
	normalizedApiOrigin: string;
	protocolVersion: string;
	maxCostMinor: string;
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
	// Only orders whose route has a balance synced after the failure are
	// candidates, so unfundable orders do not occupy the scan window forever.
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
			   AND EXISTS (SELECT 1 FROM supplier_accounts account
			     WHERE account.provider =
			       json_extract(so.binding_snapshot_json, '$.provider')
			     AND account.normalized_api_origin =
			       json_extract(so.binding_snapshot_json, '$.normalizedApiOrigin')
			     AND account.protocol_version =
			       json_extract(so.binding_snapshot_json, '$.protocolVersion')
			     AND account.enabled = 1
			     AND account.balance_synced_at > so.updated_at)
			 ORDER BY so.created_at, so.id LIMIT ?`,
		)
		.bind(now - REQUEUE_MAX_AGE_MS, REQUEUE_SCAN_LIMIT)
		.all<BlockedSupplierOrder>();
	let requeued = 0;
	// Cost already promised to orders reopened in this run, per account.
	const promised = new Map<string, bigint>();
	for (const order of blocked.results) {
		if (requeued >= REQUEUE_BATCH_LIMIT) break;
		const snapshot = parseSnapshot(order.binding_snapshot_json);
		if (!snapshot) continue;
		const unitCost = expectedUnitCost(
			order.reference_cost_minor,
			snapshot.maxCostMinor,
		);
		// A known price above the order's cost cap would fail again upstream.
		if (unitCost === null) continue;
		const totalCost = unitCost * BigInt(Math.max(1, order.quantity));
		const accountId = await fundedAccount(
			db,
			snapshot,
			order.updated_at,
			totalCost,
			promised,
			now,
		);
		if (!accountId) continue;
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
					crypto.randomUUID(),
					order.id,
					`supplier-funded-requeue:${order.id}:${now}`,
					JSON.stringify({ supplierOrderId: order.id }),
					now,
					now,
					order.id,
					now,
				),
		]);
		if (Number(reopened?.meta.changes ?? 0) !== 1) continue;
		requeued += 1;
		promised.set(accountId, (promised.get(accountId) ?? 0n) + totalCost);
	}
	return { requeued };
}

async function fundedAccount(
	db: D1Database,
	snapshot: SnapshotRoute,
	failedAt: number,
	totalCost: bigint,
	promised: Map<string, bigint>,
	now: number,
) {
	const accounts = await db
		.prepare(
			`SELECT id, balance_minor, reserve_balance_minor, max_order_cost_minor
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
			BigInt(commitments?.committed ?? 0) -
			(promised.get(account.id) ?? 0n);
		if (available >= totalCost) return account.id;
	}
	return null;
}

function expectedUnitCost(reference: string | null, max: string) {
	const cap = BigInt(max);
	if (reference === null || !/^\d+$/.test(reference)) return cap;
	const known = BigInt(reference);
	return known > cap ? null : known;
}

function parseSnapshot(value: string): SnapshotRoute | null {
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
