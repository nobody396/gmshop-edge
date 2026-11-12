import { createFileRoute } from "@tanstack/react-router";
import { utilityPageHead } from "#/lib/seo";
import { NotFoundError } from "@/features/errors/not-found-error";

export const Route = createFileRoute("/(errors)/404")({
	head: () => utilityPageHead(),
	component: NotFoundError,
});
