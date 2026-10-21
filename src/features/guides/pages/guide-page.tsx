import { Link } from "@tanstack/react-router";
import type { PublicGuideData } from "#/features/guides/queries";
import { guidesIndexTitle } from "#/features/guides/seo";
import { GUIDE_OUT_OF_STOCK_LABEL } from "#/features/guides/tokens";

export function GuidePage({ guide }: { guide: PublicGuideData }) {
	return (
		<article className="mx-auto max-w-3xl space-y-10 px-5 py-12 sm:py-16">
			<header className="space-y-4">
				<nav aria-label="面包屑" className="text-muted-foreground text-sm">
					<Link className="hover:text-foreground" to="/">
						首页
					</Link>
					<span className="px-2">/</span>
					<Link className="hover:text-foreground" to="/guides">
						{guidesIndexTitle}
					</Link>
				</nav>
				<h1 className="font-bold text-3xl leading-tight sm:text-4xl">
					{guide.title}
				</h1>
				<p className="text-muted-foreground leading-7">{guide.description}</p>
				<p className="text-muted-foreground text-xs">
					更新于 <time dateTime={guide.updatedDate}>{guide.updatedDate}</time>
				</p>
			</header>
			<div
				className="prose prose-neutral dark:prose-invert max-w-none prose-a:text-primary prose-headings:scroll-mt-24"
				// Rendered and sanitized on the server (raw HTML is dropped).
				// biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized server output
				dangerouslySetInnerHTML={{ __html: guide.html }}
			/>
			{guide.faq.length > 0 && (
				<section id="faq" className="scroll-mt-24 space-y-4 border-t pt-8">
					<h2 className="font-semibold text-xl">常见问题</h2>
					<dl className="space-y-5">
						{guide.faq.map((item) => (
							<div key={item.q} className="space-y-1.5">
								<dt className="font-medium">{item.q}</dt>
								<dd className="whitespace-pre-line text-muted-foreground leading-7">
									{item.a}
								</dd>
							</div>
						))}
					</dl>
				</section>
			)}
			{guide.relatedProducts.length > 0 && (
				<section className="space-y-4 border-t pt-8">
					<h2 className="font-semibold text-xl">相关商品</h2>
					<ul className="grid gap-3 sm:grid-cols-2">
						{guide.relatedProducts.map((product) => (
							<li key={product.id}>
								<Link
									className="flex h-full flex-col gap-2 rounded-xl border p-4 transition-colors hover:bg-muted/50"
									params={{ productId: product.id }}
									to="/products/$productId"
								>
									<span className="font-medium leading-6">{product.name}</span>
									<span className="flex items-center justify-between gap-2 text-sm">
										<span className="font-semibold text-primary">
											{product.priceLabel ?? ""}
										</span>
										<span
											className={
												product.inStock
													? "text-emerald-600 dark:text-emerald-400"
													: "text-muted-foreground"
											}
										>
											{product.inStock ? "有货" : GUIDE_OUT_OF_STOCK_LABEL}
										</span>
									</span>
								</Link>
							</li>
						))}
					</ul>
				</section>
			)}
		</article>
	);
}
