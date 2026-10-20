import { m } from "#/paraglide/messages";
import { BuyingGuide } from "./buying-guide";

/** One-line "read before ordering" strip with the buying guide as its action. */
export function SelfServiceRecharge() {
	return (
		<section
			aria-labelledby="self-service-recharge-title"
			className="mt-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:gap-4 sm:rounded-xl sm:border sm:border-primary/25 sm:bg-primary/5 sm:py-2.5 sm:ps-4 sm:pe-2.5"
			data-self-service-recharge
			id="self-service-recharge"
		>
			<p className="flex min-w-0 flex-1 flex-col gap-1 rounded-xl border border-primary/25 bg-primary/5 px-3.5 py-3 text-sm leading-6 sm:flex-row sm:flex-wrap sm:items-baseline sm:gap-x-4 sm:border-0 sm:bg-transparent sm:p-0">
				<strong
					className="shrink-0 text-primary"
					id="self-service-recharge-title"
				>
					{m.store_home_notice_label()}
				</strong>
				<span className="text-foreground/80">{m.store_home_notice_body()}</span>
			</p>
			<div className="shrink-0">
				<BuyingGuide />
			</div>
		</section>
	);
}
