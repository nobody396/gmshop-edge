import { z } from "zod";
import { sendOwnerAlert } from "#/features/telegram/server/owner-alerts";
import { telegramRuntime } from "#/features/telegram/server/sync";
import { loadSettings, settingStatement } from "./shared";

/**
 * Posts one five-language notice per SKU to the Telegram channel after the
 * pricing guard lowered its USDT price (automatic follow or an approved
 * button). Raises are never posted and the text carries no prices. Copy lives
 * in `ops.price_drop_notice.copy`, covers in R2 under `coverKey(itemId)`.
 */
export const priceDropNoticeSettingKeys = {
	enabled: "ops.price_drop_notice.enabled",
	sinceMs: "ops.price_drop_notice.since_ms",
	chatId: "ops.price_drop_notice.chat_id",
	copy: "ops.price_drop_notice.copy",
} as const;
const claimPrefix = "ops.price_drop_notice.sent.";
const maxAttempts = 3;
export const captionLimit = 1024;
const priceActions = ["pricing_guard.auto_follow", "pricing_guard.owner_raise"];
const lookbackMs = 7 * 86_400_000;

export const coverKey = (itemId: string) =>
	`ops/price-drop-covers/${itemId}.png`;

const pairSchema = z.tuple([z.string().min(1), z.string().min(1)]);
const copySchema = z.record(
	z.string(),
	z.object({
		productId: z.string().min(1),
		title: z.string().min(1),
		sku: z.string().min(1),
		pitch: z.string().min(1),
		hant: pairSchema,
		en: pairSchema,
		ru: pairSchema,
		vi: pairSchema,
		tags: z.string(),
	}),
);
export type PriceDropCopy = z.infer<typeof copySchema>[string];

type Claim = {
	state: "sending" | "sent" | "skipped" | "no_copy" | "failed" | "unknown";
	attempts?: number;
	link?: string;
};

/** Caption plus Telegram entities; offsets are UTF-16 units like JS strings. */
export function composePriceDropNotice(
	origin: string,
	itemId: string,
	copy: PriceDropCopy,
) {
	const heading = `📉 降价通知｜${copy.title}`;
	const quote = [
		"🌐 繁體 · English · Русский · Tiếng Việt",
		`🇨🇳 ${copy.hant[0]} — 已降價，歡迎選購。${copy.hant[1]}`,
		`🇬🇧 ${copy.en[0]} — Price drop, welcome to order. ${copy.en[1]}`,
		`🇷🇺 ${copy.ru[0]} — Цена снижена, ждём ваших заказов. ${copy.ru[1]}`,
		`🇻🇳 ${copy.vi[0]} — Đã giảm giá, mời bạn đặt mua. ${copy.vi[1]}`,
	].join("\n");
	const head = [
		heading,
		`${copy.sku} 已降价，欢迎选购`,
		`${copy.pitch}；付款后自动发卡密`,
		"",
		`🛒 ${new URL(`/products/${copy.productId}?item=${itemId}`, origin)}`,
		"",
		"",
	].join("\n");
	const caption = `${head}${quote}\n\n${copy.tags}\n🔄 代理卡网已同步 · Reseller catalog synced`;
	const entities: { type: string; offset: number; length: number }[] = [
		{ type: "bold", offset: 0, length: heading.length },
		{
			type: "expandable_blockquote",
			offset: head.length,
			length: quote.length,
		},
	];
	for (const [name] of [copy.hant, copy.en, copy.ru, copy.vi]) {
		const offset = caption.indexOf(name, head.length);
		if (offset >= 0)
			entities.push({ type: "bold", offset, length: name.length });
	}
	return { caption, entities };
}

type DropRow = {
	id: string;
	target_id: string;
	before: string;
	after: string;
	current: string;
	active: number;
};

export async function runPriceDropNotices(input: {
	db: D1Database;
	files: R2Bucket;
	now: number;
	fetcher?: typeof fetch;
	botToken?: string | null;
	origin?: string;
}) {
	const { db, now } = input;
	const fetcher = input.fetcher ?? fetch;
	const settings = await loadSettings(
		db,
		Object.values(priceDropNoticeSettingKeys),
	);
	if (settings.get(priceDropNoticeSettingKeys.enabled) !== true)
		return { status: "disabled" as const };
	const since = z
		.number()
		.int()
		.safeParse(settings.get(priceDropNoticeSettingKeys.sinceMs));
	if (!since.success) {
		// The first run only sets the starting point; older drops are not posted.
		await settingStatement(
			db,
			priceDropNoticeSettingKeys.sinceMs,
			now,
			now,
		).run();
		return { status: "initialized" as const };
	}
	const rows = await db
		.prepare(
			`SELECT log.id, log.target_id, log.before, log.after, item.price_minor AS current,
			  (item.enabled = 1 AND item.sale_disabled = 0 AND product.status = 'active'
			   AND product.sale_disabled = 0) AS active
			 FROM audit_logs log
			 JOIN product_sellable_items item ON item.id = log.target_id
			 JOIN products product ON product.id = item.product_id
			 WHERE log.created_at > ? AND log.action IN (?, ?)
			 ORDER BY log.created_at DESC, log.id DESC LIMIT 200`,
		)
		.bind(Math.max(since.data, now - lookbackMs), ...priceActions)
		.all<DropRow>();
	// Only drops count, and several drops of one SKU become one post.
	const latest = new Map<string, DropRow>();
	for (const row of [...rows.results].reverse()) {
		const before = Number(JSON.parse(row.before).priceMinor);
		const after = Number(JSON.parse(row.after).priceMinor);
		if (after < before) latest.set(row.target_id, row);
		else latest.delete(row.target_id);
	}
	if (!latest.size) return { status: "idle" as const };

	const claims = await loadSettings(
		db,
		[...latest.values()].map((row) => claimPrefix + row.id),
	);
	const copyTable = copySchema.safeParse(
		settings.get(priceDropNoticeSettingKeys.copy),
	);
	const chatId = z
		.union([z.string().min(1), z.number().int()])
		.safeParse(settings.get(priceDropNoticeSettingKeys.chatId));
	const telegram =
		input.botToken === undefined || input.origin === undefined
			? await telegramRuntime(db)
			: null;
	const botToken =
		input.botToken !== undefined
			? input.botToken
			: (telegram?.provider?.telegramBotToken ?? null);
	const origin = input.origin ?? telegram?.runtime.betterAuthUrl ?? "";
	const posted: string[] = [];
	const problems: string[] = [];
	for (const row of latest.values()) {
		const key = claimPrefix + row.id;
		const previous = claims.get(key) as Claim | undefined;
		if (
			previous &&
			!(previous.state === "failed" && (previous.attempts ?? 0) < maxAttempts)
		)
			continue;
		if (!(await claim(db, key, previous, now))) continue;
		const attempts = (previous?.attempts ?? 0) + 1;
		const copy = copyTable.success ? copyTable.data[row.target_id] : undefined;
		const after = String(JSON.parse(row.after).priceMinor);
		if (row.active !== 1 || row.current !== after) {
			await settle(db, key, { state: "skipped" }, now);
			continue;
		}
		if (!copy) {
			await settle(db, key, { state: "no_copy" }, now);
			problems.push(
				`· 规格 ${row.target_id} 降价了，但频道文案表里没有它，没发频道。需要补文案和封面。`,
			);
			continue;
		}
		const cover = await input.files.get(coverKey(row.target_id));
		const { caption, entities } = composePriceDropNotice(
			origin,
			row.target_id,
			copy,
		);
		if (
			!cover ||
			!botToken ||
			!chatId.success ||
			caption.length > captionLimit
		) {
			const reason = !cover
				? "缺封面图"
				: !botToken
					? "机器人没配置"
					: !chatId.success
						? "频道没配置"
						: "文案超过 1024 字";
			await settle(db, key, { state: "failed", attempts: maxAttempts }, now);
			problems.push(`· ${copy.sku}：${reason}，没发频道。`);
			continue;
		}
		const form = new FormData();
		form.set("chat_id", String(chatId.data));
		form.set("caption", caption);
		form.set("caption_entities", JSON.stringify(entities));
		form.set(
			"photo",
			new Blob([await cover.arrayBuffer()], { type: "image/png" }),
			`${row.target_id}.png`,
		);
		// The URL embeds the bot token: it is never logged or put in an error.
		const response = await fetcher(
			`https://api.telegram.org/bot${botToken}/sendPhoto`,
			{ method: "POST", body: form, signal: AbortSignal.timeout(30_000) },
		).catch(() => null);
		const payload = response
			? ((await response.json().catch(() => null)) as {
					ok?: boolean;
					result?: { message_id?: number; chat?: { username?: string } };
				} | null)
			: null;
		if (!response || !payload) {
			// Telegram may have posted it: never resend an uncertain post.
			await settle(db, key, { state: "unknown" }, now);
			problems.push(`· ${copy.sku}：发送结果不确定，不会重发，请看一眼频道。`);
			continue;
		}
		if (!payload.ok || !payload.result?.message_id) {
			await settle(db, key, { state: "failed", attempts }, now);
			problems.push(
				attempts >= maxAttempts
					? `· ${copy.sku}：频道通知 ${maxAttempts} 次都被 Telegram 拒绝，已放弃，需要手动发。`
					: `· ${copy.sku}：频道通知被 Telegram 拒绝，下一分钟自动重试。`,
			);
			continue;
		}
		const username = payload.result.chat?.username;
		const link = username
			? `https://t.me/${username}/${payload.result.message_id}`
			: `消息 ${payload.result.message_id}`;
		await settle(db, key, { state: "sent", link }, now);
		posted.push(`· ${copy.sku}：${link}`);
	}
	const lines = [
		...(posted.length ? ["📣 已自动发频道降价通知：", ...posted] : []),
		...(problems.length
			? [...(posted.length ? [""] : []), "⚠️ 降价通知有问题：", ...problems]
			: []),
	];
	if (lines.length)
		await sendOwnerAlert(db, lines.join("\n"), {
			fetcher,
			topic: "restock",
		}).catch(() => undefined);
	return {
		status: "ran" as const,
		posted: posted.length,
		problems: problems.length,
	};
}

/** Atomically takes a drop: a new key, or a failed one nobody retried yet. */
async function claim(
	db: D1Database,
	key: string,
	previous: Claim | undefined,
	now: number,
) {
	const sending = JSON.stringify({
		state: "sending",
		attempts: previous?.attempts ?? 0,
	} satisfies Claim);
	const result = previous
		? await db
				.prepare(
					"UPDATE system_settings SET value = ?, updated_at = ? WHERE key = ? AND value = ?",
				)
				.bind(sending, now, key, JSON.stringify(previous))
				.run()
		: await db
				.prepare(
					`INSERT INTO system_settings (key, value, is_secret, created_at, updated_at)
					 VALUES (?, ?, 0, ?, ?) ON CONFLICT(key) DO NOTHING`,
				)
				.bind(key, sending, now, now)
				.run();
	return Number(result.meta.changes ?? 0) === 1;
}

function settle(db: D1Database, key: string, value: Claim, now: number) {
	return settingStatement(db, key, value, now).run();
}
