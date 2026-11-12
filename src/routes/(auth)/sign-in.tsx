import { createFileRoute, redirect } from "@tanstack/react-router";
import { safePostAuthRedirect } from "#/features/auth/post-auth-redirect";
import { getInstallStatus } from "#/features/installation/server/functions";
import { utilityPageHead } from "#/lib/seo";
import { m } from "#/paraglide/messages";
import { SignIn } from "@/features/auth/pages/sign-in";

export const Route = createFileRoute("/(auth)/sign-in")({
	head: ({ matches }) =>
		utilityPageHead({ title: m.auth_signIn_title(), matches }),
	validateSearch: (search: Record<string, unknown>) => ({
		redirect: typeof search.redirect === "string" ? search.redirect : undefined,
	}),
	loader: async () => {
		const installStatus = await getInstallStatus();
		if (!installStatus.installed) throw redirect({ to: "/install" });
	},
	component: SignInRoute,
});

function SignInRoute() {
	const { redirect } = Route.useSearch();
	return <SignIn redirectTo={safePostAuthRedirect(redirect)} />;
}
