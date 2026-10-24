import { describe, expect, it } from "vitest";
import {
	beijingMinute,
	claudeEnvProductId,
	dayMs,
	daysLeft,
	desiredStatuses,
	dueReminderPoint,
	relaySlotStatuses,
	renewalPath,
	renewalSkuForPlan,
} from "#/features/claude-env/domain";
import { renderClaudeEnvExpiryEmail } from "#/features/claude-env/server/customer-email";

const expiresAt = Date.parse("2026-11-23T00:07:00Z");
const monthly = "c3bab030-0c3c-4451-9c41-3cc32538e778";
const quarterly = "1e599d3a-3aa2-498e-a955-f4b04a4abdc4";

describe("Claude env expiry rules", () => {
	it("has no grace status anywhere", () => {
		expect(desiredStatuses).toEqual(["provisioning", "active"]);
		expect(relaySlotStatuses).not.toContain("grace");
	});

	it("picks the nearest reached point and never earlier ones", () => {
		expect(dueReminderPoint(expiresAt, expiresAt - 7 * dayMs - 1)).toBeNull();
		expect(dueReminderPoint(expiresAt, expiresAt - 7 * dayMs)).toBe(7);
		expect(dueReminderPoint(expiresAt, expiresAt - 6 * dayMs)).toBe(7);
		expect(dueReminderPoint(expiresAt, expiresAt - 5 * dayMs)).toBe(5);
		expect(dueReminderPoint(expiresAt, expiresAt - 4 * dayMs)).toBe(5);
		expect(dueReminderPoint(expiresAt, expiresAt - 3 * dayMs)).toBe(3);
		expect(dueReminderPoint(expiresAt, expiresAt - 1)).toBe(3);
		expect(dueReminderPoint(expiresAt, expiresAt)).toBeNull();
	});

	it("rounds days left up and formats Beijing time", () => {
		expect(daysLeft(expiresAt, expiresAt - 7 * dayMs + 60_000)).toBe(7);
		expect(daysLeft(expiresAt, expiresAt - 4 * dayMs)).toBe(4);
		expect(daysLeft(expiresAt, expiresAt + 1)).toBe(0);
		expect(beijingMinute(expiresAt)).toBe("2026-11-23 08:07");
		expect(beijingMinute(Date.parse("2026-12-31T16:30:00Z"))).toBe(
			"2027-01-01 00:30",
		);
	});

	it("renews at the regular price of the same duration (early-bird is first period only)", () => {
		expect(renewalSkuForPlan("monthly")).toBe(monthly);
		expect(renewalSkuForPlan("eb_monthly")).toBe(monthly);
		expect(renewalSkuForPlan("quarterly")).toBe(quarterly);
		expect(renewalSkuForPlan("eb_quarterly")).toBe(quarterly);
		expect(renewalPath("eb_quarterly")).toBe(
			`/products/${claudeEnvProductId}?item=${quarterly}#purchase-options`,
		);
	});
});

describe("Claude env expiry email", () => {
	const base = {
		daysLeft: 5,
		expiresAt,
		plan: "eb_monthly",
		renewUrl: `https://laoshirenvip.com${renewalPath("eb_monthly")}`,
		unsubscribeUrl: "https://laoshirenvip.com/unsubscribe/renewal?e=a&sig=b",
	};

	it("Chinese: subject, exact expiry, renew link, keep-IP line and the bold warning", () => {
		const email = renderClaudeEnvExpiryEmail({ ...base, locale: "zh-CN" });
		expect(email.subject).toBe(
			"【老实人AI VIP】你的 Claude 专属环境还有 5 天到期",
		);
		expect(email.text).toContain("Claude 稳定使用环境");
		expect(email.text).toContain("到期时间：2026-11-23 08:07 北京时间");
		expect(email.text).toContain("续费后专属 IP 不变，不用重新配置。");
		expect(email.text).toContain(
			"如果不续费，到期后环境会立即失效，专属 IP 会被释放，再也无法找回。",
		);
		expect(email.text).toContain(`item=${monthly}`);
		expect(email.html).toContain(
			"<strong>如果不续费，到期后环境会立即失效，专属 IP 会被释放，再也无法找回。</strong>",
		);
		expect(email.html).toContain(`item=${monthly}#purchase-options`);
		for (const body of [email.subject, email.text, email.html])
			expect(body).not.toMatch(/iproyal|CE1-|coupon|优惠/i);
	});

	it("English for English orders", () => {
		const email = renderClaudeEnvExpiryEmail({
			...base,
			daysLeft: 3,
			locale: "en-US",
			unsubscribeUrl: null,
		});
		expect(email.subject).toBe(
			"[老实人AI VIP] Your dedicated Claude environment expires in 3 days",
		);
		expect(email.text).toContain("Expires: 2026-11-23 08:07 Beijing time");
		expect(email.text).toContain("It can never be recovered.");
		expect(email.text).not.toMatch(/iproyal|CE1-/i);
	});
});
