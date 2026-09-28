import { afterEach, expect, it, vi } from "vitest";
import { supportFileRetentionMs } from "../../src/features/telegram/web-support-attachments";
import { loadWebSupportMessages } from "../../src/features/telegram/web-support-storage";

afterEach(() => vi.unstubAllGlobals());
it("deletes local text and attachments after exactly two days", async () => {
	expect(supportFileRetentionMs).toBe(172800000);
	const now = Date.now();
	const messages = [
		{ id: "old-text", createdAt: now - supportFileRetentionMs - 1 },
		{
			id: "old-file",
			createdAt: now - supportFileRetentionMs - 1,
			attachment: { name: "old.png" },
		},
		{ id: "recent", createdAt: now },
	];
	const removed: string[] = [];
	const request = (result: unknown) => ({
		result,
		set onsuccess(fn: () => void) {
			queueMicrotask(fn);
		},
		set onerror(_fn: unknown) {},
	});
	const close = vi.fn();
	const database = {
		close,
		transaction: () => ({
			objectStore: () => ({
				getAll: () => request(messages),
				delete: (id: string) => removed.push(id),
			}),
			set oncomplete(fn: () => void) {
				queueMicrotask(fn);
			},
			set onerror(_fn: unknown) {},
		}),
	};
	vi.stubGlobal("indexedDB", { open: () => request(database) });
	expect((await loadWebSupportMessages()).map((message) => message.id)).toEqual(
		["recent"],
	);
	expect(removed).toEqual(["old-text", "old-file"]);
	expect(close).toHaveBeenCalledOnce();
});
