import { m } from "#/paraglide/messages";

export const ph20xNewSkuId = "0829de43-da22-420c-9866-38c83dd420f0";

export function Ph20xEligibilityGuide() {
	return (
		<section
			id="ph20x-eligibility"
			aria-labelledby="ph20x-eligibility-title"
			className="my-10 scroll-mt-24 space-y-4 rounded-2xl border border-amber-500/30 bg-amber-500/5 p-5 sm:p-8"
		>
			<h2
				id="ph20x-eligibility-title"
				className="font-semibold text-xl sm:text-2xl"
			>
				{m.store_ph20x_eligibility_title()}
			</h2>
			<p className="font-semibold leading-7">
				{m.store_ph20x_eligibility_requirement()}
			</p>
			<p className="text-sm leading-7">{m.store_ph20x_eligibility_steps()}</p>
			<p className="text-sm leading-7">{m.store_ph20x_eligibility_stop()}</p>
			<a
				href="/guides/chatgpt/ph20x-eligibility.png"
				target="_blank"
				rel="noopener noreferrer"
				className="mx-auto block max-w-3xl rounded-xl focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
				aria-label={m.store_ph20x_eligibility_enlarge()}
			>
				<img
					src="/guides/chatgpt/ph20x-eligibility.png"
					width={1464}
					height={1844}
					alt={m.store_ph20x_eligibility_image_alt()}
					loading="lazy"
					className="h-auto w-full rounded-xl"
				/>
				<span className="mt-2 block text-center text-sm underline underline-offset-4">
					{m.store_ph20x_eligibility_enlarge()}
				</span>
			</a>
			<p className="text-muted-foreground text-sm leading-6">
				{m.store_ph20x_eligibility_note()}
			</p>
		</section>
	);
}
