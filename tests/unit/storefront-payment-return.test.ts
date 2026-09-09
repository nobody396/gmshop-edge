import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const orderPage = readFileSync(
	new URL("../../src/features/storefront/pages/order.tsx", import.meta.url),
	"utf8",
);
const serverFunctions = readFileSync(
	new URL("../../src/features/storefront/server/functions.ts", import.meta.url),
	"utf8",
);

describe("storefront payment return", () => {
	it("marks provider success URLs as payment returns", () => {
		expect(
			serverFunctions.match(/storePaymentReturnUrl\(origin, orderPath\)/g),
		).toHaveLength(2);
	});

	it("hides repeat-payment actions while the successful return is synchronizing", () => {
		expect(orderPage).toContain(
			'paymentReturning && data.status === "pending_payment"',
		);
		expect(orderPage).toContain("store_payment_return_processing_description");
		expect(orderPage).toContain(
			'paymentReturning && query.state.data?.status === "pending_payment"',
		);
		expect(orderPage).toContain("? 1_000");
	});
});
