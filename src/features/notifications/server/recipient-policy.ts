// These reserved namespaces cannot receive production mail. No MX lookup is
// performed: a missing MX alone is not proof that a domain cannot receive mail.
export function isReservedEmailRecipient(email: string): boolean {
	const domain = email.trim().toLowerCase().split("@").at(-1) ?? "";
	return [
		"example.com",
		"example.net",
		"example.org",
		"invalid",
		"test",
		"example",
		"localhost",
	].some((reserved) => domain === reserved || domain.endsWith(`.${reserved}`));
}

export async function recipientHash(email: string): Promise<string> {
	const bytes = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(email.trim().toLowerCase()),
	);
	return Array.from(new Uint8Array(bytes), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
}

export async function recipientSuppressionReason(
	db: D1Database,
	email: string,
	event: string,
): Promise<string | null> {
	if (isReservedEmailRecipient(email)) return "recipient_reserved_domain";
	const suppression = await db
		.prepare(
			"SELECT reason FROM email_recipient_suppressions WHERE recipient_hash = ? LIMIT 1",
		)
		.bind(await recipientHash(email))
		.first<{ reason: string }>();
	if (suppression) return "recipient_hard_bounce";
	if (event.startsWith("auth.")) {
		const user = await db
			.prepare(
				"SELECT enabled FROM users WHERE email IN (?, ?) AND enabled = 0 LIMIT 1",
			)
			.bind(email.trim(), email.trim().toLowerCase())
			.first<{ enabled: number }>();
		if (user?.enabled === 0) return "recipient_account_disabled";
	}
	return null;
}
