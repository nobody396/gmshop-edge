import { gptUpgradeProduct } from "#/features/gpt-upgrade/products";

/** Retired product page that now redirects to the twenty-renew plan. */
export const retiredTwentyRenewProductId =
	"aa277f98-79b4-58cb-8b7b-1424fe930ab9";

// Explicit VIP product mapping. Never infer eligibility from names or prices.
export const guideProducts = {
	gpt500: {
		productId: "2a794b89-3bb9-49d4-8691-0d13a1606869",
		itemId: "030582df-98c1-5b87-914d-28ddc606e163",
	},
	gpt20ios: {
		productId: "2a794b89-3bb9-49d4-8691-0d13a1606869",
		itemId: "208c2e9c-3594-4be9-9c71-22ac8b09aad4",
	},
	go: {
		productId: "2a794b89-3bb9-49d4-8691-0d13a1606869",
		itemId: "983f6e73-061e-419d-a7d5-8ac5ec5648ab",
	},
	goin: {
		productId: "2a794b89-3bb9-49d4-8691-0d13a1606869",
		itemId: "29ebf990-efd6-4a1e-a71b-22f1920239a7",
	},
	gptupgrade: {
		productId: gptUpgradeProduct.productId,
		itemId: gptUpgradeProduct.itemId,
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
		productId: "2a794b89-3bb9-49d4-8691-0d13a1606869",
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
	envmonth: {
		productId: "f2b92a96-290c-4ffa-aaf5-a26e7a35815d",
		itemId: "c3bab030-0c3c-4451-9c41-3cc32538e778",
	},
	envquarter: {
		productId: "f2b92a96-290c-4ffa-aaf5-a26e7a35815d",
		itemId: "1e599d3a-3aa2-498e-a955-f4b04a4abdc4",
	},
	xplus: {
		productId: "3e60e88d-a0bd-4723-bc9e-ff45f6dafa16",
		itemId: "b17f05d4-f109-46f2-888a-6f633519d9e7",
	},
	xpremium: {
		productId: "3e60e88d-a0bd-4723-bc9e-ff45f6dafa16",
		itemId: "091ab8e6-6c3f-48e5-be52-268bea8e87e9",
	},
	xsuper: {
		productId: "3e60e88d-a0bd-4723-bc9e-ff45f6dafa16",
		itemId: "0c4fb0ae-f770-4957-87c7-95b5c53d42e8",
	},
	xultra: {
		productId: "3e60e88d-a0bd-4723-bc9e-ff45f6dafa16",
		itemId: "f3abb17f-5c93-40c6-a8e2-ef80cdfca7d2",
	},
	xpremiumh50: {
		productId: "3e60e88d-a0bd-4723-bc9e-ff45f6dafa16",
		itemId: "048f69c9-90e3-4b51-809f-73a465dbd25c",
	},
	xsuperh50: {
		productId: "3e60e88d-a0bd-4723-bc9e-ff45f6dafa16",
		itemId: "5aeeff6b-3a27-44a3-b04c-fab8257d556b",
	},
	xultrah50: {
		productId: "3e60e88d-a0bd-4723-bc9e-ff45f6dafa16",
		itemId: "8c7e3f68-d814-425e-9a18-0fcd17ad3999",
	},
	xplus1y: {
		productId: "3e60e88d-a0bd-4723-bc9e-ff45f6dafa16",
		itemId: "7a1c2f30-6b1e-4d4a-9e51-0c3a1f2b1001",
	},
	xpremium1y: {
		productId: "3e60e88d-a0bd-4723-bc9e-ff45f6dafa16",
		itemId: "7a1c2f30-6b1e-4d4a-9e51-0c3a1f2b1002",
	},
	smslong: {
		productId: "a9f6b8c4-e302-5c1a-8947-780785672b32",
		itemId: "a39b3590-0952-5886-9076-a9cd879c1975",
	},
	smsclaude: {
		productId: "ff4ff1f6-cad4-4821-a195-39befdcc32d6",
		itemId: "e23b7fb9-1e1c-4b47-a110-d9f84a02a52c",
	},
	smsgoogle: {
		productId: "8f78192a-3097-4ec2-a771-5aa76d1bccab",
		itemId: "d353aa0e-fd21-4ecc-9a0b-9ad9a5e64da4",
	},
	smstiktok: {
		productId: "0375b7ba-9b49-4ff4-9652-40fedf7fbf0d",
		itemId: "174e12ab-0383-4f84-a14b-c88151a0be3c",
	},
	smstelegram: {
		productId: "4d5aba11-5102-4d06-a11d-7d33279c8fa8",
		itemId: "88aff5d3-a5ca-4ce3-9839-4149fe1d37ef",
	},
	fivecl: {
		productId: "2a794b89-3bb9-49d4-8691-0d13a1606869",
		itemId: "21859feb-e4d5-469f-9ca8-11fa4b9e5d18",
	},
	gpt500cl: {
		productId: "2a794b89-3bb9-49d4-8691-0d13a1606869",
		itemId: "521968d1-5c64-45bf-a4bc-7df906dcc1cb",
	},
	teamstd: {
		productId: "2a794b89-3bb9-49d4-8691-0d13a1606869",
		itemId: "ceab0998-9dc1-4f3e-94e4-a8332a311eaf",
	},
	team5x: {
		productId: "2a794b89-3bb9-49d4-8691-0d13a1606869",
		itemId: "30754dc5-5ba6-4923-9527-62dd91b8e19e",
	},
	compute50: {
		productId: "e5c81556-03be-43fd-bf3f-e248c16cc34d",
		itemId: "e8ff14e3-76a5-46e0-b6d3-1c217130bd99",
	},
	compute100: {
		productId: "e5c81556-03be-43fd-bf3f-e248c16cc34d",
		itemId: "1f30100a-84bb-4b93-a192-dc0d94aa0b9d",
	},
	compute200: {
		productId: "e5c81556-03be-43fd-bf3f-e248c16cc34d",
		itemId: "2244cfa4-fc8d-4cb3-b63c-e7cf3841c51a",
	},
	compute500: {
		productId: "e5c81556-03be-43fd-bf3f-e248c16cc34d",
		itemId: "bb584d1c-4444-4581-a2e1-5ddeab2f0f87",
	},
	gemini: {
		productId: "b99dfd6a-2206-4dc9-aea9-85e86c3f8d66",
		itemId: "a3fc7472-b5f5-45b2-93e4-0123a8d2c9e4",
	},
	tg3: {
		productId: "9e8b2987-1564-417e-8441-5936c5d592fa",
		itemId: "bb484132-9c65-4ba4-908b-9043afdf7f77",
	},
	tg6: {
		productId: "9e8b2987-1564-417e-8441-5936c5d592fa",
		itemId: "58c5634b-89b4-4e61-a6ae-d3c9c7da87f3",
	},
	tg12: {
		productId: "9e8b2987-1564-417e-8441-5936c5d592fa",
		itemId: "d7ed6530-1f43-452f-b424-6aaf8800643c",
	},
	gmailus: {
		productId: "e4acdd84-af47-45fd-99c6-29cb7a2d38b1",
		itemId: "20a6011a-779d-43fa-a843-47fa76e31abf",
	},
	gmailrandom: {
		productId: "e4acdd84-af47-45fd-99c6-29cb7a2d38b1",
		itemId: "f7dd6de9-9bdb-552a-9f38-e5b918a343b5",
	},
	appleus: {
		productId: "c70d10e8-b781-4782-bc98-1f034bcd069a",
		itemId: "d387ff70-1566-444a-9c75-fe4934df7d47",
	},
	applejp: {
		productId: "c70d10e8-b781-4782-bc98-1f034bcd069a",
		itemId: "f77910c4-435b-482f-b656-87693852527b",
	},
	appletr: {
		productId: "c70d10e8-b781-4782-bc98-1f034bcd069a",
		itemId: "3d992ebc-cae7-4eaa-bb1c-c9a886c73d6b",
	},
	agentsite: {
		productId: "19900000-0000-4000-8000-000000000001",
		itemId: "19900000-0000-4000-8000-000000000002",
	},
	agentapi: {
		productId: "09900000-0000-4000-8000-000000000001",
		itemId: "09900000-0000-4000-8000-000000000002",
	},
} as const;
export type GuideProduct = keyof typeof guideProducts;
export type GuideStep =
	| {
			kind: "question";
			id: string;
			options: string[];
			help?: "plan" | "billing" | "claude";
	  }
	| {
			kind: "result";
			product: GuideProduct;
			warning?: "overwrite" | "overwrite30" | "kyc";
	  }
	| {
			kind: "stop";
			reason:
				| "free_points"
				| "claude_active"
				| "rule_pending"
				| "fivehundred_active"
				| "wait_for_expiry"
				| "renew_bill_mismatch"
				| "x_active";
	  };
const question = (
	id: string,
	options: string[],
	help?: "plan" | "billing" | "claude",
): GuideStep => ({ kind: "question", id, options, help });
const result = (
	product: GuideProduct,
	warning?: "overwrite" | "overwrite30" | "kyc",
): GuideStep => ({ kind: "result", product, warning });

/** Small fixed decision tree. No state is inferred from an expiry date. */
export function guideStep(a: readonly string[]): GuideStep {
	const [family, current, target] = a;
	if (!family)
		return question("family", [
			"gpt",
			"team",
			"points",
			"claude",
			"claudeenv",
			"compute",
			"x",
			"gemini",
			"telegram",
			"apple",
			"gmail",
			"sms",
			"reseller",
		]);
	if (family === "gpt") {
		if (!current)
			return question(
				"gpt_current",
				["free", "go", "plus", "pro100", "pro200", "pro500"],
				"plan",
			);
		if (!["free", "go", "plus", "pro100", "pro200", "pro500"].includes(current))
			return { kind: "stop", reason: "rule_pending" };
		const hasPairedChannel = ["plus", "pro100", "pro200"].includes(current);
		const currentChannel = hasPairedChannel ? a[2] : undefined;
		if (hasPairedChannel && !currentChannel)
			return question(
				"current_channel",
				["current_ph", "current_ios", "current_other"],
				"billing",
			);
		if (
			hasPairedChannel &&
			currentChannel !== "current_ph" &&
			currentChannel !== "current_ios"
		)
			return { kind: "stop", reason: "rule_pending" };
		const [target, choice, detail, renewalChannel] = a.slice(
			hasPairedChannel ? 3 : 2,
		);
		if (!target)
			return question("target", [
				"go",
				"plus",
				"five",
				"twenty",
				"fivehundred",
			]);
		if (!["go", "plus", "five", "twenty", "fivehundred"].includes(target))
			return { kind: "stop", reason: "rule_pending" };
		if (current === "free") {
			// Free accounts get the India card-paid Go (needs a Free account).
			if (target === "go") return result("goin");
			// Card-paid regions (PH, Chile) need a Free account; iOS can overwrite a plan.
			if (target === "fivehundred") {
				if (!choice) return question("channel500", ["ph", "cl"]);
				if (choice === "ph") return result("gpt500");
				if (choice === "cl") return result("gpt500cl");
				return { kind: "stop", reason: "rule_pending" };
			}
			if (!choice)
				return question(
					"channel",
					target === "five" ? ["ph", "cl", "ios"] : ["ph", "ios"],
				);
			if (target === "five" && choice === "cl") return result("fivecl");
			if (choice !== "ph" && choice !== "ios")
				return { kind: "stop", reason: "rule_pending" };
			return result(
				target === "plus"
					? choice === "ph"
						? "plusph"
						: "plusios"
					: target === "five"
						? choice === "ph"
							? "fiveph"
							: "fiveios"
						: choice === "ph"
							? "twentynew"
							: "gpt20ios",
			);
		}
		if (!choice) return question("timing", ["recharge_now", "after_expiry"]);
		if (choice === "after_expiry")
			return {
				kind: "stop",
				reason:
					target === "fivehundred" ? "fivehundred_active" : "wait_for_expiry",
			};
		if (choice !== "recharge_now")
			return { kind: "stop", reason: "rule_pending" };
		// A PH (web card) subscription can be upgraded in place by paying the
		// difference (2026-11-07 product); iOS stays an overwrite alternative.
		const rank: Record<string, number> = {
			plus: 1,
			pro100: 2,
			pro200: 3,
			five: 2,
			twenty: 3,
			fivehundred: 4,
		};
		if (
			currentChannel === "current_ph" &&
			(rank[target] ?? 0) > (rank[current] ?? 9)
		) {
			if (target === "fivehundred") return result("gptupgrade");
			if (!detail) return question("upgrade_channel", ["ph_upgrade", "ios"]);
			if (detail === "ph_upgrade") return result("gptupgrade");
			if (detail !== "ios") return { kind: "stop", reason: "rule_pending" };
		}
		if (target === "fivehundred")
			return { kind: "stop", reason: "fivehundred_active" };
		if (
			(target === "go" && current !== "go") ||
			(target === "plus" && current !== "go" && current !== "plus") ||
			(target === "five" && (current === "pro200" || current === "pro500")) ||
			(target === "twenty" && current === "pro500")
		)
			return { kind: "stop", reason: "rule_pending" };
		if (target === "go") return result("go", "overwrite30");
		if (
			current === "pro200" &&
			currentChannel === "current_ph" &&
			target === "twenty"
		) {
			if (!detail)
				return question("pro_php", ["yes_8919", "no_8919"], "billing");
			if (detail !== "yes_8919")
				return { kind: "stop", reason: "renew_bill_mismatch" };
			if (!renewalChannel)
				return question("renew_channel", ["ph_renew", "ios"]);
			return renewalChannel === "ph_renew"
				? result("twentyrenew")
				: renewalChannel === "ios"
					? result("gpt20ios", "overwrite30")
					: { kind: "stop", reason: "rule_pending" };
		}
		return result(
			target === "plus"
				? "plusios"
				: target === "five"
					? "fiveios"
					: "gpt20ios",
			"overwrite30",
		);
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
		if (!target) return question("claude_target", ["claudepro", "claudefive"]);
		if (target === "claudepro" || target === "claudefive")
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
		if (!current)
			return question("sms_target", [
				"smslong",
				"smsclaude",
				"smsgoogle",
				"smstiktok",
				"smstelegram",
			]);
		if (
			current === "smslong" ||
			current === "smsclaude" ||
			current === "smsgoogle" ||
			current === "smstiktok" ||
			current === "smstelegram"
		)
			return result(current);
	}
	if (family === "team") {
		if (!current) return question("team_target", ["teamstd", "team5x"]);
		if (current === "teamstd" || current === "team5x") return result(current);
	}
	if (family === "compute") {
		if (!current)
			return question("compute_target", [
				"compute50",
				"compute100",
				"compute200",
				"compute500",
			]);
		if (
			current === "compute50" ||
			current === "compute100" ||
			current === "compute200" ||
			current === "compute500"
		)
			return result(current);
	}
	if (family === "x") {
		if (!current) return question("x_current", ["x_none", "x_member"]);
		if (current === "x_member") return { kind: "stop", reason: "x_active" };
		if (current !== "x_none") return { kind: "stop", reason: "rule_pending" };
		if (!target)
			return question("x_target", [
				"xplus",
				"xpremium",
				"xsuper",
				"xultra",
				"xplus1y",
				"xpremium1y",
			]);
		// Monthly Plus and both yearly plans need no first-month offer.
		if (target === "xplus" || target === "xplus1y" || target === "xpremium1y")
			return result(target);
		if (target !== "xpremium" && target !== "xsuper" && target !== "xultra")
			return { kind: "stop", reason: "rule_pending" };
		// Premium and up are paid with the official first-month 50% offer.
		const offer = a[3];
		if (!offer) return question("x_offer", ["offer_yes", "offer_no"]);
		// The half-price card needs the offer; the standard card is for accounts without it.
		if (offer === "offer_yes") return result(`${target}h50`);
		if (offer === "offer_no") return result(target);
	}
	if (family === "gemini") return result("gemini");
	if (family === "telegram") {
		if (!current) return question("tg_target", ["tg3", "tg6", "tg12"]);
		if (current === "tg3" || current === "tg6" || current === "tg12")
			return result(current);
	}
	if (family === "gmail") {
		if (!current) return question("gmail_target", ["gmailus", "gmailrandom"]);
		if (current === "gmailus" || current === "gmailrandom")
			return result(current);
	}
	if (family === "claudeenv") {
		if (!current) return question("env_target", ["envmonth", "envquarter"]);
		if (current === "envmonth" || current === "envquarter")
			return result(current);
	}
	if (family === "apple") {
		if (!current)
			return question("apple_target", ["appleus", "applejp", "appletr"]);
		if (current === "appleus" || current === "applejp" || current === "appletr")
			return result(current);
	}
	if (family === "reseller") {
		if (!current)
			return question("reseller_target", ["reseller_shop", "reseller_connect"]);
		if (current === "reseller_shop") return result("agentsite");
		if (current === "reseller_connect") return result("agentapi");
	}
	return { kind: "stop", reason: "rule_pending" };
}

export function guideProductUrl(product: GuideProduct) {
	// The upgrade is priced per account: the customer starts from the quote page.
	if (product === "gptupgrade") return gptUpgradeProduct.quoteUrl;
	const ref = guideProducts[product];
	return `/products/${ref.productId}?item=${ref.itemId}#purchase-options`;
}
