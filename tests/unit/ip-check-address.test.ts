import { expect, it } from "vitest";
import {
	canonicalIp,
	knownAnycast,
	publicIpSchema,
} from "#/features/ip-check/address";

it("normalizes IPv6 before caching, comparisons and ranking", () => {
	expect(canonicalIp("2606:4700:4700:0000:0000:0000:0000:1111")).toBe(
		"2606:4700:4700::1111",
	);
	expect(publicIpSchema.parse("2606:4700:4700:0:0:0:0:1111")).toBe(
		"2606:4700:4700::1111",
	);
});
it("only positively identifies published anycast resolver addresses", () => {
	expect(knownAnycast("1.1.1.1")).toBe(true);
	expect(knownAnycast("2001:4860:4860:0:0:0:0:8888")).toBe(true);
	expect(knownAnycast("8.8.7.7")).toBeNull();
});
