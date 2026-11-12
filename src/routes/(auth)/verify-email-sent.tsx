import { createFileRoute } from "@tanstack/react-router";
import { VerifyEmailSentPage } from "#/features/auth/pages/verify-email-sent";
import { utilityPageHead } from "#/lib/seo";

export const Route = createFileRoute("/(auth)/verify-email-sent")({
	head: () => utilityPageHead(),
	component: VerifyEmailSentPage,
});
