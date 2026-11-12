import { createFileRoute } from "@tanstack/react-router";
import { AuthLayout } from "#/layouts/auth";
import { utilityPageHead } from "#/lib/seo";

export const Route = createFileRoute("/(auth)")({
	// Sign-in, registration and password flows are never search landing pages.
	head: () => utilityPageHead(),
	component: AuthLayout,
});
