import { createServerFn } from "@tanstack/react-start";
import { getRequest, setResponseHeader } from "@tanstack/react-start/server";
import { z } from "zod";
import { loadPrivateGuide } from "#/features/guides/server/public-guide";
import { resolveStoreAccount } from "#/features/storefront/server/account";
import { DomainError } from "#/lib/domain-error";
import { getDb } from "#/server/db.server";
import { claudeEnvGuideSlug } from "./customer-email";
import { loadClaudeEnvPanel, revealClaudeEnvCode } from "./panel";
import { loadCrypt } from "./shared";
import { ingestTrafficForOrder } from "./traffic";

const orderSchema = z.object({ orderNumber: z.string().min(1).max(100) });

/** Logged-in buyer only; ownership is checked in SQL against the session user. */
async function buyer() {
	const request = getRequest();
	setResponseHeader("Cache-Control", "no-store");
	if (request.headers.get("origin") !== new URL(request.url).origin)
		throw new DomainError("origin_invalid", 403, "Origin is not allowed");
	const db = getDb(request).$client;
	const account = await resolveStoreAccount(db, request, { required: true });
	if (!account)
		throw new DomainError("authentication_required", 401, "Sign in required");
	return { db, user: account.user };
}

export const getClaudeEnvPanelFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof orderSchema>) => orderSchema.parse(input))
	.handler(async ({ data }) => {
		const { db, user } = await buyer();
		const now = Date.now();
		// A just-paid traffic add-on order counts as soon as its page is open.
		await ingestTrafficForOrder(db, user.id, data.orderNumber, now).catch(
			() => 0,
		);
		return loadClaudeEnvPanel(db, user.id, data.orderNumber, now);
	});

export const revealClaudeEnvCodeFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof orderSchema>) => orderSchema.parse(input))
	.handler(async ({ data }) => {
		const { db, user } = await buyer();
		const result = await revealClaudeEnvCode(
			db,
			await loadCrypt(db),
			user.id,
			data.orderNumber,
		);
		if (!result)
			throw new DomainError("claude_env_not_ready", 409, "Not ready yet");
		return result;
	});

/**
 * The full Claude env setup guide: kept as a draft so it is never public, and
 * shown only to signed-in buyers who have (or had) a Claude env subscription.
 */
export const getClaudeEnvGuideFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const request = getRequest();
		setResponseHeader("Cache-Control", "private, no-store");
		const db = getDb(request).$client;
		const account = await resolveStoreAccount(db, request, { required: true });
		if (!account)
			throw new DomainError("authentication_required", 401, "Sign in required");
		const owns = await db
			.prepare(
				"SELECT 1 AS owns FROM claude_env_subscriptions WHERE user_id = ? LIMIT 1",
			)
			.bind(account.user.id)
			.first<{ owns: number }>();
		if (!owns) return { allowed: false as const, guide: null };
		return {
			allowed: true as const,
			guide: await loadPrivateGuide(db, claudeEnvGuideSlug),
		};
	},
);
