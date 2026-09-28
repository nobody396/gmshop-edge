import { z } from "zod";

export const supportFileMaxBytes = 10 * 1024 * 1024;
export const supportFileRetentionMs = 7 * 86_400_000;
export const supportFileAccept =
	".png,.jpg,.jpeg,.webp,.gif,.pdf,.txt,.log,.csv,.json,.zip,.docx,.xlsx";
export const supportAttachmentSchema = z.object({
	id: z.uuid(),
	name: z.string().min(1).max(180),
	mime: z.string().max(100),
	size: z.number().int().positive().max(supportFileMaxBytes),
});
export type SupportAttachment = z.infer<typeof supportAttachmentSchema>;
const replySchema = z.object({
	type: z.literal("web-support-attachment-v1"),
	text: z.string().max(3500),
	attachment: supportAttachmentSchema,
});
export function decodeSupportReply(text: string): {
	text: string;
	attachment?: SupportAttachment;
} {
	try {
		const result = replySchema.safeParse(JSON.parse(text));
		if (result.success) return result.data;
	} catch {
		/* Ordinary text replies remain unchanged. */
	}
	return { text };
}
export function supportAttachmentUrl(id: string, download = false) {
	return `/api/support/web/attachments/${encodeURIComponent(id)}${download ? "?download=1" : ""}`;
}

export function validateSupportFile(name: string, bytes: Uint8Array) {
	const cleanName = name
		// biome-ignore lint/suspicious/noControlCharactersInRegex: strip unsafe filename controls
		.replace(/[\\/\u0000-\u001f\u007f]/g, "_")
		.slice(0, 180);
	const extension = cleanName.split(".").pop()?.toLowerCase();
	if (!bytes.length || bytes.length > supportFileMaxBytes)
		throw new Error("file_size");
	const starts = (...values: number[]) =>
		values.every((value, index) => bytes[index] === value);
	const text = new TextDecoder().decode(bytes.slice(0, 16));
	const images: Record<string, [string, boolean]> = {
		png: ["image/png", starts(137, 80, 78, 71, 13, 10, 26, 10)],
		jpg: ["image/jpeg", starts(255, 216, 255)],
		jpeg: ["image/jpeg", starts(255, 216, 255)],
		gif: ["image/gif", text.startsWith("GIF87a") || text.startsWith("GIF89a")],
		webp: [
			"image/webp",
			text.startsWith("RIFF") && text.slice(8, 12) === "WEBP",
		],
	};
	const image = images[extension ?? ""];
	if (image?.[1])
		return { name: cleanName, mime: image[0], size: bytes.length };
	if (extension === "pdf" && text.startsWith("%PDF-"))
		return { name: cleanName, mime: "application/pdf", size: bytes.length };
	if (["zip", "docx", "xlsx"].includes(extension ?? "") && starts(80, 75, 3, 4))
		return {
			name: cleanName,
			mime: "application/octet-stream",
			size: bytes.length,
		};
	if (["txt", "log", "csv", "json"].includes(extension ?? "")) {
		// These are always downloads, never HTML/script documents rendered in-page.
		try {
			new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		} catch {
			throw new Error("file_type");
		}
		if (!bytes.includes(0))
			return {
				name: cleanName,
				mime: "application/octet-stream",
				size: bytes.length,
			};
	}
	throw new Error("file_type");
}
