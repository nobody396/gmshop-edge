import { createFileRoute } from "@tanstack/react-router";
import { ForgotPasswordPage } from "#/features/auth/pages/forgot-password";
import { utilityPageHead } from "#/lib/seo";

export const Route = createFileRoute("/(auth)/forgot-password")({
	head: () => utilityPageHead(),
	component: ForgotPasswordPage,
});
