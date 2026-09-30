import { Api, GrammyError, InputFile } from "grammy";
import { z } from "zod";
import {
	BodyLimitExceededError,
	readBoundedRequestBytes,
	readBoundedResponseBytes,
} from "#/lib/bounded-stream";
import { isSameOriginRequest } from "#/server/api-boundaries";
import { getRuntimeEnv } from "#/server/db.server";
import { claimFixedWindowRateLimit } from "#/server/rate-limit";
import type { RuntimeObjectStorage } from "#/server/runtime/types";
import {
	type SupportAttachment,
	supportFileMaxBytes,
	supportFileRetentionMs,
	validateSupportFile,
} from "../web-support-attachments";
import { supportEmailKeyboard } from "./manual-support-email";
import { telegramRuntime } from "./sync";
import {
	requireConversation,
	storeWebAdministratorReply,
	updateWebSupportLocale,
	type WebConversation,
	WebSupportError,
} from "./web-support";

type AttachmentRow = SupportAttachment & {
	conversation_id: string;
	status: string;
	expires_at: number;
	created_at: number;
};
const objectKey = (id: string) => `web-support/attachments/${id}`;
function files() {
	const bucket = getRuntimeEnv().FILES;
	if (!bucket) throw new WebSupportError("support_unavailable", 503);
	return bucket;
}
function validate(name: string, bytes: Uint8Array) {
	try {
		return validateSupportFile(name, bytes);
	} catch (error) {
		throw new WebSupportError(
			error instanceof Error ? error.message : "file_type",
			400,
		);
	}
}
async function reserve(
	db: D1Database,
	conversation: WebConversation,
	source: string,
	attachment: SupportAttachment,
) {
	return db
		.prepare(`INSERT INTO telegram_web_support_attachments
	 (id,conversation_id,source_key,name,mime,size,status,created_at,expires_at)
	 VALUES (?,?,?,?,?,?,'pending',?,?) ON CONFLICT(conversation_id,source_key) DO NOTHING`)
		.bind(
			attachment.id,
			conversation.id,
			source,
			attachment.name,
			attachment.mime,
			attachment.size,
			Date.now(),
			Date.now() + supportFileRetentionMs,
		)
		.run();
}
export async function uploadWebSupportAttachment(
	db: D1Database,
	request: Request,
) {
	if (!isSameOriginRequest(request))
		throw new WebSupportError("forbidden_origin", 403);
	const conversation = await requireConversation(db, request);
	if (conversation.status !== "active" || !conversation.message_thread_id)
		throw new WebSupportError("conversation_closed", 409);
	const rate = await claimFixedWindowRateLimit(db, {
		bucketKey: `support:files:${conversation.id}`,
		limit: 10,
		windowMs: 60_000,
	});
	if (!rate.allowed) throw new WebSupportError("rate_limited", 429);
	const contentType = request.headers.get("content-type") ?? "";
	if (!contentType.startsWith("multipart/form-data;"))
		throw new WebSupportError("unsupported_media_type", 415);
	let form: FormData;
	try {
		const bytes = await readBoundedRequestBytes(
			request,
			supportFileMaxBytes + 16_384,
		);
		form = await new Response(bytes, {
			headers: { "content-type": contentType },
		}).formData();
	} catch (error) {
		throw new WebSupportError(
			error instanceof BodyLimitExceededError ? "file_size" : "invalid_request",
			400,
		);
	}
	const clientId = z.uuid().parse(form.get("clientMessageId"));
	const locale = z
		.enum(["zh-CN", "en-US"])
		.optional()
		.parse(form.get("locale") ?? undefined);
	await updateWebSupportLocale(db, conversation.id, locale);
	const caption = z
		.string()
		.trim()
		.max(1000)
		.parse(form.get("text") ?? "");
	const file = form.get("file");
	if (!file || typeof file === "string" || form.getAll("file").length !== 1)
		throw new WebSupportError("invalid_request", 400);
	const bytes = new Uint8Array(await file.arrayBuffer());
	const metadata = validate(file.name, bytes);
	const previous = await db
		.prepare(
			"SELECT * FROM telegram_web_support_attachments WHERE conversation_id=? AND source_key=?",
		)
		.bind(conversation.id, `customer:${clientId}`)
		.first<AttachmentRow>();
	if (previous) {
		if (previous.status !== "sent")
			throw new WebSupportError("attachment_pending", 409);
		if (previous.expires_at <= Date.now())
			throw new WebSupportError("attachment_expired", 410);
		return {
			attachment: {
				id: previous.id,
				name: previous.name,
				mime: previous.mime,
				size: previous.size,
			},
			duplicate: true,
		};
	}
	const attachment = { id: crypto.randomUUID(), ...metadata };
	const bucket = files();
	const { provider } = await telegramRuntime(db);
	if (!provider?.telegramBotToken)
		throw new WebSupportError("support_unavailable", 503);
	const claim = await reserve(
		db,
		conversation,
		`customer:${clientId}`,
		attachment,
	);
	if (Number(claim.meta.changes) !== 1)
		throw new WebSupportError("attachment_pending", 409);
	let attempted = false;
	try {
		await bucket.put(objectKey(attachment.id), bytes);
		attempted = true;
		// Send as document to preserve original screenshot/file bytes in Telegram.
		await new Api(provider.telegramBotToken, {
			timeoutSeconds: 60,
		}).sendDocument(
			conversation.support_chat_id,
			new InputFile(bytes, attachment.name),
			{
				message_thread_id: conversation.message_thread_id,
				caption,
				reply_markup: supportEmailKeyboard(conversation.id),
			},
		);
		await db.batch([
			db
				.prepare(
					"UPDATE telegram_web_support_attachments SET status='sent' WHERE id=?",
				)
				.bind(attachment.id),
			db
				.prepare(
					"UPDATE telegram_web_support_conversations SET last_activity_at=?,updated_at=? WHERE id=?",
				)
				.bind(Date.now(), Date.now(), conversation.id),
		]);
		return { attachment };
	} catch (error) {
		// Network timeouts may have delivered: retain the claim and never auto-resend.
		if (!attempted || error instanceof GrammyError) {
			await bucket.delete(objectKey(attachment.id));
			await db
				.prepare("DELETE FROM telegram_web_support_attachments WHERE id=?")
				.bind(attachment.id)
				.run();
			throw new WebSupportError("attachment_failed", 502);
		}
		throw new WebSupportError("attachment_pending", 409);
	}
}

export async function downloadWebSupportAttachment(
	db: D1Database,
	request: Request,
	id: string,
) {
	z.uuid().parse(id);
	const conversation = await requireConversation(db, request);
	const row = await db
		.prepare(
			"SELECT * FROM telegram_web_support_attachments WHERE id=? AND conversation_id=? AND status='sent'",
		)
		.bind(id, conversation.id)
		.first<AttachmentRow>();
	if (!row) throw new WebSupportError("attachment_not_found", 404);
	if (
		row.expires_at <= Date.now() ||
		row.created_at <= Date.now() - supportFileRetentionMs
	)
		throw new WebSupportError("attachment_expired", 410);
	const object = await files().get(objectKey(id));
	if (!object || !("body" in object))
		throw new WebSupportError("attachment_not_found", 404);
	const inline =
		row.mime.startsWith("image/") &&
		new URL(request.url).searchParams.get("download") !== "1";
	return new Response(object.body, {
		headers: {
			"content-type": inline ? row.mime : "application/octet-stream",
			"content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(row.name)}`,
			"cache-control": "private, no-store",
			"x-content-type-options": "nosniff",
			"content-security-policy": "default-src 'none'; sandbox",
			"cross-origin-resource-policy": "same-origin",
		},
	});
}

export async function storeWebAdministratorAttachment(
	db: D1Database,
	api: Api,
	conversation: WebConversation,
	input: {
		fileId: string;
		name: string;
		size?: number;
		messageId: number;
		caption?: string;
	},
) {
	if (input.size && input.size > supportFileMaxBytes)
		throw new WebSupportError("file_size", 400);
	const source = `staff:${input.messageId}`;
	const existing = await db
		.prepare(
			"SELECT id,status FROM telegram_web_support_attachments WHERE conversation_id=? AND source_key=?",
		)
		.bind(conversation.id, source)
		.first<{ id: string; status: string }>();
	if (existing?.status === "sent") return;
	if (existing) throw new WebSupportError("attachment_pending", 409);
	const file = await api.getFile(input.fileId).catch(() => {
		throw new WebSupportError("telegram_get_file_failed", 502);
	});
	if (
		!file.file_path ||
		file.file_path.includes("..") ||
		!/^[a-zA-Z0-9_/.-]+$/.test(file.file_path)
	)
		throw new WebSupportError("invalid_file", 400);
	if (file.file_size && file.file_size > supportFileMaxBytes)
		throw new WebSupportError("file_size", 400);
	const { provider } = await telegramRuntime(db);
	if (!provider?.telegramBotToken)
		throw new WebSupportError("support_unavailable", 503);
	// Telegram token remains server-side; never return or log its file URL.
	let bytes: Uint8Array;
	try {
		const response = await fetch(
			`https://api.telegram.org/file/bot${provider.telegramBotToken}/${file.file_path}`,
			{ redirect: "manual", signal: AbortSignal.timeout(30_000) },
		);
		if (!response.ok)
			throw new WebSupportError(`telegram_file_http_${response.status}`, 502);
		bytes = await readBoundedResponseBytes(response, supportFileMaxBytes);
	} catch (error) {
		if (error instanceof WebSupportError) throw error;
		throw new WebSupportError(
			error instanceof BodyLimitExceededError
				? "file_size"
				: "telegram_file_download_failed",
			502,
		);
	}
	const attachment = {
		id: crypto.randomUUID(),
		...validate(input.name, bytes),
	};
	const bucket = files();
	const claim = await reserve(db, conversation, source, attachment);
	if (Number(claim.meta.changes) !== 1) return;
	let stage = "file_storage_failed";
	try {
		await bucket.put(objectKey(attachment.id), bytes);
		stage = "reply_storage_failed";
		await storeWebAdministratorReply(
			db,
			conversation,
			JSON.stringify({
				type: "web-support-attachment-v1",
				text: input.caption ?? "",
				attachment,
			}),
			attachment.id,
		);
	} catch {
		await bucket.delete(objectKey(attachment.id));
		await db
			.prepare("DELETE FROM telegram_web_support_attachments WHERE id=?")
			.bind(attachment.id)
			.run();
		throw new WebSupportError(stage, 502);
	}
}

export async function cleanupSupportAttachments(
	db: D1Database,
	bucket: RuntimeObjectStorage | undefined,
	now: number,
) {
	if (!bucket) return 0;
	const rows = await db
		.prepare(
			"SELECT id FROM telegram_web_support_attachments WHERE expires_at<=? ORDER BY expires_at,id LIMIT 100",
		)
		.bind(now)
		.all<{ id: string }>();
	for (const row of rows.results) {
		await bucket.delete(objectKey(row.id));
		await db
			.prepare("DELETE FROM telegram_web_support_attachments WHERE id=?")
			.bind(row.id)
			.run();
	}
	return rows.results.length;
}
