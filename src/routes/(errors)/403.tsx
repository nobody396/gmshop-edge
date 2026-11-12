import { createFileRoute } from "@tanstack/react-router";
import { utilityPageHead } from "#/lib/seo";
import { ForbiddenError } from "@/features/errors/forbidden";

export const Route = createFileRoute("/(errors)/403")({
	head: () => utilityPageHead(),
	component: ForbiddenError,
});
