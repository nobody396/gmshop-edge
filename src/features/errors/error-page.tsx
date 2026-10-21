import { Link } from "@tanstack/react-router";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { AppTitle } from "#/layouts/components/app-title";
import { QuickSettings } from "#/layouts/components/quick-settings";
import { cn } from "#/lib/utils";
import { m } from "#/paraglide/messages";

export function ErrorPage({
	code,
	icon: Icon,
	title,
	description,
	actions,
	className,
	minimal = false,
	detail,
}: {
	code?: string;
	icon: LucideIcon;
	title: string;
	description: string;
	actions?: ReactNode;
	className?: string;
	minimal?: boolean;
	detail?: string;
}) {
	return (
		<main
			className={cn(
				"relative isolate flex w-full items-center justify-center overflow-hidden px-5 py-16",
				minimal ? "min-h-64 rounded-3xl bg-muted/30" : "min-h-svh",
				className,
			)}
			id="content"
			tabIndex={-1}
		>
			{!minimal ? (
				<>
					<div className="-z-10 absolute top-1/4 left-1/4 size-72 rounded-full bg-primary/5 blur-3xl" />
					<div className="-z-10 absolute right-1/4 bottom-1/4 size-64 rounded-full bg-muted blur-3xl" />
					<header className="absolute inset-x-0 top-0 flex items-center justify-between px-5 py-5 sm:px-8">
						<Link
							aria-label={m.common_backToHome()}
							className="rounded-lg outline-none ring-offset-background focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
							to="/"
						>
							<AppTitle />
						</Link>
						<QuickSettings />
					</header>
				</>
			) : null}
			<div className="flex w-full max-w-xl flex-col items-center text-center">
				<div className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
					<Icon className="size-7" aria-hidden />
				</div>
				{code ? (
					<p className="mt-5 font-medium text-muted-foreground text-sm tracking-[0.2em]">
						{code}
					</p>
				) : null}
				<h1 className="mt-3 text-balance font-semibold text-3xl tracking-tight sm:text-4xl">
					{title}
				</h1>
				<p className="mt-4 max-w-lg text-pretty text-muted-foreground leading-7">
					{description}
				</p>
				{detail ? (
					<pre className="mt-6 max-w-full whitespace-pre-wrap break-all rounded-lg bg-muted/50 px-3 py-2 text-left font-mono text-muted-foreground text-xs">
						{detail}
					</pre>
				) : null}
				{actions ? (
					<div className="mt-8 flex w-full max-w-sm flex-col-reverse gap-3 sm:flex-row sm:justify-center [&>*]:sm:min-w-36">
						{actions}
					</div>
				) : null}
			</div>
		</main>
	);
}
