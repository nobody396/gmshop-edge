import { describe, expect, it } from "vitest";
import {
	guideProducts,
	guideProductUrl,
	guideStep,
} from "#/features/home/buying-guide-rules";

describe("VIP fixed buying guide", () => {
	it("covers every offered answer with a finite next step or explicit terminal", () => {
		const visit = (path: string[]) => {
			expect(path.length).toBeLessThanOrEqual(5);
			const step = guideStep(path);
			if (step.kind === "question") {
				expect(step.options.length).toBeGreaterThan(1);
				expect(new Set(step.options).size).toBe(step.options.length);
				expect(step.options.join(" ")).not.toMatch(/unknown|unsure|api|agent/);
				for (const answer of step.options) visit([...path, answer]);
			} else if (step.kind === "result") {
				expect(guideProducts[step.product]).toBeDefined();
				expect(guideProductUrl(step.product)).toBe(
					`/products/${guideProducts[step.product].productId}?item=${guideProducts[step.product].itemId}#purchase-options`,
				);
			} else expect(step.reason).toBeTruthy();
		};
		visit([]);
	});
	it("keeps Pro in the Pro branch regardless of an elapsed expiry date", () => {
		expect(guideStep(["gpt", "pro", "twenty"])).toMatchObject({
			kind: "question",
			id: "pro_php",
		});
		expect(guideStep(["gpt", "free", "twenty"])).toMatchObject({
			kind: "question",
			id: "new20",
		});
	});
	it("never sells ordinary 5X instead of the pending Plus difference upgrade", () => {
		expect(guideStep(["gpt", "plus", "five", "yes_php"])).toEqual({
			kind: "stop",
			reason: "upgrade_pending",
		});
		expect(guideStep(["gpt", "plus", "five", "no_php"])).toMatchObject({
			kind: "result",
			product: "fiveios",
			warning: "overwrite",
		});
	});
	it("only offers PHP renewal for the matching current Pro bill without payment warnings", () => {
		expect(
			guideStep(["gpt", "pro", "twenty", "yes_8919", "payment_clear"]),
		).toMatchObject({ kind: "result", product: "twentyrenew" });
		expect(
			guideStep(["gpt", "pro", "twenty", "yes_8919", "payment_problem"]),
		).toEqual({ kind: "stop", reason: "payment_issue" });
		expect(guideStep(["gpt", "plus", "twenty"])).toMatchObject({
			kind: "result",
			product: "gpt20ios",
			warning: "overwrite",
		});
	});
	it("requires real eligibility before a free account gets the restricted 20X new product", () => {
		expect(guideStep(["gpt", "free", "twenty", "eligible"])).toMatchObject({
			product: "twentynew",
		});
		expect(guideStep(["gpt", "free", "twenty", "ineligible"])).toMatchObject({
			product: "gpt20ios",
		});
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
	it("skips a redundant single-choice Grok question", () =>
		expect(guideStep(["grok"])).toMatchObject({
			kind: "result",
			product: "grok",
		}));
	it("does not silently recommend unverified Pro downgrades", () =>
		expect(guideStep(["gpt", "pro", "plus"])).toEqual({
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
