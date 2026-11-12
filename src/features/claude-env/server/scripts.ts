import { claudeEnvScriptFiles } from "../client-scripts/scripts.generated";

const paths = {
	"/claude-env.sh": "claude-env.sh",
	"/claude-env.ps1": "claude-env.ps1",
} as const;

const decoded = new Map<string, Uint8Array<ArrayBuffer>>();

export function claudeEnvScriptBytes(name: keyof typeof claudeEnvScriptFiles) {
	let bytes = decoded.get(name);
	if (!bytes) {
		bytes = Uint8Array.from(atob(claudeEnvScriptFiles[name].base64), (c) =>
			c.charCodeAt(0),
		);
		decoded.set(name, bytes);
	}
	return bytes;
}

/** Serves the customer setup scripts verbatim (the .ps1 keeps its UTF-8 BOM). */
export function handleClaudeEnvScriptRequest(request: Request) {
	if (request.method !== "GET" && request.method !== "HEAD") return null;
	const name = paths[new URL(request.url).pathname as keyof typeof paths];
	if (!name) return null;
	const bytes = claudeEnvScriptBytes(name);
	return new Response(request.method === "HEAD" ? null : bytes, {
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Content-Length": String(bytes.byteLength),
			"Cache-Control": "public, max-age=300",
			ETag: `"${claudeEnvScriptFiles[name].sha256}"`,
			"X-Content-Type-Options": "nosniff",
		},
	});
}
