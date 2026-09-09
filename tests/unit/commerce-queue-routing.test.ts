import { describe, expect, it } from "vitest";
import { queueMessageKind, retryDelaySeconds } from "#/server/queue/routing";

describe("commerce queue envelope routing", () => {
	it.each([
		{ kind: "commerce.delivery", version: 1, deliveryId: "delivery-1" },
		{ kind: "commerce.automation", version: 1, automationJobId: "build-1" },
		{
			kind: "commerce.notification",
			version: 1,
			notificationDeliveryId: "notification-1",
		},
		{ kind: "commerce.refund", version: 1, refundId: "refund-1" },
		{
			kind: "commerce.inventory-event",
			version: 1,
			outboxId: "inventory-event-1",
		},
	])("accepts $kind", (message) => {
		expect(queueMessageKind(message)).toBe("commerce");
	});

	it.each([
		{ kind: "payment.scan", version: 1, orderId: "legacy" },
		{ kind: "webhook.delivery", version: 1, deliveryId: "legacy" },
		{ kind: "commerce.delivery", version: 2, deliveryId: "delivery-1" },
		{ kind: "commerce.delivery", version: 1, deliveryId: "", extra: true },
		null,
	])("rejects unsupported envelope %#", (message) => {
		expect(queueMessageKind(message)).toBe("invalid");
	});

	it("applies bounded exponential retry delays", () => {
		expect([1, 2, 3, 4, 5, 6].map(retryDelaySeconds)).toEqual([
			15, 30, 60, 120, 240, 300,
		]);
		expect(retryDelaySeconds(20)).toBe(300);
	});
});
