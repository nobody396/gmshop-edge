import { CircleCheck, Globe2, Smartphone } from "lucide-react";
import { m } from "#/paraglide/messages";

export const chatGptRechargeProductId = "2a794b89-3bb9-49d4-8691-0d13a1606869";

export function ChatGptRegionGuide() {
	return (
		<section
			aria-labelledby="chatgpt-region-guide-title"
			className="my-10 scroll-mt-24 space-y-6 rounded-2xl border border-primary/30 bg-primary/5 p-5 sm:p-8"
			data-chatgpt-region-guide
			id="chatgpt-region-guide"
		>
			<header className="space-y-2">
				<h2
					className="font-semibold text-xl sm:text-2xl"
					id="chatgpt-region-guide-title"
				>
					{m.store_chatgpt_region_title()}
				</h2>
				<p className="text-muted-foreground text-sm leading-6">
					{m.store_chatgpt_region_intro()}
				</p>
			</header>

			<div className="grid gap-4 lg:grid-cols-2">
				<RegionCard
					description={m.store_chatgpt_region_ph_description()}
					icon={Globe2}
					items={[
						m.store_chatgpt_region_ph_plan(),
						m.store_chatgpt_region_ph_coverage(),
						m.store_chatgpt_region_ph_entry(),
					]}
					title={m.store_chatgpt_region_ph_title()}
				/>
				<RegionCard
					description={m.store_chatgpt_region_us_description()}
					icon={Smartphone}
					items={[
						m.store_chatgpt_region_us_plan(),
						m.store_chatgpt_region_us_coverage(),
						m.store_chatgpt_region_us_entry(),
					]}
					title={m.store_chatgpt_region_us_title()}
				/>
			</div>

			<div className="space-y-2 rounded-xl border border-emerald-500/25 bg-emerald-500/5 p-4 text-sm leading-6">
				<p className="font-semibold">{m.store_chatgpt_region_choose_title()}</p>
				<p>{m.store_chatgpt_region_choose_body()}</p>
				<p className="text-muted-foreground">
					{m.store_chatgpt_region_common()}
				</p>
			</div>
		</section>
	);
}

function RegionCard({
	description,
	icon: Icon,
	items,
	title,
}: {
	description: string;
	icon: typeof Globe2;
	items: string[];
	title: string;
}) {
	return (
		<article className="space-y-4 rounded-xl border bg-background p-4 sm:p-5">
			<div className="flex items-start gap-3">
				<span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
					<Icon aria-hidden="true" className="size-5" />
				</span>
				<div>
					<h3 className="font-semibold">{title}</h3>
					<p className="mt-1 text-muted-foreground text-sm leading-6">
						{description}
					</p>
				</div>
			</div>
			<ul className="grid gap-2 text-sm leading-6">
				{items.map((item) => (
					<li className="flex gap-2" key={item}>
						<CircleCheck
							aria-hidden="true"
							className="mt-1 size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
						/>
						<span>{item}</span>
					</li>
				))}
			</ul>
		</article>
	);
}
