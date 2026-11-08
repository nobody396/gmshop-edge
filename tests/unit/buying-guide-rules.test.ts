import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	guideProducts,
	guideProductUrl,
	guideStep,
} from "#/features/home/buying-guide-rules";

describe("VIP fixed buying guide", () => {
	it("covers every offered answer with a finite next step or explicit terminal", () => {
		const visit = (path: string[]) => {
			expect(path.length).toBeLessThanOrEqual(7);
			const step = guideStep(path);
			if (step.kind === "question") {
				expect(step.options.length).toBeGreaterThan(1);
				expect(new Set(step.options).size).toBe(step.options.length);
				expect(step.options.join(" ")).not.toMatch(/unknown|unsure|api|agent/);
				for (const answer of step.options) visit([...path, answer]);
			} else if (step.kind === "result") {
				expect(guideProducts[step.product]).toBeDefined();
				if (
					[
						"plusph",
						"fiveph",
						"twentynew",
						"fivecl",
						"gpt500cl",
						"goin",
					].includes(step.product)
				)
					expect(path[1]).toBe("free");
				// Only a PH web subscription may pay the difference to upgrade.
				if (step.product === "gptupgrade") expect(path[2]).toBe("current_ph");
				expect(path).not.toContain("after_expiry");
				if (step.product === "twentyrenew") {
					expect(path.slice(0, 3)).toEqual(["gpt", "pro200", "current_ph"]);
					expect(path.at(-2)).toBe("yes_8919");
					expect(path.at(-1)).toBe("ph_renew");
				}
				if (
					path[1] === "pro200" &&
					path[2] === "current_ios" &&
					path[3] === "twenty"
				)
					expect(step.product).toBe("gpt20ios");
				if (path[0] === "gpt" && step.product !== "gptupgrade")
					expect(guideProducts[step.product].productId).toBe(
						"2a794b89-3bb9-49d4-8691-0d13a1606869",
					);
				expect(guideProductUrl(step.product)).toBe(
					step.product === "gptupgrade"
						? "https://redeem.laoshirenvip.com/upgrade"
						: `/products/${guideProducts[step.product].productId}?item=${guideProducts[step.product].itemId}#purchase-options`,
				);
			} else expect(step.reason).toBeTruthy();
		};
		visit([]);
	});
	it("distinguishes current Pro tiers without guessing from an expiry date", () => {
		expect(guideStep(["gpt"])).toMatchObject({
			id: "gpt_current",
			options: ["free", "go", "plus", "pro100", "pro200", "pro500"],
		});
		for (const current of ["plus", "pro100", "pro200"])
			expect(guideStep(["gpt", current])).toMatchObject({
				id: "current_channel",
			});
		expect(guideStep(["gpt", "pro500", "twenty"])).toMatchObject({
			id: "timing",
		});
	});
	it.each([
		["plus", "plusph", "plusios"],
		["five", "fiveph", "fiveios"],
		["twenty", "twentynew", "gpt20ios"],
	])("lets Free accounts choose either channel for %s, with no qualification gate", (target, ph, ios) => {
		expect(guideStep(["gpt", "free", target])).toMatchObject({
			id: "channel",
			options: target === "five" ? ["ph", "cl", "ios"] : ["ph", "ios"],
		});
		expect(guideStep(["gpt", "free", target, "ph"])).toMatchObject({
			kind: "result",
			product: ph,
		});
		expect(guideStep(["gpt", "free", target, "ios"])).toMatchObject({
			kind: "result",
			product: ios,
		});
	});
	it("does not infer immediate iOS overwrite from Plus → Plus", () => {
		expect(guideStep(["gpt", "plus", "current_ios", "plus"])).toMatchObject({
			id: "timing",
			options: ["recharge_now", "after_expiry"],
		});
		expect(
			guideStep(["gpt", "plus", "current_ios", "plus", "recharge_now"]),
		).toMatchObject({
			kind: "result",
			product: "plusios",
			warning: "overwrite30",
		});
		expect(
			guideStep(["gpt", "plus", "current_ios", "plus", "after_expiry"]),
		).toEqual({
			kind: "stop",
			reason: "wait_for_expiry",
		});
	});
	it("offers the paid-difference upgrade to PH web subscriptions moving up a tier", () => {
		const path = ["gpt", "plus", "current_ph", "five", "recharge_now"];
		expect(guideStep(path)).toMatchObject({
			id: "upgrade_channel",
			options: ["ph_upgrade", "ios"],
		});
		expect(guideStep([...path, "ph_upgrade"])).toEqual({
			kind: "result",
			product: "gptupgrade",
		});
		expect(
			guideStep(["gpt", "pro100", "current_ph", "twenty", "recharge_now"]),
		).toMatchObject({ id: "upgrade_channel" });
		// Pro 500 has no iOS channel: the upgrade is the only way up.
		for (const current of ["plus", "pro100", "pro200"])
			expect(
				guideStep([
					"gpt",
					current,
					"current_ph",
					"fivehundred",
					"recharge_now",
				]),
			).toEqual({ kind: "result", product: "gptupgrade" });
		// App Store subscriptions cannot be upgraded on the web.
		expect(
			guideStep(["gpt", "plus", "current_ios", "fivehundred", "recharge_now"]),
		).toEqual({ kind: "stop", reason: "fivehundred_active" });
		expect(guideStep([...path, "ios"])).toMatchObject({
			kind: "result",
			product: "fiveios",
			warning: "overwrite30",
		});
		expect(
			guideStep(["gpt", "plus", "current_ios", "five", "recharge_now"]),
		).toMatchObject({ product: "fiveios", warning: "overwrite30" });
	});
	it("routes current PH Pro $200 to its dedicated renewal only after matching the bill", () => {
		const path = ["gpt", "pro200", "current_ph", "twenty", "recharge_now"];
		expect(guideStep(path)).toMatchObject({
			id: "pro_php",
			options: ["yes_8919", "no_8919"],
		});
		expect(guideStep([...path, "yes_8919"])).toMatchObject({
			id: "renew_channel",
			options: ["ph_renew", "ios"],
		});
		expect(guideStep([...path, "yes_8919", "ph_renew"])).toMatchObject({
			product: "twentyrenew",
			warning: undefined,
		});
		expect(guideStep([...path, "yes_8919", "ios"])).toMatchObject({
			product: "gpt20ios",
			warning: "overwrite30",
		});
		expect(guideStep([...path, "no_8919"])).toEqual({
			kind: "stop",
			reason: "renew_bill_mismatch",
		});
	});
	it("routes current iOS Pro $200 through iOS without offering PH renewal or a PHP bill question", () => {
		expect(
			guideStep(["gpt", "pro200", "current_ios", "twenty", "recharge_now"]),
		).toMatchObject({
			kind: "result",
			product: "gpt20ios",
			warning: "overwrite30",
		});
		expect(
			guideStep(["gpt", "pro100", "current_ios", "twenty", "recharge_now"]),
		).toMatchObject({ product: "gpt20ios", warning: "overwrite30" });
	});
	it("does not infer an iOS subscription from an unverified or other channel", () => {
		expect(guideStep(["gpt", "pro200", "current_other"])).toEqual({
			kind: "stop",
			reason: "rule_pending",
		});
		expect(guideStep(["gpt", "pro200", "twenty"])).toEqual({
			kind: "stop",
			reason: "rule_pending",
		});
	});
	it("allows verified same-tier Pro $100 overwrite without treating it as Pro $200", () => {
		expect(
			guideStep(["gpt", "pro100", "current_ios", "five", "recharge_now"]),
		).toMatchObject({
			product: "fiveios",
			warning: "overwrite30",
		});
	});
	it("does not recommend any immediate purchase when the user chooses to wait", () => {
		for (const current of ["go", "plus", "pro100", "pro200", "pro500"])
			for (const target of ["go", "plus", "five", "twenty", "fivehundred"])
				expect(
					guideStep([
						"gpt",
						current,
						...(["plus", "pro100", "pro200"].includes(current)
							? ["current_ios"]
							: []),
						target,
						"after_expiry",
					]).kind,
				).toBe("stop");
	});
	it("maps the opened $500 SKU exactly but never overwrites an active subscription", () => {
		expect(guideStep(["gpt", "free", "fivehundred", "ph"])).toMatchObject({
			product: "gpt500",
		});
		expect(guideProducts.gpt500.itemId).toBe(
			"030582df-98c1-5b87-914d-28ddc606e163",
		);
		for (const current of ["go", "plus", "pro100", "pro200", "pro500"])
			expect(
				guideStep([
					"gpt",
					current,
					...(["plus", "pro100", "pro200"].includes(current)
						? ["current_ios"]
						: []),
					"fivehundred",
					"recharge_now",
				]),
			).toEqual({ kind: "stop", reason: "fivehundred_active" });
	});
	it("blocks Free credits and active Claude subscriptions", () => {
		expect(guideStep(["points", "free"])).toEqual({
			kind: "stop",
			reason: "free_points",
		});
		expect(guideStep(["claude", "claude_paid"])).toEqual({
			kind: "stop",
			reason: "claude_active",
		});
		expect(guideStep(["claude", "claude_free", "claudefive"])).toMatchObject({
			warning: "kyc",
		});
	});
	it("routes the X subscription by membership and the first-month offer", () => {
		expect(guideStep(["x", "x_member"])).toEqual({
			kind: "stop",
			reason: "x_active",
		});
		expect(guideStep(["x", "x_none", "xplus"])).toEqual({
			kind: "result",
			product: "xplus",
		});
		// The standard card is for accounts without the first-month offer.
		expect(guideStep(["x", "x_none", "xpremium", "offer_no"])).toEqual({
			kind: "result",
			product: "xpremium",
		});
		expect(guideStep(["x", "x_none", "xultra", "offer_yes"])).toEqual({
			kind: "result",
			product: "xultrah50",
		});
		expect(guideStep(["x", "x_none", "xpremium1y"])).toEqual({
			kind: "result",
			product: "xpremium1y",
		});
	});
	it("offers Chile only to Free accounts", () => {
		expect(guideStep(["gpt", "free", "five", "cl"])).toEqual({
			kind: "result",
			product: "fivecl",
		});
		expect(guideStep(["gpt", "free", "fivehundred", "cl"])).toEqual({
			kind: "result",
			product: "gpt500cl",
		});
		expect(guideStep(["gpt", "free", "fivehundred"])).toMatchObject({
			kind: "question",
			options: ["ph", "cl"],
		});
	});
	it("does not silently recommend unverified Pro downgrades", () =>
		expect(
			guideStep(["gpt", "pro200", "current_ios", "plus", "recharge_now"]),
		).toEqual({
			kind: "stop",
			reason: "rule_pending",
		}));
});

it("has Chinese and English copy for every reachable question, answer and stop", async () => {
	const { readFile } = await import("node:fs/promises");
	const catalogs = await Promise.all(
		["zh-CN", "en-US"].map(
			async (locale) =>
				JSON.parse(await readFile(`messages/${locale}.json`, "utf8")) as Record<
					string,
					string
				>,
		),
	);
	expect(catalogs[0]?.guide_fivehundred).toBe("Pro 500");
	expect(catalogs[1]?.guide_fivehundred).toBe("Pro $500 tier");
	const visit = (path: string[]) => {
		const step = guideStep(path);
		const keys =
			step.kind === "question"
				? [step.id, ...step.options]
				: step.kind === "stop"
					? [step.reason, `${step.reason}_body`]
					: [
							"result",
							...(step.warning ? [step.warning, `${step.warning}_accept`] : []),
						];
		for (const c of catalogs)
			for (const key of keys) expect(c[`guide_${key}`], key).toBeTruthy();
		if (step.kind === "question")
			for (const option of step.options) visit([...path, option]);
	};
	visit([]);
});

it("does not apply the ChatGPT 30-day reset copy to other products", () => {
	expect(
		guideStep(["gpt", "plus", "current_ios", "five", "recharge_now"]),
	).toMatchObject({
		warning: "overwrite30",
	});
	expect(guideStep(["x", "x_none", "xplus"])).toEqual({
		kind: "result",
		product: "xplus",
		warning: undefined,
	});
});
it("sends Free accounts to India card-paid Go and covers the newer catalog", () => {
	expect(guideStep(["gpt", "free", "go"])).toEqual({
		kind: "result",
		product: "goin",
	});
	expect(guideStep(["gpt", "go", "go", "recharge_now"])).toMatchObject({
		product: "go",
		warning: "overwrite30",
	});
	expect(guideStep(["telegram", "tg12"])).toEqual({
		kind: "result",
		product: "tg12",
	});
	expect(guideStep(["gmail", "gmailus"])).toEqual({
		kind: "result",
		product: "gmailus",
	});
	expect(guideStep(["claudeenv", "envquarter"])).toEqual({
		kind: "result",
		product: "envquarter",
	});
	expect(guideStep(["sms", "smsgoogle"])).toEqual({
		kind: "result",
		product: "smsgoogle",
	});
	expect(guideStep([])).toMatchObject({
		options: expect.not.arrayContaining(["muse"]),
	});
});

const smsSpecs = [
	[
		"smsone",
		"cdccd3bc-4504-5521-8761-332c99910c9f",
		"25a7ae5b-f437-5461-bfca-669870e3b887",
	],
	[
		"smslong",
		"a9f6b8c4-e302-5c1a-8947-780785672b32",
		"a39b3590-0952-5886-9076-a9cd879c1975",
	],
	[
		"smsclaude",
		"ff4ff1f6-cad4-4821-a195-39befdcc32d6",
		"e23b7fb9-1e1c-4b47-a110-d9f84a02a52c",
	],
	[
		"smsgoogle",
		"8f78192a-3097-4ec2-a771-5aa76d1bccab",
		"d353aa0e-fd21-4ecc-9a0b-9ad9a5e64da4",
	],
	[
		"smstiktok",
		"0375b7ba-9b49-4ff4-9652-40fedf7fbf0d",
		"174e12ab-0383-4f84-a14b-c88151a0be3c",
	],
	[
		"smstelegram",
		"4d5aba11-5102-4d06-a11d-7d33279c8fa8",
		"88aff5d3-a5ca-4ce3-9839-4149fe1d37ef",
	],
] as const;

it("offers six SMS choices with the on-sale one-time card first", () => {
	expect(guideStep(["sms"])).toEqual({
		kind: "question",
		id: "sms_target",
		options: smsSpecs.map(([key]) => key),
		help: undefined,
	});
	expect(guideStep(["sms", "unknown"])).toEqual({
		kind: "stop",
		reason: "rule_pending",
	});
	expect(smsSpecs).toHaveLength(6);
	expect(smsSpecs[0][0]).toBe("smsone");
});
it.each(
	smsSpecs,
)("maps %s to its explicit product and item", (key, productId, itemId) => {
	expect(guideStep(["sms", key])).toEqual({ kind: "result", product: key });
	expect(guideProducts[key]).toEqual({ productId, itemId });
	expect(guideProductUrl(key)).toBe(
		`/products/${productId}?item=${itemId}#purchase-options`,
	);
});
it.each(["zh-CN", "en-US"])("localizes all SMS choices in %s", (locale) => {
	const copy = JSON.parse(
		readFileSync(
			new URL(`../../messages/${locale}.json`, import.meta.url),
			"utf8",
		),
	);
	for (const [key] of smsSpecs) expect(copy[`guide_${key}`]).toBeTruthy();
	expect(copy.guide_smslong).toContain("ChatGPT / Codex");
	expect(copy.guide_smsgoogle).toContain("23–30");
	expect(copy.guide_smstiktok).toContain("16–30");
	expect(copy.guide_smstelegram).toContain("61–92");
	for (const platform of [
		"ChatGPT / Codex",
		"Claude",
		"Google / Gmail",
		"TikTok",
		"Telegram",
	])
		expect(copy.guide_sms_hint).toContain(platform);
});
