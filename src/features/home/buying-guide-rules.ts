// Explicit VIP product mapping. Never infer eligibility from names or prices.
export const guideProducts = {
	gpt20ios: {
		productId: "02334569-a5e0-42d9-8615-69980273a6cc",
		itemId: "4af92545-aa49-4e1a-8381-f459fc76bed5",
	},
	go: {
		productId: "2a794b89-3bb9-49d4-8691-0d13a1606869",
		itemId: "983f6e73-061e-419d-a7d5-8ac5ec5648ab",
	},
	plusph: {
		productId: "2a794b89-3bb9-49d4-8691-0d13a1606869",
		itemId: "362d3add-4901-4b4c-b6a9-27aea63473e4",
	},
	plusios: {
		productId: "2a794b89-3bb9-49d4-8691-0d13a1606869",
		itemId: "efc0cc87-b7ed-4bd5-b792-e9f455fda8eb",
	},
	fiveios: {
		productId: "2a794b89-3bb9-49d4-8691-0d13a1606869",
		itemId: "f8c7ee24-239c-43a1-abe7-9dd40c53de21",
	},
	fiveph: {
		productId: "2a794b89-3bb9-49d4-8691-0d13a1606869",
		itemId: "bf88dfff-914a-4413-b4a9-19d56d30feca",
	},
	twentyrenew: {
		productId: "aa277f98-79b4-58cb-8b7b-1424fe930ab9",
		itemId: "624bf652-debb-48f4-ab98-6b9daab2a6ea",
	},
	twentynew: {
		productId: "2a794b89-3bb9-49d4-8691-0d13a1606869",
		itemId: "0829de43-da22-420c-9866-38c83dd420f0",
	},
	points250: {
		productId: "afb8af99-86af-463e-a76f-fcea2edd22dd",
		itemId: "7f76a172-d963-43a4-8297-d4d7550f4670",
	},
	points500: {
		productId: "afb8af99-86af-463e-a76f-fcea2edd22dd",
		itemId: "1572316f-0649-43d5-b86f-2c551f10833e",
	},
	points1000: {
		productId: "afb8af99-86af-463e-a76f-fcea2edd22dd",
		itemId: "902c0f18-1c50-4b75-9cc2-62e432716e0c",
	},
	points2500: {
		productId: "afb8af99-86af-463e-a76f-fcea2edd22dd",
		itemId: "ea366d71-6d3b-4e0d-8551-242a3a1ca483",
	},
	claudepro: {
		productId: "ba540b83-388d-45d1-9dcb-25c3da3f9956",
		itemId: "efa6e9ae-f8a6-4cf7-b99c-72e51e68dace",
	},
	claudefive: {
		productId: "ba540b83-388d-45d1-9dcb-25c3da3f9956",
		itemId: "d3a2050e-1c65-4c7e-9ad7-3c8892ef412e",
	},
	claudetwenty: {
		productId: "ba540b83-388d-45d1-9dcb-25c3da3f9956",
		itemId: "34c18e6b-c4d5-4289-9c6b-ab47fa027182",
	},
	xpremium: {
		productId: "13ca1b04-19d6-4bbd-98b4-b7884e159ab1",
		itemId: "dfb87d8d-3d4c-4e7f-be87-ae4b4985a6f8",
	},
	xplusmonth: {
		productId: "13ca1b04-19d6-4bbd-98b4-b7884e159ab1",
		itemId: "ef966363-c7a4-4df3-95a1-58de9f95a66a",
	},
	xplusyear: {
		productId: "13ca1b04-19d6-4bbd-98b4-b7884e159ab1",
		itemId: "c6bffdcb-fe6f-5f34-a0c4-e8784e083b01",
	},
	grok: {
		productId: "a48aeca2-90bf-4adf-8cfa-f18204373435",
		itemId: "b3120be0-f106-4bbe-b972-ba4b3870493c",
	},
	smsone: {
		productId: "cdccd3bc-4504-5521-8761-332c99910c9f",
		itemId: "25a7ae5b-f437-5461-bfca-669870e3b887",
	},
	smslong: {
		productId: "a9f6b8c4-e302-5c1a-8947-780785672b32",
		itemId: "a39b3590-0952-5886-9076-a9cd879c1975",
	},
} as const;
export type GuideProduct = keyof typeof guideProducts;
export type GuideStep =
	| {
			kind: "question";
			id: string;
			options: string[];
			help?: "plan" | "billing" | "eligibility" | "claude";
	  }
	| { kind: "result"; product: GuideProduct; warning?: "overwrite" | "kyc" }
	| {
			kind: "stop";
			reason:
				| "upgrade_pending"
				| "free_points"
				| "claude_active"
				| "rule_pending"
				| "payment_issue";
	  };
const question = (
	id: string,
	options: string[],
	help?: "plan" | "billing" | "eligibility" | "claude",
): GuideStep => ({ kind: "question", id, options, help });
const result = (
	product: GuideProduct,
	warning?: "overwrite" | "kyc",
): GuideStep => ({ kind: "result", product, warning });

/** Small fixed decision tree. No state is inferred from an expiry date. */
export function guideStep(a: readonly string[]): GuideStep {
	const [family, current, target, billing, issue] = a;
	if (!family)
		return question("family", ["gpt", "claude", "points", "sms", "x", "grok"]);
	if (family === "gpt") {
		if (!current)
			return question("current", ["free", "go", "plus", "pro"], "plan");
		if (!target) return question("target", ["go", "plus", "five", "twenty"]);
		if (target === "go")
			return current === "free" || current === "go"
				? result("go", current === "go" ? "overwrite" : undefined)
				: { kind: "stop", reason: "rule_pending" };
		if (target === "plus")
			return current === "free"
				? result("plusph")
				: current === "pro"
					? { kind: "stop", reason: "rule_pending" }
					: result("plusios", "overwrite");
		if (target === "five") {
			if (current === "free") return result("fiveph");
			if (current === "plus") {
				if (!billing)
					return question("plus_php", ["yes_php", "no_php"], "billing");
				return billing === "yes_php"
					? { kind: "stop", reason: "upgrade_pending" }
					: result("fiveios", "overwrite");
			}
			return current === "go"
				? result("fiveios", "overwrite")
				: { kind: "stop", reason: "rule_pending" };
		}
		if (target === "twenty") {
			if (current === "free") {
				if (!billing)
					return question("new20", ["eligible", "ineligible"], "eligibility");
				return result(billing === "eligible" ? "twentynew" : "gpt20ios");
			}
			if (current === "pro") {
				if (!billing)
					return question("pro_php", ["yes_8919", "no_8919"], "billing");
				if (billing === "yes_8919") {
					if (!issue)
						return question("payment", ["payment_clear", "payment_problem"]);
					return issue === "payment_clear"
						? result("twentyrenew")
						: { kind: "stop", reason: "payment_issue" };
				}
			}
			return result("gpt20ios", "overwrite");
		}
	}
	if (family === "claude") {
		if (!current)
			return question(
				"claude_current",
				["claude_free", "claude_paid"],
				"claude",
			);
		if (current === "claude_paid")
			return { kind: "stop", reason: "claude_active" };
		if (!target)
			return question("claude_target", [
				"claudepro",
				"claudefive",
				"claudetwenty",
			]);
		if (
			target === "claudepro" ||
			target === "claudefive" ||
			target === "claudetwenty"
		)
			return result(target, target === "claudepro" ? undefined : "kyc");
	}
	if (family === "points") {
		if (!current)
			return question("current", ["free", "go", "plus", "pro"], "plan");
		if (current === "free") return { kind: "stop", reason: "free_points" };
		if (!target)
			return question("points_target", [
				"points250",
				"points500",
				"points1000",
				"points2500",
			]);
		if (
			target === "points250" ||
			target === "points500" ||
			target === "points1000" ||
			target === "points2500"
		)
			return result(target);
	}
	if (family === "sms") {
		if (!current) return question("sms_target", ["smsone", "smslong"]);
		if (current === "smsone" || current === "smslong") return result(current);
	}
	if (family === "x") {
		if (!current)
			return question("x_target", ["xpremium", "xplusmonth", "xplusyear"]);
		if (current === "xpremium" || current === "xplusmonth")
			return result(current, "overwrite");
		if (current === "xplusyear") return result(current);
	}
	if (family === "grok") return result("grok", "overwrite");
	return { kind: "stop", reason: "rule_pending" };
}

export function guideProductUrl(product: GuideProduct) {
	const ref = guideProducts[product];
	return `/products/${ref.productId}?item=${ref.itemId}#purchase-options`;
}
