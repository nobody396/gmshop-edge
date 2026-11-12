import { createFileRoute, redirect } from "@tanstack/react-router";
import { InstallPage } from "#/features/installation/pages/install";
import { getInstallStatus } from "#/features/installation/server/functions";
import { utilityPageHead } from "#/lib/seo";
import { m } from "#/paraglide/messages";

export const Route = createFileRoute("/install")({
	head: ({ matches }) => utilityPageHead({ title: m.install_title(), matches }),
	loader: async () => {
		const installStatus = await getInstallStatus();
		if (installStatus.installed) throw redirect({ to: "/admin" });
	},
	component: InstallPage,
});
