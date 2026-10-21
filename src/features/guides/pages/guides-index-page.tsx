import { staticGuidePages } from "#/features/guides/content";
import type { PublicGuideListData } from "#/features/guides/queries";
import {
	guidesIndexDescription,
	guidesIndexTitle,
} from "#/features/guides/seo";

type Entry = {
	path: string;
	title: string;
	description: string;
	updatedDate: string | null;
};

export function GuidesIndexPage({ guides }: { guides: PublicGuideListData }) {
	const entries: Entry[] = [
		...guides,
		...staticGuidePages.map((page) => ({ ...page, updatedDate: null })),
	];
	return (
		<div className="mx-auto max-w-3xl space-y-8 px-5 py-12 sm:py-16">
			<header className="space-y-3">
				<h1 className="font-bold text-3xl leading-tight sm:text-4xl">
					{guidesIndexTitle}
				</h1>
				<p className="text-muted-foreground leading-7">
					{guidesIndexDescription}
				</p>
			</header>
			<ul className="divide-y border-y">
				{entries.map((entry) => (
					<li key={entry.path}>
						<a
							className="block space-y-1.5 py-5 transition-opacity hover:opacity-80"
							href={entry.path}
						>
							<h2 className="font-semibold text-lg leading-7">{entry.title}</h2>
							<p className="text-muted-foreground text-sm leading-6">
								{entry.description}
							</p>
							{entry.updatedDate && (
								<p className="text-muted-foreground text-xs">
									更新于 {entry.updatedDate}
								</p>
							)}
						</a>
					</li>
				))}
			</ul>
		</div>
	);
}
