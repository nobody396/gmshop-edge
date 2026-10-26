"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import {
	BookOpen,
	Copy,
	Eye,
	EyeOff,
	Headphones,
	Monitor,
	Plus,
	RefreshCw,
	ShieldCheck,
	TriangleAlert,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { webSupportOpenEvent } from "#/features/telegram/web-support-contract";
import { formatMinorAmountWithSymbol } from "#/lib/format";
import { getLocale } from "#/paraglide/runtime";
import { type ClaudeEnvStatus, formatGb } from "../domain";
import {
	getClaudeEnvPanelFn,
	revealClaudeEnvCodeFn,
} from "../server/functions";

const guidePath = "/account/claude-env-guide";

/** Two-locale copy kept with the feature (zh-CN is the primary audience). */
const copy = {
	title: ["Claude 专属环境", "Claude dedicated environment"],
	preparing: [
		"付款已收到，正在为你准备专属环境。",
		"Payment received. We are preparing your dedicated environment.",
	],
	fewMinutes: [
		"一般几分钟内完成，本页会自动刷新。",
		"This usually takes a few minutes. This page refreshes automatically.",
	],
	autoRefresh: ["本页会自动刷新。", "This page refreshes automatically."],
	waitPrepare: [
		"等待时请先完成准备：在要用 Claude 的 Mac / Windows 电脑上装好 Clash Verge Rev，并确认能正常打开 google.com。先不要注册任何账号。",
		"While you wait, get ready: install Clash Verge Rev on the Mac / Windows computer you will use for Claude and make sure google.com opens. Do not sign up for anything yet.",
	],
	guideLink: [
		"完整图文教程（配环境 → 注册 ProtonMail → 注册 Claude → 开通会员）",
		"Full step-by-step guide (setup → ProtonMail → Claude → subscription)",
	],
	ip: ["专属 IP", "Dedicated IP"],
	city: ["城市", "City"],
	timezone: ["时区", "Time zone"],
	residential: [
		"专属线路，只给你一个人用。",
		"A dedicated line, used only by you.",
	],
	scope: [
		"一个环境给一台电脑用；可以在这台电脑上养 2～3 个 Claude 号，换号先退出登录。",
		"One environment is for one computer. You can keep 2–3 Claude accounts on it; sign out before switching.",
	],
	expires: ["到期时间", "Expires"],
	daysLeft: ["剩余", "Days left"],
	days: ["天", "days"],
	traffic: ["本期流量", "Traffic this period"],
	trafficReset: ["重置日", "Resets"],
	trafficNote: [
		(quota: string) =>
			`每期含 ${quota}，到重置日自动清零；不够用可以随时加流量（只在本期有效）。`,
		(quota: string) =>
			`Each period includes ${quota} and resets on the reset date. Need more? Add traffic any time (current period only).`,
	],
	trafficAddon: [
		(base: string, addon: string) => `含基础 ${base} + 本期加购 ${addon}`,
		(base: string, addon: string) =>
			`Base ${base} + ${addon} added this period`,
	],
	trafficBanner: [
		(percent: string, used: string, total: string, left: string) =>
			`本期流量已用 ${percent}（${used} / ${total}），剩余 ${left}。`,
		(percent: string, used: string, total: string, left: string) =>
			`You have used ${percent} of this period's traffic (${used} of ${total}); ${left} left.`,
	],
	trafficBannerHint: [
		"不够用的话现在就可以加流量，付款后立即生效。",
		"If it may not be enough, add traffic now; it takes effect right after payment.",
	],
	addTraffic: ["加流量", "Add traffic"],
	addTrafficTitle: [
		"加流量（只在本期有效）",
		"Add traffic (current period only)",
	],
	addTrafficNote: [
		(end: string) =>
			`加购的流量只在本期有效（到 ${end} 为止），不累积到下一期；付款后立即生效。`,
		(end: string) =>
			`Added traffic is valid for the current period only (until ${end}) and does not carry over. It takes effect right after payment.`,
	],
	renewChoose: ["选择续费时长", "Choose a renewal period"],
	renewMonth: ["续 1 个月", "Renew 1 month"],
	renewQuarter: ["续 1 个季度", "Renew 1 quarter"],
	close: ["收起", "Close"],
	line: ["线路检查", "Line check"],
	lineOk: ["正常", "OK"],
	lineBadTitle: ["线路检测异常", "Line check failed"],
	lineBad: [
		"先不要打开 Claude，我们已收到提醒正在处理；着急可点下方联系客服。",
		"Do not open Claude for now. We have been alerted and are fixing it. If it is urgent, contact support below.",
	],
	support: ["联系客服", "Contact support"],
	start: ["开始使用", "Get started"],
	step1: [
		"准备：这台 Mac / Windows 电脑上已装好 Clash Verge Rev，并能正常打开 google.com。",
		"Prepare: Clash Verge Rev is installed on this Mac / Windows computer and google.com opens normally.",
	],
	step2: [
		"请在要用 Claude 的电脑上打开本页面。",
		"Open this page on the computer you will use Claude on.",
	],
	phoneTip: [
		"你现在是在手机上看。命令要在电脑上运行，请用电脑登录 laoshirenvip.com 打开此订单。",
		"You are on a phone. The command must run on a computer: sign in to laoshirenvip.com on your computer and open this order.",
	],
	step3: [
		"点「显示开通码」，复制你电脑对应的那一行命令，粘贴到终端运行（Mac：启动台搜索「终端」；Windows：右键开始 →「终端（管理员）」）。",
		"Click “Show code”, copy the line for your computer and paste it into a terminal (Mac: search “Terminal” in Launchpad; Windows: right-click Start → Terminal (Admin)).",
	],
	step4: [
		"先了解会改动什么：命令会把系统语言里的英语排到第一位（中文和输入法保留）、地区改为美国、时区改成和专属 IP 一致、关闭定位；Mac 会要求输入一次开机密码（输入时不显示）。看到「全部验收通过 ✅」就成功；有红色项目请截图发客服。",
		"What will change: the command puts English first in system languages (Chinese and input methods stay), sets the region to US, matches the time zone to your IP and turns off Location. A Mac asks for your login password once (it is not shown as you type). “All checks passed ✅” means success; if anything is red, send a screenshot to support.",
	],
	step5: [
		(ip: string) =>
			`重启电脑一次，打开 IP 检测页：显示的 IP 和你的专属 IP（${ip}）一致、没有红色项目，就配好了。`,
		(ip: string) =>
			`Restart the computer once and open the IP check page. If it shows your dedicated IP (${ip}) and nothing is red, you are done.`,
	],
	code: ["开通码", "Activation code"],
	show: ["显示开通码", "Show code"],
	hide: ["隐藏", "Hide"],
	codeHidden: ["点「显示开通码」查看", "Click “Show code” to see it"],
	agentTitle: [
		"交给 AI 助手配置（可选）",
		"Let your AI assistant set it up (optional)",
	],
	agentHint: [
		"把下面这段话整段复制给你的 Codex、Claude Code 等 AI 助手，它会帮你把环境配好，最后回复「OK」。输开机密码、关定位服务这两步仍需你本人操作。",
		'Copy this whole text to your AI assistant (Codex, Claude Code…). It sets everything up and replies "OK". You still type your login password and turn off Location Services yourself.',
	],
	codeHint: [
		"开通码相当于你专属线路的密码，不要发给别人。",
		"The code works like the password of your private line; do not share it.",
	],
	mac: ["Mac 电脑用这一行：", "Mac: use this line"],
	windows: ["Windows 电脑用这一行：", "Windows: use this line"],
	copy: ["复制", "Copy"],
	copied: ["已复制", "Copied"],
	copyFailed: [
		"复制失败，请手动选中复制",
		"Copy failed; select and copy manually",
	],
	revealFailed: [
		"暂时取不到开通码，请稍后再试",
		"Code is not available yet; try again later",
	],
	expiring: [
		(n: number) => `还有 ${n} 天到期`,
		(n: number) => `Expires in ${n} day${n === 1 ? "" : "s"}`,
	],
	renew: ["续费", "Renew"],
	renewNow: ["立即续费", "Renew now"],
	renewKeep: [
		"续费后专属 IP 不变，不用重新配置。",
		"After renewal your dedicated IP stays the same; no need to set anything up again.",
	],
	renewWarning: [
		"如果不续费，到期后环境会立即失效，专属 IP 会被释放，再也无法找回。",
		"If you do not renew, the environment stops working the moment it expires and the dedicated IP is released. It can never be recovered.",
	],
} as const;

const statusCopy: Record<
	ClaudeEnvStatus,
	{
		label: [string, string];
		text: [string, string];
		tone: "ok" | "wait" | "bad";
	}
> = {
	awaiting_ip: {
		label: ["准备中", "Preparing"],
		text: [
			"正在为你准备专属环境，不用做任何操作。",
			"We are preparing your dedicated environment; nothing to do on your side.",
		],
		tone: "wait",
	},
	provisioning: {
		label: ["检查中", "Checking"],
		text: [
			"专属 IP 已到位，正在检查线路和 IP 质量，通过后马上可以用。",
			"Your IP is ready. We are checking the line and IP quality; you can use it right after.",
		],
		tone: "wait",
	},
	needs_replace: {
		label: ["更换中", "Replacing"],
		text: [
			"这个 IP 没通过我们的质量检查，我们正在为你换一个更好的（24 小时内），无需操作。",
			"The IP did not pass our quality check. We are replacing it with a better one (within 24 hours); nothing to do on your side.",
		],
		tone: "wait",
	},
	active: {
		label: ["正常", "Active"],
		text: [
			"正常使用中。第一次使用请按下面的步骤做一次。",
			"Active. On first use, follow the steps below once.",
		],
		tone: "ok",
	},
	expired: {
		label: ["已到期", "Expired"],
		text: [
			"已到期，环境已失效，专属 IP 已释放，无法找回。如需继续使用请重新购买（会分配新的 IP，需要重新运行配置命令）。",
			"Expired. The environment no longer works and the dedicated IP has been released; it cannot be recovered. To continue, buy again (you will get a new IP and need to run the setup command again).",
		],
		tone: "bad",
	},
	suspended: {
		label: ["已暂停", "Suspended"],
		text: [
			"服务已暂停，请联系客服。",
			"Service is suspended; please contact support.",
		],
		tone: "bad",
	},
	cancelled: {
		label: ["已取消", "Cancelled"],
		text: ["订单已取消。", "The order was cancelled."],
		tone: "bad",
	},
};

const pendingStatuses: ClaudeEnvStatus[] = [
	"awaiting_ip",
	"provisioning",
	"needs_replace",
];

/** IANA zones the IPs come from, shown as plain words. Unknown zones stay raw. */
const timezoneLabels: Record<string, [string, string]> = {
	"America/New_York": ["美国东部时间", "US Eastern Time"],
	"America/Chicago": ["美国中部时间", "US Central Time"],
	"America/Denver": ["美国山地时间", "US Mountain Time"],
	"America/Los_Angeles": ["美国西部时间", "US Pacific Time"],
};

function isZh() {
	return getLocale() !== "en-US";
}

function useText() {
	const zh = isZh();
	return (pair: readonly [string, string]) => (zh ? pair[0] : pair[1]);
}

/** Date and time to the minute in the reader's locale. */
function formatMinute(value: number) {
	return new Intl.DateTimeFormat(getLocale(), {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(new Date(value));
}

function openSupport() {
	window.dispatchEvent(new Event(webSupportOpenEvent));
}

async function copyText(value: string, t: ReturnType<typeof useText>) {
	try {
		await navigator.clipboard.writeText(value);
		toast.success(t(copy.copied));
	} catch {
		toast.error(t(copy.copyFailed));
	}
}

export function ClaudeEnvPanel({ orderNumber }: { orderNumber: string }) {
	const t = useText();
	const panel = useQuery({
		queryKey: ["claude-env", "panel", orderNumber],
		queryFn: () => getClaudeEnvPanelFn({ data: { orderNumber } }),
		refetchInterval: (query) =>
			query.state.data &&
			(query.state.data.state === "preparing" ||
				pendingStatuses.includes(query.state.data.status))
				? 20_000
				: 120_000,
		retry: false,
	});
	const data = panel.data;
	if (!data) return null;
	return (
		<section
			className="mb-6 grid gap-5 rounded-3xl border bg-card p-5 shadow-sm sm:p-8"
			aria-labelledby="claude-env-title"
		>
			<h2
				className="flex items-center gap-2 font-semibold text-xl tracking-tight"
				id="claude-env-title"
			>
				<ShieldCheck className="size-6 text-primary" />
				{t(copy.title)}
			</h2>
			{data.state === "preparing" ? (
				<PendingView
					label={statusCopy.awaiting_ip.label}
					text={copy.preparing}
				/>
			) : pendingStatuses.includes(data.status) ? (
				<PendingView
					label={statusCopy[data.status].label}
					minutes={data.status !== "needs_replace"}
					text={statusCopy[data.status].text}
				/>
			) : data.status === "active" ? (
				<ActiveView data={data} orderNumber={orderNumber} />
			) : (
				<ClosedView data={data} />
			)}
		</section>
	);
}

type SubscriptionData = Extract<
	NonNullable<Awaited<ReturnType<typeof getClaudeEnvPanelFn>>>,
	{ state: "subscription" }
>;

function StatusLine({
	label,
	text,
	tone,
}: {
	label: readonly [string, string];
	text: readonly [string, string];
	tone: "ok" | "wait" | "bad";
}) {
	const t = useText();
	return (
		<div className="flex flex-wrap items-center gap-2">
			<Badge
				variant={
					tone === "ok"
						? "default"
						: tone === "wait"
							? "secondary"
							: "destructive"
				}
			>
				{t(label)}
			</Badge>
			<p className="text-sm leading-6">{t(text)}</p>
		</div>
	);
}

function GuideLink() {
	const t = useText();
	return (
		<a
			className="flex items-center gap-3 rounded-xl border border-primary/30 bg-primary/5 p-3 font-medium text-primary text-sm leading-6 hover:bg-primary/10"
			href={guidePath}
		>
			<BookOpen className="size-5 shrink-0" />
			<span className="underline underline-offset-4">{t(copy.guideLink)}</span>
		</a>
	);
}

function PendingView({
	label,
	text,
	minutes = true,
}: {
	label: readonly [string, string];
	text: readonly [string, string];
	minutes?: boolean;
}) {
	const t = useText();
	return (
		<div className="grid gap-4">
			<StatusLine label={label} text={text} tone="wait" />
			<p className="text-muted-foreground text-sm leading-6">
				{t(minutes ? copy.fewMinutes : copy.autoRefresh)}
			</p>
			<p className="rounded-xl bg-muted/50 p-3 text-sm leading-6">
				{t(copy.waitPrepare)}
			</p>
			<GuideLink />
		</div>
	);
}

function ClosedView({ data }: { data: SubscriptionData }) {
	const t = useText();
	const status = statusCopy[data.status];
	return (
		<div className="grid gap-4">
			<StatusLine label={status.label} text={status.text} tone={status.tone} />
			{data.status === "suspended" ? (
				<div>
					<Button onClick={openSupport} size="sm" variant="outline">
						<Headphones />
						{t(copy.support)}
					</Button>
				</div>
			) : null}
		</div>
	);
}

function ActiveView({
	data,
	orderNumber,
}: {
	data: SubscriptionData;
	orderNumber: string;
}) {
	const t = useText();
	const status = statusCopy.active;
	const zoneLabel = data.timezone ? timezoneLabels[data.timezone] : undefined;
	const timezone = zoneLabel ? t(zoneLabel) : (data.timezone ?? "—");
	return (
		<div className="grid gap-5">
			<StatusLine label={status.label} text={status.text} tone={status.tone} />
			{data.lineOk === false ? (
				<div
					className="grid gap-2 rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-sm leading-6"
					role="alert"
				>
					<p className="flex items-center gap-2 font-semibold text-destructive">
						<TriangleAlert className="size-4" />
						{t(copy.lineBadTitle)}
					</p>
					<p>{t(copy.lineBad)}</p>
					<div>
						<Button onClick={openSupport} size="sm">
							<Headphones />
							{t(copy.support)}
						</Button>
					</div>
				</div>
			) : null}
			{data.expiringSoon && data.daysLeft !== null ? (
				<RenewBox data={data} urgent />
			) : null}
			<TrafficBanner data={data} />
			<GuideLink />
			<div className="grid gap-3">
				<h3 className="font-semibold">{t(copy.start)}</h3>
				<ol className="grid gap-4 text-sm leading-6">
					<Step n={1}>{t(copy.step1)}</Step>
					<Step n={2}>
						<p>{t(copy.step2)}</p>
						<p className="mt-2 flex gap-2 rounded-lg border border-amber-500/50 bg-amber-500/10 p-3 font-medium md:hidden">
							<Monitor className="mt-0.5 size-4 shrink-0" />
							{t(copy.phoneTip)}
						</p>
					</Step>
					<Step n={3}>
						<p>{t(copy.step3)}</p>
						<CodeBlock ip={data.ip} orderNumber={orderNumber} />
					</Step>
					<Step n={4}>{t(copy.step4)}</Step>
					<Step n={5}>
						<p>{(isZh() ? copy.step5[0] : copy.step5[1])(data.ip ?? "—")}</p>
						<a
							className="break-all underline"
							href={data.ipCheckUrl}
							rel="noreferrer"
							target="_blank"
						>
							{data.ipCheckUrl}
						</a>
					</Step>
				</ol>
			</div>
			<div className="grid gap-3 border-t pt-5">
				<dl className="grid gap-3 text-sm sm:grid-cols-3">
					<Item label={t(copy.ip)} value={data.ip ?? "—"} mono />
					<Item label={t(copy.city)} value={data.city ?? "—"} />
					<Item label={t(copy.timezone)} value={timezone} />
					{data.lineOk !== null && data.lastCheckAt ? (
						<Item
							label={t(copy.line)}
							value={`${data.lineOk ? t(copy.lineOk) : t(copy.lineBadTitle)} · ${formatMinute(data.lastCheckAt)}`}
						/>
					) : null}
				</dl>
				<p className="text-muted-foreground text-sm leading-6">
					{t(copy.residential)}
					{t(copy.scope)}
				</p>
			</div>
			<Traffic data={data} />
			{data.expiringSoon ? null : <RenewBox data={data} />}
		</div>
	);
}

function Step({ n, children }: { n: number; children: ReactNode }) {
	return (
		<li className="flex gap-3">
			<span className="grid size-6 shrink-0 place-items-center rounded-full bg-primary font-semibold text-primary-foreground text-xs">
				{n}
			</span>
			<div className="grid min-w-0 flex-1 gap-2">{children}</div>
		</li>
	);
}

type Offer = SubscriptionData["renewOptions"][number];
type TrafficOffer = SubscriptionData["trafficOptions"][number];

/** "¥299" (drops a zero fraction) in the reader's locale. */
function price(offer: Offer | TrafficOffer) {
	return formatMinorAmountWithSymbol(
		offer.priceMinor,
		offer.currency,
		offer.currencyDecimals,
	).replace(/[.,]0+$/, "");
}

const trafficAnchor = "claude-env-traffic";

/** Usage ≥ 75%: shown at the top of the panel so it is not missed. */
function TrafficBanner({ data }: { data: SubscriptionData }) {
	const t = useText();
	const zh = isZh();
	const level = data.trafficLevel;
	if (level === null) return null;
	const used = data.trafficUsedBytes;
	const quota = formatGb(data.trafficQuotaBytes);
	const options = data.trafficOptions;
	return (
		<div
			className={`grid gap-2 rounded-xl border p-3 text-sm leading-6 ${
				level >= 9000
					? "border-destructive/40 bg-destructive/5"
					: "border-amber-500/50 bg-amber-500/10"
			}`}
			role="alert"
		>
			<p
				className={`flex items-center gap-2 font-semibold ${level >= 9000 ? "text-destructive" : ""}`}
			>
				<TriangleAlert className="size-4 shrink-0" />
				{(zh ? copy.trafficBanner[0] : copy.trafficBanner[1])(
					`${level / 100}%`,
					formatGb(used),
					quota,
					formatGb(Math.max(0, data.trafficQuotaBytes - used)),
				)}
			</p>
			{options.length ? (
				<>
					<p>{t(copy.trafficBannerHint)}</p>
					<div>
						<Button asChild size="sm">
							<a href={`#${trafficAnchor}`}>
								<Plus />
								{t(copy.addTraffic)}
							</a>
						</Button>
					</div>
				</>
			) : null}
		</div>
	);
}

function Traffic({ data }: { data: SubscriptionData }) {
	const t = useText();
	const zh = isZh();
	const [open, setOpen] = useState(false);
	// Usage emails link to #claude-env-traffic: open the tiers right away.
	useEffect(() => {
		const sync = () => {
			if (window.location.hash === `#${trafficAnchor}`) setOpen(true);
		};
		sync();
		window.addEventListener("hashchange", sync);
		return () => window.removeEventListener("hashchange", sync);
	}, []);
	const used = data.trafficUsedBytes;
	const total = Math.max(1, data.trafficQuotaBytes);
	const percent = Math.min(100, Math.round((used / total) * 100));
	const quota = formatGb(data.trafficQuotaBytes);
	const level = data.trafficLevel;
	const resetText = data.trafficResetAt
		? formatMinute(data.trafficResetAt)
		: "—";
	const options = data.trafficOptions;
	return (
		<div className="grid scroll-mt-24 gap-2" id={trafficAnchor}>
			<div className="flex items-center justify-between gap-2 text-sm">
				<span>{t(copy.traffic)}</span>
				<span className="tabular-nums">
					{formatGb(used)} / {quota}
				</span>
			</div>
			<div
				aria-valuemax={100}
				aria-valuemin={0}
				aria-valuenow={percent}
				className="h-2 overflow-hidden rounded-full bg-muted"
				role="progressbar"
			>
				<div
					className={`h-full ${level !== null && level >= 9000 ? "bg-destructive" : level !== null ? "bg-amber-500" : "bg-primary"}`}
					style={{ width: `${percent}%` }}
				/>
			</div>
			<p className="text-muted-foreground text-xs leading-5">
				{data.trafficResetAt ? `${t(copy.trafficReset)}：${resetText} · ` : ""}
				{data.trafficAddonBytes > 0
					? `${(zh ? copy.trafficAddon[0] : copy.trafficAddon[1])(formatGb(data.trafficBaseBytes), formatGb(data.trafficAddonBytes))} · `
					: ""}
				{(zh ? copy.trafficNote[0] : copy.trafficNote[1])(
					formatGb(data.trafficBaseBytes),
				)}
			</p>
			{options.length ? (
				open ? (
					<div className="grid gap-3 rounded-xl bg-muted/50 p-3 text-sm leading-6">
						<div className="flex items-center justify-between gap-2">
							<p className="font-medium">{t(copy.addTrafficTitle)}</p>
							<Button onClick={() => setOpen(false)} size="sm" variant="ghost">
								{t(copy.close)}
							</Button>
						</div>
						<div className="grid gap-2 sm:grid-cols-3">
							{options.map((option) => (
								<Button
									asChild
									className="h-auto justify-between py-2"
									key={option.sku}
									variant="outline"
								>
									<a href={option.href}>
										<span className="font-semibold">{option.label}</span>
										<span className="tabular-nums">{price(option)}</span>
									</a>
								</Button>
							))}
						</div>
						<p className="text-muted-foreground text-xs">
							{(zh ? copy.addTrafficNote[0] : copy.addTrafficNote[1])(
								resetText,
							)}
						</p>
					</div>
				) : (
					<div>
						<Button
							onClick={() => setOpen(true)}
							size="sm"
							variant={level !== null ? "default" : "outline"}
						>
							<Plus />
							{t(copy.addTraffic)}
						</Button>
					</div>
				)
			) : null}
		</div>
	);
}

/** 「续费」 opens the monthly / quarterly choice; each goes straight to checkout. */
function RenewChoice({
	data,
	label,
	primary = false,
}: {
	data: SubscriptionData;
	label: readonly [string, string];
	primary?: boolean;
}) {
	const t = useText();
	const [open, setOpen] = useState(false);
	const options = data.renewOptions;
	// Without live renewal SKUs fall back to the product page.
	if (!options.length)
		return (
			<Button asChild size="sm" variant={primary ? "default" : "outline"}>
				<a href={data.renewUrl}>
					<RefreshCw />
					{t(label)}
				</a>
			</Button>
		);
	if (!open)
		return (
			<Button
				aria-expanded={false}
				onClick={() => setOpen(true)}
				size="sm"
				variant={primary ? "default" : "outline"}
			>
				<RefreshCw />
				{t(label)}
			</Button>
		);
	return (
		<div className="grid w-full gap-2">
			<p className="font-medium">{t(copy.renewChoose)}</p>
			<div className="grid gap-2 sm:grid-cols-2">
				{options.map((option) => (
					<Button
						asChild
						className="h-auto justify-between py-2"
						key={option.sku}
						variant={primary ? "default" : "outline"}
					>
						<a href={option.href}>
							<span className="font-semibold">
								{t(
									option.period === "quarterly"
										? copy.renewQuarter
										: copy.renewMonth,
								)}
							</span>
							<span className="tabular-nums">{price(option)}</span>
						</a>
					</Button>
				))}
			</div>
			<div>
				<Button onClick={() => setOpen(false)} size="sm" variant="ghost">
					{t(copy.close)}
				</Button>
			</div>
		</div>
	);
}

function RenewBox({
	data,
	urgent = false,
}: {
	data: SubscriptionData;
	urgent?: boolean;
}) {
	const t = useText();
	const expiry = data.expiresAt ? formatMinute(data.expiresAt) : "—";
	if (urgent && data.daysLeft !== null)
		return (
			<div
				className="grid gap-2 rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-sm leading-6"
				role="alert"
			>
				<p className="font-semibold text-destructive">
					{(isZh() ? copy.expiring[0] : copy.expiring[1])(data.daysLeft)} ·{" "}
					{expiry}
				</p>
				<p>{t(copy.renewKeep)}</p>
				<p className="font-semibold">{t(copy.renewWarning)}</p>
				<div>
					<RenewChoice data={data} label={copy.renewNow} primary />
				</div>
			</div>
		);
	return (
		<div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-muted/50 p-3 text-sm leading-6">
			<div className="min-w-0">
				<p>
					{t(copy.expires)}：{expiry}
					{data.daysLeft === null
						? ""
						: ` · ${t(copy.daysLeft)} ${data.daysLeft} ${t(copy.days)}`}
				</p>
				<p className="text-muted-foreground">{t(copy.renewKeep)}</p>
			</div>
			<RenewChoice data={data} label={copy.renew} />
		</div>
	);
}

function Item({
	label,
	value,
	mono = false,
}: {
	label: string;
	value: string;
	mono?: boolean;
}) {
	return (
		<div className="min-w-0">
			<dt className="text-muted-foreground text-xs">{label}</dt>
			<dd className={mono ? "break-all font-mono" : "break-words"}>{value}</dd>
		</div>
	);
}

function CodeBlock({
	orderNumber,
	ip,
}: {
	orderNumber: string;
	ip: string | null;
}) {
	const t = useText();
	const [visible, setVisible] = useState(false);
	const reveal = useMutation({
		mutationFn: () => revealClaudeEnvCodeFn({ data: { orderNumber } }),
		onSuccess: () => setVisible(true),
		onError: () => toast.error(t(copy.revealFailed)),
	});
	const result = reveal.data;
	return (
		<div className="grid gap-3 rounded-xl bg-muted/50 p-3">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<span className="font-medium">{t(copy.code)}</span>
				{visible && result ? (
					<Button onClick={() => setVisible(false)} size="sm" variant="ghost">
						<EyeOff />
						{t(copy.hide)}
					</Button>
				) : (
					<Button
						disabled={reveal.isPending}
						onClick={() => (result ? setVisible(true) : reveal.mutate())}
						size="sm"
					>
						<Eye />
						{t(copy.show)}
					</Button>
				)}
			</div>
			{visible && result ? (
				<>
					<p>{t(copy.mac)}</p>
					<CopyLine value={result.mac} />
					<p>{t(copy.windows)}</p>
					<CopyLine value={result.windows} />
					<p className="text-muted-foreground text-xs">{t(copy.code)}</p>
					<CopyLine value={result.code} />
					<p className="text-muted-foreground text-xs">{t(copy.codeHint)}</p>
					<p className="mt-2 font-medium">{t(copy.agentTitle)}</p>
					<p className="text-muted-foreground text-xs">{t(copy.agentHint)}</p>
					<CopyLine value={agentPrompt({ ...result, ip }, isZh())} />
				</>
			) : (
				<>
					<p className="text-muted-foreground">{t(copy.codeHidden)}</p>
					<p className="text-muted-foreground text-xs">{t(copy.codeHint)}</p>
				</>
			)}
		</div>
	);
}

/** Text a buyer pastes into their own AI assistant to run the whole setup. */
export function agentPrompt(
	input: { mac: string; windows: string; code: string; ip: string | null },
	zh: boolean,
) {
	const ip =
		input.ip ??
		(zh ? "订单页上的专属 IP" : "the dedicated IP on the order page");
	return zh
		? [
				"请帮我在这台电脑上配置「Claude 专属环境」。能自己做的全部自己做，只在需要我本人操作时停下来，告诉我具体点哪里。全部完成后只回复「OK」；没完成就列出没通过的项目和要我做什么。",
				`我的开通码（相当于专属线路密码，不要发到任何网站、日志或别人那里）：${input.code}`,
				"1. 先看这台电脑是 macOS 还是 Windows；确认已经安装并打开 Clash Verge Rev，并且能访问 https://www.google.com 。没装或打不开就停下告诉我。",
				"2. 运行下面对应系统的配置命令。它必须在有交互的终端里运行；如果你没法操作交互终端，就让我打开「终端」把命令粘贴进去运行，等我说跑完了再继续。",
				`macOS（终端）：${input.mac}`,
				`Windows（管理员身份的终端或 PowerShell）：${input.windows}`,
				"运行中有两步只能我本人做：输入一次开机密码（Windows 是点一次「是」），以及按提示关掉「定位服务」。遇到时告诉我怎么做。",
				"3. 命令最后应显示「全部 N 项验收通过 ✅」。有没通过的项目，按命令给出的提示处理好，再重新运行一次命令。",
				`4. 让我重启电脑；重启后打开 Clash Verge Rev，再访问 https://claude.ai/cdn-cgi/trace ，确认里面 ip= 后面是 ${ip}。`,
				"5. 只做以上这些：不要改别的系统设置，不要卸载任何软件。",
			].join("\n")
		: [
				'Please set up my "Claude dedicated environment" on this computer. Do everything you can yourself; stop only when I must act, and tell me exactly what to click. When everything passes, reply only "OK"; otherwise list what failed and what I need to do.',
				`My activation code (it works like a password; never send it to any website, log or person): ${input.code}`,
				"1. Check whether this is macOS or Windows; confirm Clash Verge Rev is installed and running and https://www.google.com opens. If not, stop and tell me.",
				"2. Run the command for this OS. It needs an interactive terminal; if you cannot drive one, ask me to paste it into Terminal and wait until I say it finished.",
				`macOS (Terminal): ${input.mac}`,
				`Windows (Terminal / PowerShell as administrator): ${input.windows}`,
				'Two steps need me: typing my login password once (on Windows: clicking "Yes" once) and turning off Location Services when prompted. Tell me when.',
				'3. The command should end with "all N checks passed ✅". If anything failed, follow its hints and run the command again.',
				`4. Ask me to restart the computer; after restart open Clash Verge Rev and visit https://claude.ai/cdn-cgi/trace — the ip= line must be ${ip}.`,
				"5. Do nothing else: don't change other system settings and don't uninstall anything.",
			].join("\n");
}

function CopyLine({
	value,
	multiline = false,
}: {
	value: string;
	multiline?: boolean;
}) {
	const t = useText();
	return (
		<div className="flex items-start gap-2">
			<code
				className={`min-w-0 flex-1 select-all break-all rounded bg-background p-2 font-mono text-xs${multiline ? " max-h-56 overflow-auto whitespace-pre-wrap" : ""}`}
			>
				{value}
			</code>
			<Button
				aria-label={t(copy.copy)}
				onClick={() => void copyText(value, t)}
				size="icon"
				variant="outline"
			>
				<Copy />
			</Button>
		</div>
	);
}
