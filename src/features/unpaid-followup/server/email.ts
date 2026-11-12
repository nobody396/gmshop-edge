import { ownLinkTags, withUtm } from "#/features/attribution/utm";
import type { SupportedLocale } from "#/lib/locales";
import { m } from "#/paraglide/messages";

/** utm_campaign of every link in the email (source order_email, medium email). */
export const unpaidFollowupCampaign = "unpaid_followup";
export const unpaidFollowupTag = ownLinkTags.orderEmail(unpaidFollowupCampaign);

/** The product page with the exact sellable item preselected. */
export function unpaidFollowupReorderUrl(
	origin: string,
	productId: string,
	sellableItemId: string,
) {
	const search = new URLSearchParams({ item: sellableItemId });
	return withUtm(
		`${origin}/products/${encodeURIComponent(productId)}?${search}#purchase-options`,
		unpaidFollowupTag,
	);
}

/** The storefront's support entry (opens the web support widget). */
export function unpaidFollowupSupportUrl(origin: string) {
	return withUtm(`${origin}/#support`, unpaidFollowupTag);
}

export type UnpaidFollowupEmailInput = {
	locale: SupportedLocale;
	itemName: string;
	/** Payment was attempted with USDT and Alipay can take this order now. */
	usdtHint: boolean;
	reorderUrl: string;
	supportUrl: string;
	/** Signed one-click unsubscribe page; never tagged or rewritten. */
	unsubscribeUrl: string;
	brand: string;
};

/**
 * Plain-text "helpful" follow-up: no discount, no coupon, no urgency. The
 * USDT → Alipay line appears only when the caller established both facts.
 */
export function renderUnpaidFollowupEmail(input: UnpaidFollowupEmailInput) {
	const options = { locale: input.locale };
	const text = [
		m.unpaid_followup_email_intro({ item: input.itemName }, options),
		"",
		m.unpaid_followup_email_help_title({}, options),
		...(input.usdtHint ? [m.unpaid_followup_email_usdt_tip({}, options)] : []),
		m.unpaid_followup_email_plan_tip({}, options),
		"",
		m.unpaid_followup_email_reorder({ url: input.reorderUrl }, options),
		m.unpaid_followup_email_support({ url: input.supportUrl }, options),
		"",
		m.unpaid_followup_email_signature({ brand: input.brand }, options),
		"",
		m.unpaid_followup_email_unsubscribe({ url: input.unsubscribeUrl }, options),
	].join("\n");
	return { subject: m.unpaid_followup_email_subject({}, options), text };
}
