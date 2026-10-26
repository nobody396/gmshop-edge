import { Link } from "@tanstack/react-router";
import type { PublicGuideData } from "#/features/guides/queries";
import { claudeEnvProductId } from "../domain";

/** Buyers-only setup guide (the page route checks sign-in and ownership). */
export function ClaudeEnvGuidePage({
	allowed,
	guide,
}: {
	allowed: boolean;
	guide: PublicGuideData | null;
}) {
	if (!allowed || !guide)
		return (
			<section className="mx-auto max-w-2xl space-y-4 py-10">
				<h1 className="font-bold text-2xl">Claude 专属环境完整教程</h1>
				<p className="text-muted-foreground leading-7">
					这份图文教程只对已购买「Claude
					稳定使用」的账号开放。请用下单时的账号登录；还没购买的话，可以先去看看商品。
				</p>
				<Link
					className="font-medium text-primary underline"
					params={{ productId: claudeEnvProductId }}
					to="/products/$productId"
				>
					查看商品
				</Link>
			</section>
		);
	return (
		<article className="mx-auto max-w-3xl space-y-10 py-6">
			<header className="space-y-3">
				<h1 className="font-bold text-3xl leading-tight">{guide.title}</h1>
				<p className="text-muted-foreground leading-7">{guide.description}</p>
				<p className="text-muted-foreground text-xs">
					更新于 <time dateTime={guide.updatedDate}>{guide.updatedDate}</time>·
					仅购买用户可见，请勿外传
				</p>
			</header>
			<div
				className="prose prose-neutral dark:prose-invert max-w-none prose-a:text-primary prose-headings:scroll-mt-24"
				// Rendered and sanitized on the server (raw HTML is dropped).
				// biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized server output
				dangerouslySetInnerHTML={{ __html: guide.html }}
			/>
			{guide.faq.length > 0 && (
				<section className="space-y-4 border-t pt-8">
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
		</article>
	);
}
