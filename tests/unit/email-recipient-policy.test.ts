import { expect, it } from "vitest";
import {
	isReservedEmailRecipient,
	recipientHash,
} from "#/features/notifications/server/recipient-policy";

it("blocks exact reserved namespaces and their subdomains without substring false positives", () => {
	for (const email of [
		"probe@example.com",
		"Probe@EXAMPLE.COM ",
		"a@sub.example.org",
		"a@example.invalid",
		"a@localhost",
		"a@host.test",
	])
		expect(isReservedEmailRecipient(email)).toBe(true);
	for (const email of [
		"a@gmail.com",
		"a@qq.com",
		"a@myexample.com",
		"a@example.com.customer.org",
		"a@custom-domain.org",
	])
		expect(isReservedEmailRecipient(email)).toBe(false);
});
it("hashes the normalized recipient without retaining a plaintext address", async () => {
	expect(await recipientHash(" User@Customer.com ")).toBe(
		await recipientHash("user@customer.com"),
	);
	expect(await recipientHash("user@customer.com")).toMatch(/^[a-f0-9]{64}$/);
});
