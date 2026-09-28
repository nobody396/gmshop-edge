import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as grammy from "grammy";

class TestApi extends grammy.Api {
	constructor(token: string) {
		super(token);
		this.config.use((async (_previous, method) => {
			if (method === "sendDocument") {
				sendCount++;
				if (uncertain) throw new Error("timeout");
				return {
					ok: true,
					result: {
						message_id: 12,
						date: 1,
						chat: { id: 123, type: "supergroup" },
					},
				};
			}
			if (method === "getFile")
				return {
					ok: true,
					result: {
						file_id: "test-file",
						file_unique_id: "unique",
						file_path: "documents/test.txt",
						file_size: textBytes.length,
					},
				};
			throw new Error("Unexpected Telegram method");
		}) as Parameters<grammy.Api["config"]["use"]>[0]);
	}
}
mock.module("grammy", () => ({ ...grammy, Api: TestApi }));

import { supportFileRetentionMs } from "../../src/features/telegram/web-support-attachments";
import { runWithRuntimeEnv } from "../../src/server/runtime/context";
import { openNodeDatabase } from "../../src/server/runtime/node/database";
import { applyNodeMigrations } from "../../src/server/runtime/node/migrations";
import { NodeObjectStorage } from "../../src/server/runtime/node/object-storage";

mock.module("../../src/features/telegram/server/sync", () => ({
	telegramRuntime: async () => ({
		provider: { telegramBotToken: "test-only-token" },
	}),
}));
const {
	uploadWebSupportAttachment,
	downloadWebSupportAttachment,
	storeWebAdministratorAttachment,
	cleanupSupportAttachments,
} = await import("../../src/features/telegram/server/web-support-attachments");
let database: ReturnType<typeof openNodeDatabase>;
let db: D1Database;
let bucket: NodeObjectStorage;
let directory: string;
let sendCount: number;
let uncertain: boolean;
let privateKey: CryptoKey;
const cid = "00000000-0000-4000-8000-000000000001";
const token = "local-test-session";
const originalFetch = globalThis.fetch;
const textBytes = new TextEncoder().encode("attachment integration test");

beforeEach(async () => {
	database = openNodeDatabase(":memory:");
	db = database as unknown as D1Database;
	await applyNodeMigrations(database);
	directory = await mkdtemp(join(tmpdir(), "support-test-"));
	bucket = new NodeObjectStorage(directory);
	const pair = await crypto.subtle.generateKey(
		{
			name: "RSA-OAEP",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["encrypt", "decrypt"],
	);
	privateKey = pair.privateKey;
	const publicKey = JSON.stringify(
		await crypto.subtle.exportKey("jwk", pair.publicKey),
	);
	const hash = Buffer.from(
		await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
	).toString("base64url");
	await db
		.prepare(
			`INSERT INTO telegram_web_support_conversations (id,support_chat_id,visitor_id,email_encrypted,email_hash,session_token_hash,public_key_jwk,message_thread_id,status,next_reply_sequence,created_at,updated_at) VALUES (?,'123','test-visitor','none','test',?,?,99,'active',1,?,?)`,
		)
		.bind(cid, hash, publicKey, Date.now(), Date.now())
		.run();
	sendCount = 0;
	uncertain = false;
	globalThis.fetch = mock(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.includes("/file/bot")) return new Response(textBytes);
		throw new Error("Unexpected transport");
	}) as typeof fetch;
});
afterEach(async () => {
	globalThis.fetch = originalFetch;
	database.close();
	await rm(directory, { recursive: true, force: true });
});
const run = <T>(fn: () => T) =>
	runWithRuntimeEnv({ runtime: "bun", DB: database, FILES: bucket }, fn);
function request(
	id = crypto.randomUUID(),
	origin = "https://shop.test",
	cookie = token,
	name = "test.txt",
	bytes: Uint8Array = textBytes,
) {
	const form = new FormData();
	form.set("clientMessageId", id);
	form.set("text", "caption");
	form.set("file", new File([new Uint8Array(bytes)], name));
	return new Request("https://shop.test/api/support/web/attachments/", {
		method: "POST",
		headers: { origin, cookie: `gmshop_web_support=${cookie}` },
		body: form,
	});
}
function download(id: string, cookie = token) {
	return new Request(`https://shop.test/api/support/web/attachments/${id}`, {
		headers: { cookie: `gmshop_web_support=${cookie}` },
	});
}

describe("Web support attachments with SQLite + private object storage", () => {
	test("migrates an empty database and round-trips a file only for its owner", async () => {
		const id = crypto.randomUUID();
		const sent = await run(() => uploadWebSupportAttachment(db, request(id)));
		const response = await run(() =>
			downloadWebSupportAttachment(
				db,
				download(sent.attachment.id),
				sent.attachment.id,
			),
		);
		expect(await response.text()).toBe("attachment integration test");
		expect(response.headers.get("content-disposition")).toStartWith(
			"attachment;",
		);
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		await expect(
			run(() =>
				downloadWebSupportAttachment(
					db,
					download(sent.attachment.id, "another-session"),
					sent.attachment.id,
				),
			),
		).rejects.toMatchObject({ status: 401 });
		const otherHash = Buffer.from(
			await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode("other-valid-session"),
			),
		).toString("base64url");
		await db
			.prepare(
				`INSERT INTO telegram_web_support_conversations (id,support_chat_id,visitor_id,email_encrypted,email_hash,session_token_hash,public_key_jwk,message_thread_id,status,next_reply_sequence,created_at,updated_at) SELECT 'other','123','other-visitor',email_encrypted,email_hash,?,public_key_jwk,100,'active',1,created_at,updated_at FROM telegram_web_support_conversations WHERE id=?`,
			)
			.bind(otherHash, cid)
			.run();
		await expect(
			run(() =>
				downloadWebSupportAttachment(
					db,
					download(sent.attachment.id, "other-valid-session"),
					sent.attachment.id,
				),
			),
		).rejects.toMatchObject({ status: 404 });
		const duplicate = await run(() =>
			uploadWebSupportAttachment(db, request(id)),
		);
		expect(duplicate.attachment.id).toBe(sent.attachment.id);
		expect(sendCount).toBe(1);
		expect(
			(await db.prepare("PRAGMA foreign_key_check").all()).results,
		).toHaveLength(0);
	});
	test("rejects cross-origin, malformed files and closed conversations before delivery", async () => {
		await expect(
			run(() =>
				uploadWebSupportAttachment(
					db,
					request(crypto.randomUUID(), "https://evil.test"),
				),
			),
		).rejects.toMatchObject({ status: 403 });
		await expect(
			run(() =>
				uploadWebSupportAttachment(
					db,
					request(crypto.randomUUID(), "https://shop.test", token, "fake.png"),
				),
			),
		).rejects.toMatchObject({ code: "file_type" });
		await db
			.prepare(
				"UPDATE telegram_web_support_conversations SET status='closed' WHERE id=?",
			)
			.bind(cid)
			.run();
		await expect(
			run(() => uploadWebSupportAttachment(db, request())),
		).rejects.toMatchObject({ status: 409 });
		expect(sendCount).toBe(0);
	});
	test("does not repeat an uncertain Telegram send", async () => {
		uncertain = true;
		const id = crypto.randomUUID();
		await expect(
			run(() => uploadWebSupportAttachment(db, request(id))),
		).rejects.toMatchObject({ code: "attachment_pending" });
		await expect(
			run(() => uploadWebSupportAttachment(db, request(id))),
		).rejects.toMatchObject({ code: "attachment_pending" });
		expect(sendCount).toBe(1);
	});
	test("denies access after expiry and deletes both metadata and object", async () => {
		const result = await run(() => uploadWebSupportAttachment(db, request()));
		await db
			.prepare("UPDATE telegram_web_support_attachments SET expires_at=0")
			.run();
		await expect(
			run(() =>
				downloadWebSupportAttachment(
					db,
					download(result.attachment.id),
					result.attachment.id,
				),
			),
		).rejects.toMatchObject({ status: 410 });
		expect(
			await cleanupSupportAttachments(
				db,
				bucket,
				Date.now() + supportFileRetentionMs,
			),
		).toBe(1);
		expect(
			await bucket.head(`web-support/attachments/${result.attachment.id}`),
		).toBeNull();
	});
	test("stores Telegram reply as an encrypted envelope and deduplicates its message ID", async () => {
		const conversation = await db
			.prepare("SELECT * FROM telegram_web_support_conversations WHERE id=?")
			.bind(cid)
			.first();
		if (!conversation) throw new Error("Missing conversation");
		const input = {
			fileId: "test-file",
			name: "reply.txt",
			messageId: 77,
			caption: "staff reply",
		};
		const typed = conversation as unknown as Parameters<
			typeof storeWebAdministratorAttachment
		>[2];
		await run(() =>
			storeWebAdministratorAttachment(
				db,
				new TestApi("test-only-token"),
				typed,
				input,
			),
		);
		await run(() =>
			storeWebAdministratorAttachment(
				db,
				new TestApi("test-only-token"),
				typed,
				input,
			),
		);
		const replies = await db
			.prepare("SELECT * FROM telegram_web_support_replies")
			.all<Record<string, string | number>>();
		expect(replies.results).toHaveLength(1);
		const reply = replies.results[0];
		if (!reply) throw new Error("Missing encrypted reply");
		expect(String(reply.ciphertext)).not.toContain("staff reply");
		const wrapped = Buffer.from(String(reply.wrapped_key), "base64url");
		const rawKey = await crypto.subtle.decrypt(
			{ name: "RSA-OAEP" },
			privateKey,
			wrapped,
		);
		const key = await crypto.subtle.importKey("raw", rawKey, "AES-GCM", false, [
			"decrypt",
		]);
		const plaintext = await crypto.subtle.decrypt(
			{
				name: "AES-GCM",
				iv: Buffer.from(String(reply.iv), "base64url"),
				additionalData: new TextEncoder().encode(`${cid}:${reply.sequence}`),
			},
			key,
			Buffer.from(String(reply.ciphertext), "base64url"),
		);
		const decoded = JSON.parse(new TextDecoder().decode(plaintext));
		expect(decoded.text).toBe("staff reply");
		expect(decoded.attachment.name).toBe("reply.txt");
		const attachment = await db
			.prepare("SELECT id FROM telegram_web_support_attachments")
			.first<{ id: string }>();
		if (!attachment) throw new Error("Missing attachment");
		expect(
			await (
				await run(() =>
					downloadWebSupportAttachment(
						db,
						download(attachment.id),
						attachment.id,
					),
				)
			).text(),
		).toBe("attachment integration test");
	});
});
