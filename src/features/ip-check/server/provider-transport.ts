// Workers accepts only manual/follow. Reject 3xx at the caller; never follow redirects.
export function fetchProvider(url: string) {
	return fetch(url, {
		signal: AbortSignal.timeout(4000),
		redirect: "manual",
		headers: { accept: "application/json" },
	});
}

export async function readProviderJson(response: Response): Promise<unknown> {
	if (!response.body) throw new Error("Empty provider response");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.length;
			if (length > 65536) throw new Error("Provider response too large");
			chunks.push(value);
		}
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.length;
	}
	return JSON.parse(new TextDecoder().decode(bytes));
}
