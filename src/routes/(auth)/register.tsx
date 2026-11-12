import { createFileRoute, redirect } from "@tanstack/react-router";
import { RegisterPage } from "#/features/auth/pages/register";
import { getInstallStatus } from "#/features/installation/server/functions";
import { utilityPageHead } from "#/lib/seo";
import { m } from "#/paraglide/messages";

export const Route = createFileRoute("/(auth)/register")({
	head: ({ matches }) =>
		utilityPageHead({ title: m.auth_register_title(), matches }),
	loader: async () => {
		const installStatus = await getInstallStatus();
		if (!installStatus.installed) throw redirect({ to: "/install" });
	},
	component: RegisterPage,
});
