import { describe, expect, it } from "vitest";
import {
	requireLocalEmailVerificationForTrustedLinking,
	trustedAccountLinkingProviders,
} from "#/features/auth/server/auth-factory";

describe("authentication account-linking policy", () => {
	it("automatically links verified Google identities and Telegram identities", () => {
		expect(trustedAccountLinkingProviders).toEqual(["telegram", "google"]);
		expect(requireLocalEmailVerificationForTrustedLinking).toBe(false);
	});
});
