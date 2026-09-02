import type { SupportedLocale } from "#/lib/locales";

type Policy = {
	delivery: string;
	deliveryTime: string;
	coverage: string;
	warranty: string;
	restrictions: string;
};

type ProductLocalization = {
	name: string;
	description: string;
};

type SellableItemLocalization = {
	name: string;
	policy: Policy;
};

const automatic = "Automatically delivered after payment confirmation";
const standardDeliveryTime =
	"Usually completed within 1–30 minutes. During peak periods, delivery may take longer but will not exceed 3 hours. Track delivery status and contents on the order page.";
const immediate = standardDeliveryTime;
const manual = "Processed online after payment confirmation";

const productEnglish: Record<string, ProductLocalization> = {
	"2a794b89-3bb9-49d4-8691-0d13a1606869": {
		name: "ChatGPT Membership Recharge",
		description:
			"ChatGPT Go, Plus, and Pro subscription recharge. Select a plan to review delivery, renewal, and warranty terms.",
	},
	"afb8af99-86af-463e-a76f-fcea2edd22dd": {
		name: "Official Codex Credits",
		description:
			"Official Codex credit CDKs. Not API relay balance, phone verification, or a pre-made account. Select a credit amount to review delivery and restrictions.",
	},
	"ba540b83-388d-45d1-9dcb-25c3da3f9956": {
		name: "Claude Membership Recharge",
		description:
			"Claude Pro and Claude Max membership recharge. Select a plan to review eligibility, warranty, and restrictions.",
	},
	"13ca1b04-19d6-4bbd-98b4-b7884e159ab1": {
		name: "X Membership",
		description:
			"X membership recharge with Premium and Premium+ plans. Select a plan to review benefits, renewal, and after-sales terms.",
	},
	"a48aeca2-90bf-4adf-8cfa-f18204373435": {
		name: "Grok Membership",
		description:
			"SuperGrok membership recharge, currently available as a three-month plan. Review delivery timing, renewal, and after-sales terms before purchase.",
	},
	"02e4bae2-1d3f-411f-a360-b7e2e6fc9069": {
		name: "Gemini and Google Accounts",
		description:
			"Annual Gemini Pro accounts, activation on your own account, and aged Google mailboxes. Select a plan to review delivery and after-sales coverage.",
	},
	"d0000000-0000-4000-8000-000000000001": {
		name: "Payment and Delivery Test Product",
		description:
			"For testing USDT, Alipay, automatic delivery, and fast online delivery only. Not a regular product.",
	},
};

function policy(
	delivery: string,
	deliveryTime: string,
	coverage: string,
	warranty: string,
	restrictions: string,
): Policy {
	return { delivery, deliveryTime, coverage, warranty, restrictions };
}

const chatGptIosPolicy = policy(
	automatic,
	immediate,
	"Renewal is supported. Redemption resets the subscription to 30 days; remaining time does not stack.",
	"30-day subscription warranty; early cancellation is refunded pro rata by day.",
	"Account bans, sharing, frequent IP changes, and account-level risk controls are excluded.",
);
const chatGptPhilippinesPolicy = policy(
	automatic,
	immediate,
	"Renewal is not supported. Confirm that the current subscription has expired before purchase.",
	"30-day subscription warranty; early cancellation is refunded pro rata by day.",
	"Account bans, incorrect information, regional issues, and abnormal account status are excluded.",
);
const codexAutomaticPolicy = policy(
	automatic,
	immediate,
	"Credit product, not a subscription renewal. Confirm that the account supports adding Codex Credits before purchase.",
	"Credits cannot be returned or exchanged after they arrive.",
	"GPT Free accounts are not eligible. Account bans, regional issues, disclosure, and user error are excluded.",
);
const claudePolicy = policy(
	automatic,
	immediate,
	"The current Claude subscription must expire before recharge.",
	"Subscription warranty; early cancellation is handled according to actual days used.",
	"Account bans are excluded. No refund for Billing arrears or refunds, hidden organization restrictions, or an account unable to send messages. Do not purchase unless you understand account risk controls.",
);

const sellableItemEnglish: Record<string, SellableItemLocalization> = {
	"983f6e73-061e-419d-a7d5-8ac5ec5648ab": {
		name: "ChatGPT Go — 1 month",
		policy: chatGptIosPolicy,
	},
	"362d3add-4901-4b4c-b6a9-27aea63473e4": {
		name: "ChatGPT Plus Philippines — 1 month",
		policy: chatGptPhilippinesPolicy,
	},
	"efc0cc87-b7ed-4bd5-b792-e9f455fda8eb": {
		name: "ChatGPT Plus iOS — 1 month",
		policy: chatGptIosPolicy,
	},
	"f8c7ee24-239c-43a1-abe7-9dd40c53de21": {
		name: "ChatGPT Pro 5X iOS — 1 month",
		policy: chatGptIosPolicy,
	},
	"0829de43-da22-420c-9866-38c83dd420f0": {
		name: "ChatGPT Pro 20X Philippines — 1 month",
		policy: chatGptPhilippinesPolicy,
	},
	"208c2e9c-3594-4be9-9c71-22ac8b09aad4": {
		name: "ChatGPT Pro 20X iOS — 1 month",
		policy: chatGptIosPolicy,
	},
	"7f76a172-d963-43a4-8297-d4d7550f4670": {
		name: "Codex 250 credits",
		policy: codexAutomaticPolicy,
	},
	"1572316f-0649-43d5-b86f-2c551f10833e": {
		name: "Codex 500 credits",
		policy: codexAutomaticPolicy,
	},
	"902c0f18-1c50-4b75-9cc2-62e432716e0c": {
		name: "Codex 1,000 credits",
		policy: codexAutomaticPolicy,
	},
	"ea366d71-6d3b-4e0d-8551-242a3a1ca483": {
		name: "Codex 2,000 credits",
		policy: {
			...codexAutomaticPolicy,
			delivery: manual,
			deliveryTime: standardDeliveryTime,
		},
	},
	"efa6e9ae-f8a6-4cf7-b99c-72e51e68dace": {
		name: "Claude Pro — 1 month",
		policy: claudePolicy,
	},
	"d3a2050e-1c65-4c7e-9ad7-3c8892ef412e": {
		name: "Claude Max 5X — 1 month",
		policy: claudePolicy,
	},
	"34c18e6b-c4d5-4289-9c6b-ab47fa027182": {
		name: "Claude Max 20X — 1 month",
		policy: claudePolicy,
	},
	"dfb87d8d-3d4c-4e7f-be87-ae4b4985a6f8": {
		name: "X Premium — 1 month",
		policy: policy(
			automatic,
			immediate,
			"New and existing accounts are eligible. Early renewal replaces the current term and does not stack.",
			"Warranty covers only an unusable CDK.",
			"Account issues after successful redemption, bans, policy violations, and platform risk controls are excluded.",
		),
	},
	"ef966363-c7a4-4df3-95a1-58de9f95a66a": {
		name: "X Premium+ — 1 month (includes SuperGrok)",
		policy: policy(
			automatic,
			immediate,
			"New and existing accounts are eligible. Early renewal replaces the current term and does not stack.",
			"Warranty covers only an unusable CDK.",
			"Includes the corresponding SuperGrok benefit. Account issues after redemption, bans, policy violations, and platform risk controls are excluded.",
		),
	},
	"84208f7a-674c-4f4c-aeaf-c815d110905a": {
		name: "SuperGrok — 1 month",
		policy: policy(
			manual,
			standardDeliveryTime,
			"Early renewal is supported but replaces the current term and does not stack.",
			"30-day subscription warranty; early cancellation is handled according to days used.",
			"Account bans and account-level risk controls are excluded.",
		),
	},
	"b3120be0-f106-4bbe-b972-ba4b3870493c": {
		name: "SuperGrok — 3 months",
		policy: policy(
			automatic,
			immediate,
			"New and existing accounts are eligible. Early renewal replaces the current term and does not stack.",
			"Warranty covers only an unusable CDK.",
			"Other account issues after redemption are excluded; account bans are not covered.",
		),
	},
	"4ab75f71-9319-46bd-8c6e-aa31956b68e1": {
		name: "SuperGrok Heavy — 1 month",
		policy: policy(
			manual,
			standardDeliveryTime,
			"Subject to the current partner-channel rules; benefits are not guaranteed to match standard SuperGrok.",
			"24-hour subscription warranty after delivery.",
			"The 24-hour warranty is not the delivery time. Account bans are excluded; this short-warranty product is not the same as an official direct recharge.",
		),
	},
	"53ff2b3e-b709-4c63-90bd-082a92edae9b": {
		name: "Gemini Pro — 12 months, random region, 2022–2024 aged account",
		policy: policy(
			automatic,
			immediate,
			"Pre-made account; not a subscription renewal.",
			"Gemini service is guaranteed for 12 months, with a possible 1–7 day variance; first login and a 24-hour warranty are included.",
			"Gmail, GCP, and Antigravity are not guaranteed. Do not change the password immediately; use a stable, clean, dedicated IP.",
		),
	},
	"c86c4edb-c36e-452f-b490-5ca230bf182d": {
		name: "Gemini Pro — 12 months, US, 2022–2024 aged account",
		policy: policy(
			automatic,
			immediate,
			"Pre-made account; not a subscription renewal.",
			"Gemini service is guaranteed for 12 months, with a possible 1–7 day variance; first login and a 24-hour warranty are included.",
			"Gmail, GCP, and Antigravity are not guaranteed. Do not change the password immediately; use a stable, clean, dedicated IP.",
		),
	},
	"37297645-2be9-403e-9d0f-155a72d3ab45": {
		name: "Gemini Pro — 12 months, activation on your account",
		policy: policy(
			automatic,
			immediate,
			"Activated on your own account; not a pre-made account.",
			"Correct activation is guaranteed when accurate information is supplied; account-ban coverage is not included.",
			"Accurate account credentials, password, and 2FA are required. Incorrect information or abnormal account status may prevent activation.",
		),
	},
	"7e4a86d3-8ed4-4e52-94e3-0887652d0ee2": {
		name: "Google/Gmail US aged mailbox — 2022–2025",
		policy: policy(
			automatic,
			immediate,
			"Account product; not a membership renewal.",
			"Delivered credentials are guaranteed to pass the initial verification only; long-term stability is not guaranteed.",
			"Other Google services are not guaranteed. Do not use for bulk mail, fraud, or policy violations. Maintain the password and 2FA after receipt.",
		),
	},
	"d0000000-0000-4000-8000-000000000002": {
		name: "Test 1 — automatic delivery",
		policy: policy(
			automatic,
			"Delivered immediately after payment confirmation; view the test content on the order page.",
			"For payment and delivery workflow testing only.",
			"Test products do not include after-sales benefits.",
			"For testing only; purchase one item per order.",
		),
	},
	"d0000000-0000-4000-8000-000000000003": {
		name: "Test 2 — fast online delivery",
		policy: policy(
			manual,
			standardDeliveryTime,
			"For payment and delivery workflow testing only.",
			"Test products do not include after-sales benefits.",
			"For testing only; purchase one item per order.",
		),
	},
};

export function localizeProduct(
	id: string,
	locale: SupportedLocale,
	fallback: ProductLocalization,
) {
	return locale === "en-US" ? (productEnglish[id] ?? fallback) : fallback;
}

export function localizeSellableItem(
	id: string,
	locale: SupportedLocale,
	fallback: SellableItemLocalization,
	fulfillmentSource?: "local" | "manual" | "supplier",
) {
	if (locale !== "en-US") return fallback;
	const localized = sellableItemEnglish[id] ?? fallback;
	if (fulfillmentSource !== "manual") return localized;
	return {
		...localized,
		policy: {
			...localized.policy,
			delivery: manual,
			deliveryTime: standardDeliveryTime,
		},
	};
}
