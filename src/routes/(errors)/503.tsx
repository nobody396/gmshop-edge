import { createFileRoute } from "@tanstack/react-router";
import { utilityPageHead } from "#/lib/seo";
import { MaintenanceError } from "@/features/errors/maintenance-error";

export const Route = createFileRoute("/(errors)/503")({
	head: () => utilityPageHead(),
	component: MaintenanceError,
});
