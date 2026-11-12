import { createFileRoute } from "@tanstack/react-router";
import { utilityPageHead } from "#/lib/seo";
import { UnauthorisedError } from "@/features/errors/unauthorized-error";

export const Route = createFileRoute("/(errors)/401")({
	head: () => utilityPageHead(),
	component: UnauthorisedError,
});
