"use client";

import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
	ChevronRight,
	ExternalLink,
	Headphones,
	MessageCircle,
	QrCode,
	Send,
	Settings,
	ShoppingCart,
} from "lucide-react";
import { type ComponentProps, useEffect, useState } from "react";
import { Avatar, AvatarFallback, AvatarImage } from "#/components/ui/avatar";
import { Button } from "#/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "#/components/ui/popover";
import { authClient } from "#/features/auth/auth-client";
import { isInternalIdentityEmail } from "#/features/auth/identity-email";
import { getStorefrontAdminEntryFn } from "#/features/auth/server/session";
import { useCurrency } from "#/features/exchange-rates/currency-context";
import { useLocalCart } from "#/features/storefront/cart-storage";
import { webSupportOpenEvent } from "#/features/telegram/web-support-contract";
import useDialogState from "#/hooks/use-dialog-state";
import { AppTitle } from "#/layouts/components/app-title";
import { SignOutDialog } from "#/layouts/components/sign-out-dialog";
import { cn } from "#/lib/utils";
import { m } from "#/paraglide/messages";
import {
	AccountSettingsPanel,
	type HeaderUser,
	type SettingsCurrency,
	type SettingsPanelPage,
} from "./account-settings-panel";

export function PublicHeader() {
	const session = authClient.useSession();
	const currencySelection = useCurrency();
	const user = session.data?.user;
	const adminEntry = useQuery({
		enabled: Boolean(user),
		queryFn: () => getStorefrontAdminEntryFn(),
		queryKey: ["auth", "storefront-admin-entry", user?.id],
		retry: false,
		staleTime: 60_000,
	});
	const signedIn = Boolean(user);
	const navigation = publicNavigation({ signedIn });
	const [stuck, setStuck] = useState(false);
	useEffect(() => {
		const update = () => setStuck(window.scrollY > 0);
		update();
		window.addEventListener("scroll", update, { passive: true });
		return () => window.removeEventListener("scroll", update);
	}, []);
	const headerUser = user
		? {
				email: isInternalIdentityEmail(user.email) ? "" : user.email,
				image: user.image,
				name: user.name,
			}
		: null;
	return (
		<header
			className={cn(
				"sticky inset-x-0 top-0 z-50 hidden border-transparent border-b bg-background/90 pt-safe transition-[border-color,backdrop-filter] lg:block",
				stuck && "border-border/70 backdrop-blur-xl",
			)}
		>
			<div className="container flex h-18 items-center px-4">
				<Link className="min-w-0 shrink-0" to="/">
					<AppTitle />
				</Link>
				<div className="ms-auto flex items-center">
					<nav className="me-6 flex items-center gap-6 text-muted-foreground text-sm">
						{navigation.map(([label, href]) => (
							<a
								className="py-2 transition-colors hover:text-foreground"
								href={href}
								key={href}
							>
								{label}
							</a>
						))}
					</nav>
					<div className="flex items-center gap-1 ps-1">
						<CustomerSupport />
						<CartAction />
						<DesktopSettings
							currencySelection={currencySelection}
							root={adminEntry.data?.root}
							user={headerUser}
						/>
						{user ? null : <SignInAction />}
					</div>
				</div>
			</div>
		</header>
	);
}

const telegramSupportUrl = "https://t.me/laoshirenai_support_bot";
const wechatQrUrl = "/support/wechat-jerrys.png";

function CustomerSupport() {
	const [open, setOpen] = useState(false);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button className="gap-2 rounded-full" variant="ghost">
					<Headphones className="size-4" />
					{m.store_support()}
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="w-80 p-2">
				<div className="px-3 pt-2 pb-3">
					<p className="font-medium">{m.store_support_title()}</p>
					<p className="mt-1 text-muted-foreground text-sm leading-5">
						{m.store_support_description()}
					</p>
				</div>
				<SupportAction
					description={m.store_support_online_description()}
					icon={MessageCircle}
					label={m.store_support_online()}
					onClick={() => {
						setOpen(false);
						window.dispatchEvent(new Event(webSupportOpenEvent));
					}}
				/>
				<div className="mx-1 my-1 rounded-2xl border bg-muted/30 p-3">
					<div className="flex items-center gap-3">
						<span className="grid size-9 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
							<QrCode className="size-4" />
						</span>
						<span className="min-w-0 flex-1">
							<span className="block font-medium text-sm">
								{m.store_support_wechat()}
							</span>
							<span className="block text-muted-foreground text-xs">
								{m.store_support_wechat_description()}
							</span>
						</span>
					</div>
					<a
						className="mt-3 block rounded-xl bg-white p-2 shadow-sm ring-1 ring-black/5 transition-transform hover:scale-[1.01]"
						href={wechatQrUrl}
						rel="noreferrer"
						target="_blank"
					>
						<img
							alt={m.store_support_wechat_qr_alt()}
							className="mx-auto h-auto w-44 max-w-full"
							height={620}
							src={wechatQrUrl}
							width={613}
						/>
					</a>
				</div>
				<SupportLink
					description="@laoshirenai_support_bot"
					href={telegramSupportUrl}
					icon={Send}
					label={m.store_support_private()}
				/>
			</PopoverContent>
		</Popover>
	);
}

function SupportAction({
	description,
	icon: Icon,
	label,
	onClick,
}: {
	description: string;
	icon: typeof MessageCircle;
	label: string;
	onClick: () => void;
}) {
	return (
		<button
			className="flex w-full items-center gap-3 rounded-xl px-3 py-3 text-start transition-colors hover:bg-muted"
			onClick={onClick}
			type="button"
		>
			<span className="grid size-9 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
				<Icon className="size-4" />
			</span>
			<span className="min-w-0 flex-1">
				<span className="block font-medium text-sm">{label}</span>
				<span className="block text-muted-foreground text-xs">
					{description}
				</span>
			</span>
			<ChevronRight className="size-4 text-muted-foreground" />
		</button>
	);
}

function SupportLink({
	description,
	href,
	icon: Icon,
	label,
}: {
	description: string;
	href: string;
	icon: typeof Send;
	label: string;
}) {
	return (
		<a
			className="flex items-center gap-3 rounded-xl px-3 py-3 transition-colors hover:bg-muted"
			href={href}
			rel="noreferrer"
			target="_blank"
		>
			<span className="grid size-9 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
				<Icon className="size-4" />
			</span>
			<span className="min-w-0 flex-1">
				<span className="block font-medium text-sm">{label}</span>
				<span className="block truncate text-muted-foreground text-xs">
					{description}
				</span>
			</span>
			<ExternalLink className="size-4 text-muted-foreground" />
		</a>
	);
}

function DesktopSettings({
	currencySelection,
	root,
	user,
}: {
	currencySelection: SettingsCurrency;
	root?: boolean;
	user?: HeaderUser | null;
}) {
	const [open, setOpen] = useState(false);
	const [page, setPage] = useState<SettingsPanelPage>("main");
	const [signOutOpen, setSignOutOpen] = useDialogState();
	const handleOpenChange = (nextOpen: boolean) => {
		setOpen(nextOpen);
		if (!nextOpen) setPage("main");
	};
	return (
		<>
			<Popover open={open} onOpenChange={handleOpenChange}>
				<PopoverTrigger asChild>
					<SettingsTrigger user={user} />
				</PopoverTrigger>
				<PopoverContent align="end" className="w-72 overflow-hidden p-0">
					<AccountSettingsPanel
						currencySelection={currencySelection}
						onClose={() => handleOpenChange(false)}
						onPageChange={setPage}
						onSignOut={() => {
							handleOpenChange(false);
							setSignOutOpen(true);
						}}
						page={page}
						root={root}
						user={user}
					/>
				</PopoverContent>
			</Popover>
			<SignOutDialog
				open={Boolean(signOutOpen)}
				onOpenChange={setSignOutOpen}
			/>
		</>
	);
}

function SettingsTrigger({
	user,
	...triggerProps
}: { user?: HeaderUser | null } & ComponentProps<typeof Button>) {
	if (!user)
		return (
			<Button
				{...triggerProps}
				aria-label={m.store_header_settings()}
				className={cn("rounded-full", triggerProps.className)}
				size="icon"
				variant="ghost"
			>
				<Settings />
			</Button>
		);
	const email = user.email || "";
	const name = user.name || email || m.store_account_title();
	return (
		<Button
			{...triggerProps}
			aria-label={m.store_account_title()}
			className={cn("rounded-full", triggerProps.className)}
			size="icon"
			variant="ghost"
		>
			<Avatar className="size-7">
				<AvatarImage alt={name} src={user.image || ""} />
				<AvatarFallback>{getUserFallback(name, email)}</AvatarFallback>
			</Avatar>
		</Button>
	);
}

function SignInAction() {
	return (
		<Button asChild>
			<Link search={{ redirect: undefined }} to="/sign-in">
				{m.public_sign_in()}
			</Link>
		</Button>
	);
}

function getUserFallback(name: string, email: string) {
	const source = name || email || "U";
	return source
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((part) => part[0]?.toUpperCase())
		.join("");
}

function CartAction() {
	const cart = useLocalCart();
	const count = cart.items.reduce((sum, item) => sum + item.quantity, 0);
	return (
		<Button asChild className="rounded-full" size="icon" variant="ghost">
			<Link aria-label={m.store_cart_title()} to="/cart">
				<ShoppingCart />
				{count ? (
					<span className="absolute translate-x-3 -translate-y-3 rounded-full bg-primary px-1 text-[10px] text-primary-foreground">
						{count > 99 ? "99+" : count}
					</span>
				) : null}
			</Link>
		</Button>
	);
}

function publicNavigation({ signedIn }: { signedIn: boolean }) {
	const navigation: Array<readonly [string, string]> = [
		[m.store_nav_shop(), "/"],
	];
	navigation.push(
		signedIn
			? [m.store_account_orders(), "/account/orders"]
			: [m.store_nav_orders(), "/orders"],
	);
	return navigation;
}
