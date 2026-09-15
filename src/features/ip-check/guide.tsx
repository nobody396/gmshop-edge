import { m } from "#/paraglide/messages";
import { localChecksCommand, windowsChecksCommand } from "./local-checks";
export function IpCheckGuide() {
	const sections = [
		[m.ip_a1_title, m.ip_a1_body],
		[m.ip_a2_title, m.ip_a2_body],
		[m.ip_g2_title, m.ip_g2_body],
		[m.ip_a3_title, m.ip_a3_body],
		[m.ip_a4_title, m.ip_a4_body],
		[m.ip_a5_title, m.ip_a5_body],
		[m.ip_a6_title, m.ip_a6_body],
		[m.ip_a7_title, m.ip_a7_body],
		[m.ip_a8_title, m.ip_a8_body],
		[m.ip_coverage_title, m.ip_coverage_body],
	] as const;
	return (
		<article className="mx-auto max-w-3xl space-y-9 px-5 py-12 sm:py-16">
			<header className="space-y-5">
				<a href="/ip-check" className="text-primary underline">
					← {m.ip_title()}
				</a>
				<h1 className="font-bold text-3xl leading-tight sm:text-4xl">
					{m.ip_article_title()}
				</h1>
				<p className="text-muted-foreground leading-7">
					{m.ip_article_intro()}
				</p>
			</header>
			<nav
				className="space-y-2 rounded-2xl border bg-muted/30 p-5"
				aria-label={m.ip_guide()}
			>
				{sections.map(([title], i) => (
					<a
						className="block text-sm underline underline-offset-4"
						href={`#section-${i}`}
						key={title()}
					>
						{i + 1}. {title()}
					</a>
				))}
			</nav>
			{sections.map(([title, body], i) => (
				<section
					id={`section-${i}`}
					key={title()}
					className="scroll-mt-24 space-y-4 border-t pt-7"
				>
					<h2 className="font-semibold text-xl">{title()}</h2>
					<p className="text-muted-foreground leading-8">{body()}</p>
					{i === 6 && (
						<pre className="overflow-x-auto rounded-xl bg-muted p-4 text-xs leading-6">
							<code>
								{localChecksCommand +
									"\n\n# Windows PowerShell\n" +
									windowsChecksCommand}
							</code>
						</pre>
					)}
				</section>
			))}
			<footer className="space-y-4 border-t pt-7">
				<h2 className="font-semibold">{m.ip_article_sources()}</h2>
				<p className="text-muted-foreground text-sm leading-7">
					{m.ip_article_credit()}
				</p>
				<ul className="space-y-2 break-words text-sm underline">
					<li>
						<a href="https://ipquery.io/" rel="noreferrer">
							IPQuery · API / commercial use
						</a>
					</li>
					<li>
						<a
							href="https://www.anthropic.com/supported-countries"
							rel="noreferrer"
						>
							Anthropic · Supported countries
						</a>
					</li>
					<li>
						<a href="https://proxycheck.io/api/" rel="noreferrer">
							proxycheck.io · API documentation
						</a>
					</li>
					<li>
						<a
							href="https://github.com/leeguooooo/claude-code-usage-bar/blob/a36a0b51c464b31c1b9b6189c29857e06ef63795/src/claude_statusbar/ip_score.py"
							rel="noreferrer"
						>
							leeguooooo · ip_score.py · MIT
						</a>
					</li>
					<li>
						<a
							href="https://blog.leeguoo.com/en/posts/claude-account-ban-network-detection/"
							rel="noreferrer"
						>
							leeguoo · Claude account / network detection
						</a>
					</li>
				</ul>
				<a
					href="/ip-check"
					className="inline-block rounded-xl bg-primary px-5 py-3 text-primary-foreground"
				>
					{m.ip_query_current()}
				</a>
			</footer>
		</article>
	);
}
