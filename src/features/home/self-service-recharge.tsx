import { ArrowRight, KeyRound, Link2, Timer } from "lucide-react";
import { chatGptRechargeProductId } from "#/features/storefront/components/chatgpt-region-guide";
import { m } from "#/paraglide/messages";

const steps = [
	{
		icon: KeyRound,
		title: () => m.store_self_service_step_order_title(),
		body: () => m.store_self_service_step_order_body(),
	},
	{
		icon: Link2,
		title: () => m.store_self_service_step_receive_title(),
		body: () => m.store_self_service_step_receive_body(),
	},
	{
		icon: Timer,
		title: () => m.store_self_service_step_finish_title(),
		body: () => m.store_self_service_step_finish_body(),
	},
];

export function SelfServiceRecharge() {
	return (
		<section
			aria-labelledby="self-service-recharge-title"
			className="container px-4 pb-10"
			data-self-service-recharge
			id="self-service-recharge"
		>
			<div className="overflow-hidden rounded-3xl border border-primary/25 bg-primary/5 p-5 shadow-sm sm:p-8">
				<div className="grid items-center gap-8 lg:grid-cols-[minmax(0,.8fr)_minmax(0,1.2fr)]">
					<div>
						<p className="font-semibold text-primary text-xs uppercase tracking-[0.16em]">
							{m.store_self_service_eyebrow()}
						</p>
						<h2
							className="mt-2 text-balance font-semibold text-2xl tracking-tight sm:text-3xl"
							id="self-service-recharge-title"
						>
							{m.store_self_service_title()}
						</h2>
						<p className="mt-3 max-w-xl text-muted-foreground text-sm leading-6">
							{m.store_self_service_description()}
						</p>
						<a
							className="mt-5 inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2.5 font-semibold text-primary-foreground text-sm transition-opacity hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
							href={`/products/${chatGptRechargeProductId}`}
						>
							{m.store_self_service_action()}
							<ArrowRight aria-hidden="true" className="size-4" />
						</a>
					</div>
					<ol className="grid gap-3 sm:grid-cols-3">
						{steps.map(({ body, icon: Icon, title }, index) => (
							<li
								className="rounded-2xl border bg-background/90 p-4"
								key={title()}
							>
								<div className="flex items-center justify-between gap-3">
									<span className="grid size-9 place-items-center rounded-xl bg-primary/10 text-primary">
										<Icon aria-hidden="true" className="size-4" />
									</span>
									<span className="font-mono text-muted-foreground text-xs">
										0{index + 1}
									</span>
								</div>
								<h3 className="mt-4 font-semibold text-sm">{title()}</h3>
								<p className="mt-1.5 text-muted-foreground text-xs leading-5">
									{body()}
								</p>
							</li>
						))}
					</ol>
				</div>
				<p className="mt-5 border-border/70 border-t pt-4 text-muted-foreground text-xs leading-5">
					{m.store_self_service_timing_note()}
				</p>
			</div>
		</section>
	);
}
