import type { RuntimeConfig } from "#/server/runtime-config";
import {
	adapterForSupplierAccount,
	type SupplierAccountRuntimeRow,
} from "./account-runtime";
import { claimSupplierApiBudget } from "./rate-limit";
import { requeueFundedSupplierOrders } from "./requeue-funded";
import { syncSupplierCatalogsIfDue } from "./sync-settings";

const BALANCE_SYNC_INTERVAL_MS = 5 * 60_000;

type MaintenanceAccount = SupplierAccountRuntimeRow & {
	normalized_api_origin: string;
	protocol_version: string;
	balance_synced_at: number | null;
};

export async function runSupplierMaintenance(input: {
	db: D1Database;
	cache?: KVNamespace;
	runtime: Pick<RuntimeConfig, "commerceSecret">;
	now?: number;
	fetcher?: typeof fetch;
}) {
	const now = input.now ?? Date.now();
	const rows = await input.db
		.prepare(
			`SELECT * FROM supplier_accounts WHERE enabled = 1
			 ORDER BY provider, normalized_api_origin, protocol_version, id`,
		)
		.all<MaintenanceAccount>();
	let balancesUpdated = 0;
	let balancesFailed = 0;
	for (const account of rows.results) {
		if (
			account.balance_synced_at !== null &&
			account.balance_synced_at > now - BALANCE_SYNC_INTERVAL_MS
		)
			continue;
		try {
			await claimSupplierApiBudget(input.db, {
				provider: account.provider,
				normalizedApiOrigin: account.normalized_api_origin,
				protocolVersion: account.protocol_version,
				accountId: account.id,
				now,
			});
			const adapter = await adapterForSupplierAccount(account, input.runtime, {
				fetcher: input.fetcher,
			});
			const connection = await adapter.testConnection();
			await input.db
				.prepare(
					`UPDATE supplier_accounts SET balance_minor = ?,
					 balance_synced_at = ?, health_status = 'healthy',
					 consecutive_failures = 0, cooldown_until = NULL,
					 last_error_code = NULL, updated_at = ? WHERE id = ?`,
				)
				.bind(connection.balance.amountMinor, now, now, account.id)
				.run();
			balancesUpdated += 1;
		} catch {
			await input.db
				.prepare(
					`UPDATE supplier_accounts SET health_status = 'degraded',
					 consecutive_failures = consecutive_failures + 1,
					 cooldown_until = ?, last_error_code = 'balance_sync_failed',
					 last_error_at = ?, updated_at = ? WHERE id = ?`,
				)
				.bind(now + 60_000, now, now, account.id)
				.run();
			balancesFailed += 1;
		}
	}
	const funded = await requeueFundedSupplierOrders(input.db, now).catch(() => ({
		requeued: 0,
	}));
	const catalogs = await syncSupplierCatalogsIfDue({
		db: input.db,
		cache: input.cache,
		runtime: input.runtime,
		now,
		fetcher: input.fetcher,
	});
	return {
		balancesUpdated,
		balancesFailed,
		fundedOrdersRequeued: funded.requeued,
		catalogsUpdated: catalogs.updated,
		catalogsSkipped: catalogs.skipped,
		catalogsFailed: catalogs.failed,
	};
}
