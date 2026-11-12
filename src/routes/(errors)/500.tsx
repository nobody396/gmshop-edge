import { createFileRoute } from "@tanstack/react-router";
import { utilityPageHead } from "#/lib/seo";
import { GeneralError } from "@/features/errors/general-error";

export const Route = createFileRoute("/(errors)/500")({
	head: () => utilityPageHead(),
	component: GeneralError,
});
