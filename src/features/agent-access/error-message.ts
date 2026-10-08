import { m } from "#/paraglide/messages";
export function agentAccessErrorMessage(error: unknown) {
	const code =
		error && typeof error === "object" && "code" in error ? error.code : "";
	switch (code) {
		case "agent_access_existing_order":
			return m.agent_access_existing_order();
		case "agent_access_already_active":
			return m.agent_access_existing();
		case "agent_access_binding_required":
			return m.agent_access_bind();
		case "agent_access_terms_required":
			return m.agent_access_terms_missing();
		case "authentication_required":
		case "unauthorized":
		case "agent_access_email_verification":
			return m.agent_access_check_error();
		default:
			return m.agent_access_unavailable();
	}
}
