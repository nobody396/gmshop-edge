import { z } from "zod";
import { sendOwnerAlert } from "#/features/telegram/server/owner-alerts";
import { codePrefixPattern, redeemCodePrefixes } from "../domain";

/** Public list of every card-code prefix the redeem catalog issues. */
export const redeemCodePrefixesUrl =
	"https://redeem.laoshirenvip.com/api/catalog/code-prefixes";
const fetchTimeoutMs = 5_000;
/** At most one "could not read the live list" alert per six hours. */
export const codePrefixAlertIntervalMs = 6 * 3_600_000;
const alertStateKey = "renewals.code_prefix_feed";

const feedSchema = z.object({
	version: z.literal(1),
	prefixes: z
		.array(z.string().max(64).regex(codePrefixPattern))
		.min(1)
		.max(500),
});

export type CodePrefixSource = () => Promise<readonly string[]>;

/**
 * Live catalog prefixes merged with the built-in list. The union means a bad
 * or partial answer can only add recognition, never remove it. When the live
 * list cannot be read the built-in list is used and the owner is told (once
 * per six hours), because codes of card types added since then go unmatched.
 */
export async function loadRenewalCodePrefixes(
	db: D1Database,
	options: { now?: number; fetcher?: typeof fetch } = {},
): Promise<readonly string[]> {
	const now = options.now ?? Date.now();
	const request = options.fetcher ?? fetch;
	try {
		const response = await request(redeemCodePrefixesUrl, {
			redirect: "manual",
			signal: AbortSignal.timeout(fetchTimeoutMs),
		});
		if (!response.ok) throw new Error(`status_${response.status}`);
		const text = await response.text();
		if (text.length > 64_000) throw new Error("response_too_large");
		const feed = feedSchema.parse(JSON.parse(text));
		return [...new Set([...redeemCodePrefixes, ...feed.prefixes])];
	} catch (error) {
		console.error(
			JSON.stringify({
				event: "renewals.code_prefixes_unavailable",
				reason:
					error instanceof Error ? error.message.slice(0, 120) : "unknown",
			}),
		);
		await alertOnce(db, now).catch(() => undefined);
		return redeemCodePrefixes;
	}
}

async function alertOnce(db: D1Database, now: number) {
	// Claim the alert slot first so concurrent runs send at most one message.
	const claim = await db
		.prepare(
			`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
			 VALUES (?, ?, 0, ?, ?)
			 ON CONFLICT(key) DO UPDATE SET value = excluded.value,
			 updated_at = excluded.updated_at
			 WHERE system_settings.updated_at <= ?`,
		)
		.bind(
			alertStateKey,
			JSON.stringify({ alertedAt: now }),
			now,
			now,
			now - codePrefixAlertIntervalMs,
		)
		.run();
	if (Number(claim.meta.changes ?? 0) !== 1) return;
	await sendOwnerAlert(
		db,
		[
			"【续费提醒】读不到兑换站的卡密开头列表",
			"现在先用主站内置的列表识别卡密。兑换站新加的卡种在恢复前认不出来，这些卡的续费提醒会按发货时间算，不按兑换时间算。",
			`检查：${redeemCodePrefixesUrl} 能否打开。6 小时内不再重复提醒。`,
		].join("\n"),
		{ topic: "general" },
	);
}
