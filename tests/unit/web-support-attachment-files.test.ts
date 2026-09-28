import { describe, expect, it } from "vitest";
import {
	decodeSupportReply,
	supportFileMaxBytes,
	validateSupportFile,
} from "../../src/features/telegram/web-support-attachments";

const utf8 = (text: string) => new TextEncoder().encode(text);
describe("Support file boundary", () => {
	it("accepts supported images, documents and UTF-8 logs", () => {
		expect(
			validateSupportFile(
				"截图.PNG",
				new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0]),
			).mime,
		).toBe("image/png");
		expect(validateSupportFile("a.pdf", utf8("%PDF-1.4")).mime).toBe(
			"application/pdf",
		);
		expect(validateSupportFile("debug.log", utf8("你好")).mime).toBe(
			"application/octet-stream",
		);
		expect(
			validateSupportFile("a.xlsx", new Uint8Array([80, 75, 3, 4, 1])).mime,
		).toBe("application/octet-stream");
	});
	it("rejects disguised images, executables, SVG and invalid sizes", () => {
		for (const name of ["fake.png", "x.svg", "x.exe", "x.html"])
			expect(() =>
				validateSupportFile(name, utf8("<script>alert(1)</script>")),
			).toThrow("file_type");
		expect(() => validateSupportFile("a.txt", new Uint8Array())).toThrow(
			"file_size",
		);
		expect(() =>
			validateSupportFile("a.txt", new Uint8Array(supportFileMaxBytes + 1)),
		).toThrow("file_size");
	});
	it("normalizes path and control characters", () =>
		expect(validateSupportFile("../x\r\n.txt", utf8("text")).name).toBe(
			".._x__.txt",
		));
	it("preserves ordinary and malformed text replies", () => {
		for (const text of [
			"Hello",
			'{"type":"web-support-attachment-v1","attachment":{"id":"bad"}}',
		])
			expect(decodeSupportReply(text)).toEqual({ text });
	});
	it("decodes valid encrypted attachment payloads", () => {
		const attachment = {
			id: crypto.randomUUID(),
			name: "a.txt",
			mime: "application/octet-stream",
			size: 1,
		};
		expect(
			decodeSupportReply(
				JSON.stringify({
					type: "web-support-attachment-v1",
					text: "Reply",
					attachment,
				}),
			).attachment,
		).toEqual(attachment);
	});
});
