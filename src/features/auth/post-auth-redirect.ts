const redirectBase = new URL("https://gmshop.invalid");

export function safePostAuthRedirect(value: unknown) {
	if (typeof value !== "string" || !value.startsWith("/")) return "/";
	if (value.includes("\\") || /%5c/i.test(value)) return "/";
	try {
		const target = new URL(value, redirectBase);
		if (
			target.origin !== redirectBase.origin ||
			target.username ||
			target.password
		) {
			return "/";
		}
		return `${target.pathname}${target.search}${target.hash}`;
	} catch {
		return "/";
	}
}
