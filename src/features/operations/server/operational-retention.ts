const CLEANUP_BATCH_SIZE = 250;
const DEFAULT_MAX_ROWS = 2_000;
const DEFAULT_MAX_DURATION_MS = 2_000;
const AUDIT_EXPORT_BATCH_SIZE = 100;

export async function hasOperationalRetentionWork(
	db: D1Database,
	now: number,
	retentionMs: number,
) {
	const cutoff = now - retentionMs;
	const row = await db
		.prepare(
			`SELECT (
			 EXISTS(SELECT 1 FROM operation_task_runs INDEXED BY operation_task_runs_artifact_retention_idx
			  WHERE delete_after <= ? AND artifact_object_key IS NOT NULL
			  AND artifact_deleted_at IS NULL LIMIT 1)
			 OR EXISTS(SELECT 1 FROM notification_deliveries
			  WHERE status IN ('accepted', 'delivered', 'failed', 'bounced', 'rejected', 'suppressed') AND updated_at < ? LIMIT 1)
			 OR EXISTS(SELECT 1 FROM outbox_events
			  WHERE status IN ('published', 'failed') AND updated_at < ? LIMIT 1)
			 OR EXISTS(SELECT 1 FROM operation_task_runs
			  WHERE status IN ('succeeded', 'failed') AND completed_at < ? LIMIT 1)
			) AS due`,
		)
		.bind(now, cutoff, cutoff, cutoff)
		.first<{ due: number }>();
	return row?.due === 1;
}

export async function runOperationalRetentionCleanup(input: {
	db: D1Database;
	bucket: Pick<R2Bucket, "delete">;
	now: number;
	retentionMs: number;
	maxRows?: number;
	maxDurationMs?: number;
}) {
	const maxRows = input.maxRows ?? DEFAULT_MAX_ROWS;
	const deadline =
		performance.now() + (input.maxDurationMs ?? DEFAULT_MAX_DURATION_MS);
	const cutoff = input.now - input.retentionMs;
	let commerceRows = 0;
	for (const table of [
		{
			name: "notification_deliveries",
			predicate:
				"status IN ('accepted', 'delivered', 'failed', 'bounced', 'rejected', 'suppressed') AND updated_at < ?",
		},
		{
			name: "outbox_events",
			predicate: "status IN ('published', 'failed') AND updated_at < ?",
		},
		{
			name: "operation_task_runs",
			predicate:
				"status IN ('succeeded', 'failed') AND completed_at < ? AND (artifact_object_key IS NULL OR artifact_deleted_at IS NOT NULL)",
		},
	] as const) {
		if (commerceRows >= maxRows || performance.now() >= deadline) break;
		commerceRows += await deleteTerminalRows(
			input.db,
			table.name,
			table.predicate,
			cutoff,
			Math.min(CLEANUP_BATCH_SIZE, maxRows - commerceRows),
		);
	}
	const auditExports = await deleteExpiredAuditExports(
		input.db,
		input.bucket,
		input.now,
		Math.min(AUDIT_EXPORT_BATCH_SIZE, Math.max(0, maxRows - commerceRows)),
	);
	return {
		affectedRows: commerceRows + auditExports,
		commerceRows,
		auditExports,
	};
}

async function deleteTerminalRows(
	db: D1Database,
	table: "notification_deliveries" | "outbox_events" | "operation_task_runs",
	predicate: string,
	cutoff: number,
	limit: number,
) {
	if (limit === 0) return 0;
	const timestamp =
		table === "operation_task_runs" ? "completed_at" : "updated_at";
	const result = await db
		.prepare(
			`DELETE FROM ${table} WHERE id IN (
			 SELECT id FROM ${table} WHERE ${predicate}
			 ORDER BY ${timestamp}, id LIMIT ?
			)`,
		)
		.bind(cutoff, limit)
		.run();
	return Number(result.meta.changes ?? 0);
}

async function deleteExpiredAuditExports(
	db: D1Database,
	bucket: Pick<R2Bucket, "delete">,
	now: number,
	limit: number,
) {
	if (limit === 0) return 0;
	const due = await db
		.prepare(
			`SELECT id, artifact_object_key FROM operation_task_runs
			 INDEXED BY operation_task_runs_artifact_retention_idx
			 WHERE delete_after <= ? AND artifact_object_key IS NOT NULL
			 AND artifact_deleted_at IS NULL
			 ORDER BY delete_after, id LIMIT ?`,
		)
		.bind(now, limit)
		.all<{ id: string; artifact_object_key: string }>();
	if (!due.results.length) return 0;
	await bucket.delete(due.results.map((row) => row.artifact_object_key));
	const updates = await db.batch(
		due.results.map((row) =>
			db
				.prepare(
					`UPDATE operation_task_runs SET artifact_deleted_at = ?
					 WHERE id = ? AND artifact_deleted_at IS NULL`,
				)
				.bind(now, row.id),
		),
	);
	return updates.reduce(
		(sum, result) => sum + Number(result.meta.changes ?? 0),
		0,
	);
}
