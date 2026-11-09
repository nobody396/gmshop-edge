import { Link, Outlet } from "@tanstack/react-router";
import { Search, ShieldCheck, Zap } from "lucide-react";
import { AuthAnimationProvider } from "#/features/auth/components/auth-animation-context";
import { AppTitle } from "#/layouts/components/app-title";
import { QuickSettings } from "#/layouts/components/quick-settings";
import { m } from "#/paraglide/messages";

export function AuthLayout() {
	return (
		<AuthAnimationProvider>
			<AuthLayoutContent />
		</AuthAnimationProvider>
	);
}

function AuthLayoutContent() {
	return (
		<div className="container relative grid h-svh flex-col items-center justify-center pt-[var(--safe-top)] pb-[var(--safe-bottom)] lg:max-w-none lg:grid-cols-2 lg:px-0">
			<section className="relative hidden h-full overflow-hidden bg-muted text-foreground lg:block">
				<div className="absolute inset-0 bg-[linear-gradient(rgba(0,0,0,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(0,0,0,0.03)_1px,transparent_1px)] bg-[size:48px_48px] opacity-60 dark:bg-[linear-gradient(rgba(255,255,255,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.03)_1px,transparent_1px)]" />
				<div className="absolute top-[-10%] right-[-5%] size-80 rounded-full bg-primary/5 blur-3xl" />
				<div className="absolute bottom-[-10%] left-[-5%] size-72 rounded-full bg-primary/5 blur-3xl" />
				<div className="relative z-20 flex h-full flex-col items-center justify-center gap-10 p-12">
					<div className="w-full space-y-4 text-center">
						<p className="text-muted-foreground text-xs uppercase tracking-[0.3em]">
							{m.auth_brand_eyebrow()}
						</p>
						<h2 className="font-semibold text-3xl tracking-tight xl:text-4xl">
							{m.auth_brand_title()}
						</h2>
						<p className="text-muted-foreground text-sm leading-relaxed">
							{m.auth_brand_description()}
						</p>
					</div>
					<ul className="grid w-full max-w-sm gap-3">
						{(
							[
								[Zap, m.auth_brand_point_delivery()],
								[ShieldCheck, m.auth_brand_point_warranty()],
								[Search, m.auth_brand_point_guest()],
							] as const
						).map(([Icon, label]) => (
							<li
								className="flex items-center gap-3 rounded-2xl border bg-background/60 px-4 py-3 text-sm backdrop-blur-sm"
								key={label}
							>
								<span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
									<Icon className="size-4" />
								</span>
								{label}
							</li>
						))}
					</ul>
				</div>
			</section>
			<section className="flex h-full min-w-xs flex-col lg:p-8">
				<header className="mx-auto flex w-full items-center justify-between py-4 sm:px-8 lg:px-0 lg:py-0">
					<Link
						aria-label={m.store_nav_shop()}
						className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
						to="/"
					>
						<AppTitle description />
					</Link>
					<QuickSettings />
				</header>
				<main
					className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center pb-24 outline-none"
					id="content"
					tabIndex={-1}
				>
					<Outlet />
				</main>
			</section>
		</div>
	);
}
