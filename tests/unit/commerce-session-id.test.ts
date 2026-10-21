import { afterEach, describe, expect, it, vi } from "vitest";
import { randomSessionId } from "#/features/storefront/commerce-events";

const uuidV4 =
	/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("commerce session id", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("falls back to getRandomValues outside secure contexts", () => {
		vi.stubGlobal("crypto", {
			getRandomValues: globalThis.crypto.getRandomValues.bind(
				globalThis.crypto,
			),
		});
		expect(randomSessionId()).toMatch(uuidV4);
	});

	it("uses randomUUID when available", () => {
		expect(randomSessionId()).toMatch(uuidV4);
	});
});
