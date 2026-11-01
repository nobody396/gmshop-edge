import { describe, expect, it } from "vitest";
import { sendTelegramOwnerPrivateFile } from "#/features/telegram/server/owner-alerts";

const credentials = { botToken: "123:TOKEN", chatId: "-1001" };

describe("owner private file", () => {
	it("sends the file to the chat creator's private chat, never the group", async () => {
		const calls: Array<{ method: string; body: unknown }> = [];
		const request = (async (url: string, init: RequestInit) => {
			const method = String(url).split("/").pop() ?? "";
			if (method === "getChatAdministrators") {
				calls.push({ method, body: JSON.parse(String(init.body)) });
				return Response.json({
					ok: true,
					result: [
						{ status: "administrator", user: { id: 2, is_bot: true } },
						{ status: "creator", user: { id: 777, is_bot: false } },
					],
				});
			}
			const form = init.body as FormData;
			calls.push({
				method,
				body: {
					chat_id: form.get("chat_id"),
					name: (form.get("document") as File).name,
					text: await (form.get("document") as File).text(),
				},
			});
			return Response.json({ ok: true, result: {} });
		}) as unknown as typeof fetch;
		await sendTelegramOwnerPrivateFile(
			credentials,
			{ name: "session-abc.txt", content: "SESSION", caption: "c" },
			request,
		);
		expect(calls).toEqual([
			{ method: "getChatAdministrators", body: { chat_id: "-1001" } },
			{
				method: "sendDocument",
				body: { chat_id: "777", name: "session-abc.txt", text: "SESSION" },
			},
		]);
	});
	it("refuses when Telegram rejects the private chat", async () => {
		const request = (async (url: string) =>
			String(url).endsWith("getChatAdministrators")
				? Response.json({
						ok: true,
						result: [{ status: "creator", user: { id: 7, is_bot: false } }],
					})
				: Response.json(
						{ ok: false, error_code: 403 },
						{ status: 403 },
					)) as unknown as typeof fetch;
		await expect(
			sendTelegramOwnerPrivateFile(
				credentials,
				{ name: "a.txt", content: "x", caption: "c" },
				request,
			),
		).rejects.toThrow("telegram_private_file_403");
	});
});
