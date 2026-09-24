import { m } from "#/paraglide/messages";

function errorCode(error: unknown) {
	if (!error || typeof error !== "object" || !("code" in error)) return;
	return typeof error.code === "string" ? error.code : undefined;
}

export function signInErrorMessage(error: unknown) {
	switch (errorCode(error)) {
		case "EMAIL_ADDRESS_UNDELIVERABLE":
			return m.auth_error_undeliverable_email();
		case "HUMAN_VERIFICATION_REQUIRED":
			return m.auth_human_verification_failed();
		case "TOO_MANY_REQUESTS":
			return m.auth_error_rate_limited();
		case "INVALID_EMAIL_OR_PASSWORD":
		case "INVALID_PASSWORD":
		case "USER_NOT_FOUND":
			return m.auth_error_invalid_credentials();
		case "EMAIL_NOT_VERIFIED":
			return m.auth_error_email_not_verified();
		default:
			return m.auth_signInFailed();
	}
}

export function changePasswordErrorMessage(error: unknown) {
	switch (errorCode(error)) {
		case "CURRENT_PASSWORD_REQUIRED":
			return m.account_change_password_old_password_required();
		case "NEW_PASSWORD_TOO_SHORT":
		case "PASSWORD_TOO_SHORT":
			return m.account_change_password_new_password_required();
		case "PASSWORD_TOO_LONG":
			return m.auth_error_password_too_long();
		case "PASSWORDS_DO_NOT_MATCH":
			return m.account_change_password_confirm_password_mismatch();
		case "INVALID_PASSWORD":
			return m.auth_error_current_password_invalid();
		case "SESSION_EXPIRED":
			return m.auth_error_session_expired();
		case "CREDENTIAL_ACCOUNT_NOT_FOUND":
			return m.auth_error_password_unavailable();
		default:
			return m.account_change_password_failed();
	}
}

export function authProviderErrorMessage(error: unknown) {
	switch (errorCode(error)) {
		case "auth_email_delivery_required":
			return m.auth_provider_error_email_delivery_required();
		case "auth_provider_incomplete":
			return m.auth_provider_error_incomplete();
		case "auth_provider_would_lock_accounts":
			return m.auth_provider_error_would_lock_accounts();
		case "auth_provider_conflict":
			return m.auth_provider_error_conflict();
		case "auth_provider_in_use":
			return m.auth_provider_error_in_use();
		default:
			return m.auth_provider_operation_failed();
	}
}
