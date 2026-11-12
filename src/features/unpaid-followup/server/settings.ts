/** Feature switch (registered in system-settings, default false). */
export const unpaidFollowupEnabledKey = "notifications.unpaid_followup_enabled";
/** Moment the switch was last turned on; orders created earlier are never emailed. */
export const unpaidFollowupActivatedAtKey =
	"notifications.unpaid_followup_activated_at";

export type UnpaidFollowupSettings = {
	enabled: boolean;
	/** null while disabled. */
	activatedAt: number | null;
};

/**
 * Enabled only when the stored flag is exactly JSON `true`. The activation
 * cutoff is the later of the recorded activation time and the moment the flag
 * row was last written, so a switch flipped by any path (ops endpoint, admin
 * settings, SQL) can never reach orders created before it was turned on.
 */
export async function loadUnpaidFollowupSettings(
	db: D1Database,
): Promise<UnpaidFollowupSettings> {
	const rows = await db
		.prepare(
			"SELECT key, value, updated_at FROM system_settings WHERE key IN (?, ?)",
		)
		.bind(unpaidFollowupEnabledKey, unpaidFollowupActivatedAtKey)
		.all<{ key: string; value: string; updated_at: number }>();
	const flag = rows.results.find((row) => row.key === unpaidFollowupEnabledKey);
	const activation = rows.results.find(
		(row) => row.key === unpaidFollowupActivatedAtKey,
	);
	if (!flag || parseJson(flag.value) !== true)
		return { enabled: false, activatedAt: null };
	const recorded = activation ? parseJson(activation.value) : null;
	return {
		enabled: true,
		activatedAt: Math.max(
			Number(flag.updated_at) || 0,
			typeof recorded === "number" && Number.isFinite(recorded) ? recorded : 0,
		),
	};
}

/** Turns the switch on (recording the activation time) or off. */
export async function setUnpaidFollowupEnabled(
	db: D1Database,
	enabled: boolean,
	now = Date.now(),
) {
	const upsert = (key: string, value: unknown) =>
		db
			.prepare(
				`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
				 VALUES (?, ?, 0, ?, ?)
				 ON CONFLICT(key) DO UPDATE SET value = excluded.value,
				 updated_at = excluded.updated_at`,
			)
			.bind(key, JSON.stringify(value), now, now);
	await db.batch([
		upsert(unpaidFollowupEnabledKey, enabled),
		...(enabled ? [upsert(unpaidFollowupActivatedAtKey, now)] : []),
	]);
	return loadUnpaidFollowupSettings(db);
}

function parseJson(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return null;
	}
}
