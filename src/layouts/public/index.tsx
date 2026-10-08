import { Outlet } from "@tanstack/react-router";
import { useSiteBrand } from "#/context/site-brand-provider";
import { CurrencyProvider } from "#/features/exchange-rates/currency-context";
import { ReferralCapture } from "#/features/promotions/capture";
import { SiteCustomHtml } from "#/features/settings/components/site-custom-html";
import { WebSupportWidget } from "#/features/telegram/components/web-support-widget";
import { SkipToMain } from "#/layouts/components/skip-to-main";
import { PublicFooter } from "#/layouts/public/footer";
import { DeliveryTicker, PublicHeader } from "#/layouts/public/header";
import { MobileBottomNavigation } from "#/layouts/public/mobile-bottom-navigation";

export function PublicLayout() {
	const { customHtml } = useSiteBrand();
	return (
		<CurrencyProvider>
			<ReferralCapture />
			<div className="flex min-h-svh flex-col bg-background text-foreground">
				<SkipToMain />
				<PublicHeader />
				<DeliveryTicker />
				<main className="w-full flex-1 outline-none" id="content" tabIndex={-1}>
					<Outlet />
				</main>
				<PublicFooter />
				<MobileBottomNavigation />
				<WebSupportWidget />
				<SiteCustomHtml html={customHtml} />
			</div>
		</CurrencyProvider>
	);
}
