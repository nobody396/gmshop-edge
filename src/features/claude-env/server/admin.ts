import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { systemPermission } from "#/features/access/system-rbac";
import { getAdminRuntimeServerContext } from "#/server/context";
import {
	applySubscriptionAction,
	loadClaudeEnvAdmin,
	relayInputSchema,
	saveRelay,
	setClaudeEnvEnabled,
	subscriptionActionSchema,
} from "./admin-actions";
import { loadCrypt } from "./shared";

function actorOf(context: { currentUser: { id: string }; request: Request }) {
	return {
		userId: context.currentUser.id,
		requestId: context.request.headers.get("x-request-id"),
	};
}

export const getClaudeEnvAdminFn = createServerFn({ method: "GET" }).handler(
	async () => {
		const { db } = await getAdminRuntimeServerContext(
			systemPermission("delivery", "read"),
		);
		return loadClaudeEnvAdmin(db, Date.now());
	},
);

const enabledInput = z.object({ enabled: z.boolean() });

export const setClaudeEnvEnabledFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof enabledInput>) => enabledInput.parse(input))
	.handler(async ({ data }) => {
		const context = await getAdminRuntimeServerContext(
			systemPermission("delivery", "update"),
		);
		return setClaudeEnvEnabled(
			context.db,
			actorOf(context),
			data.enabled,
			Date.now(),
		);
	});

export const saveClaudeEnvRelayFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof relayInputSchema>) =>
		relayInputSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await getAdminRuntimeServerContext(
			systemPermission("delivery", "update"),
		);
		return saveRelay(
			context.db,
			await loadCrypt(context.db),
			actorOf(context),
			data,
			Date.now(),
		);
	});

export const claudeEnvSubscriptionActionFn = createServerFn({ method: "POST" })
	.validator((input: z.input<typeof subscriptionActionSchema>) =>
		subscriptionActionSchema.parse(input),
	)
	.handler(async ({ data }) => {
		const context = await getAdminRuntimeServerContext(
			systemPermission("delivery", "update"),
		);
		return applySubscriptionAction(
			{ db: context.db, crypt: await loadCrypt(context.db) },
			actorOf(context),
			data,
			Date.now(),
		);
	});
