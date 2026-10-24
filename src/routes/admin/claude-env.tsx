import { createFileRoute } from "@tanstack/react-router";
import { ClaudeEnvAdminPage } from "#/features/claude-env/pages/admin";

export const Route = createFileRoute("/admin/claude-env")({
	component: ClaudeEnvAdminPage,
});
