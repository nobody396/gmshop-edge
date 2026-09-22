import { describe, expect, it } from "vitest";
import {
	requireLocalEmailVerificationForTrustedLinking,
	trustedAccountLinkingProviders,
} from "#/features/auth/server/auth-factory";

describe("authentication account-linking policy", () => {
	it("requires local verification before linking trusted social identities", () => {
		expect(trustedAccountLinkingProviders).toEqual(["telegram", "google"]);
		expect(requireLocalEmailVerificationForTrustedLinking).toBe(true);
	});
});
