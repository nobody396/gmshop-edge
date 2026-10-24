"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { Copy, Eye, EyeOff, Globe, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { formatDateTime } from "#/lib/format";
import { getLocale } from "#/paraglide/runtime";
import { type ClaudeEnvStatus, formatBytes } from "../domain";
import {
	getClaudeEnvPanelFn,
	revealClaudeEnvCodeFn,
} from "../server/functions";

/** Two-locale copy kept with the feature (zh-CN is the primary audience). */
const copy = {
	title: ["Claude 专属环境", "Claude dedicated environment"],
	preparing: [
		"付款已收到，正在为你准备专属美国 IP，一般几分钟内完成。这个页面会自动刷新。",
		"Payment received. We are preparing your dedicated US IP; this usually takes a few minutes. This page refreshes automatically.",
	],
	ip: ["专属 IP", "Dedicated IP"],
	city: ["城市", "City"],
	timezone: ["时区", "Time zone"],
	network: ["网络类型", "Network"],
	residential: [
		"美国住宅宽带（只给你一个人用）",
		"US residential broadband (only you)",
	],
	expires: ["到期时间", "Expires"],
	daysLeft: ["剩余", "Days left"],
	days: ["天", "days"],
	traffic: ["本期流量", "Traffic this period"],
	trafficReset: ["重置日", "Resets"],
	line: ["线路检查", "Line check"],
	lineOk: ["正常", "OK"],
	lineBad: ["异常，我们正在处理", "Problem detected, we are on it"],
	code: ["开通码", "Activation code"],
	show: ["显示开通码", "Show code"],
	hide: ["隐藏", "Hide"],
	codeHint: [
		"开通码等于你的专属线路密码，请不要发给别人。",
		"The code is your private line password; do not share it.",
	],
	mac: [
		"Mac：打开「终端」，粘贴下面一行回车",
		"Mac: open Terminal, paste this line and press Enter",
	],
	windows: [
		"Windows：右键开始菜单 →「终端（管理员）」或「Windows PowerShell（管理员）」，粘贴下面一行回车",
		"Windows: right-click Start → Terminal (Admin) or Windows PowerShell (Admin), paste this line and press Enter",
	],
	copy: ["复制", "Copy"],
	copied: ["已复制", "Copied"],
	copyFailed: [
		"复制失败，请手动选中复制",
		"Copy failed; select and copy manually",
	],
	check: [
		"配置好后，打开 IP 检测页确认：",
		"After setup, confirm on the IP check page:",
	],
	revealFailed: [
		"暂时取不到开通码，请稍后再试",
		"Code is not available yet; try again later",
	],
	notReady: [
		"开通完成后这里会显示开通码。",
		"Your activation code appears here once ready.",
	],
	expiring: [
		(n: number) => `还有 ${n} 天到期`,
		(n: number) => `Expires in ${n} day${n === 1 ? "" : "s"}`,
	],
	renew: ["立即续费", "Renew now"],
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
			"正在为你购买专属美国 IP，一般几分钟内完成，不用做任何操作。",
			"We are buying your dedicated US IP. It usually takes a few minutes; nothing to do on your side.",
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
			"这个 IP 没通过我们的质量检查，我们正在为你换一个更好的（24 小时内），完成后这里自动更新，无需操作。",
			"The IP did not pass our quality check. We are replacing it with a better one (within 24 hours); this page updates automatically.",
		],
		tone: "wait",
	},
	active: {
		label: ["正常", "Active"],
		text: [
			"正常使用中。第一次使用请复制下面的命令在电脑上运行一次。",
			"Active. On first use, copy the command below and run it once on your computer.",
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

function useText() {
	const zh = getLocale() !== "en-US";
	return (pair: readonly [string, string]) => (zh ? pair[0] : pair[1]);
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
				["awaiting_ip", "provisioning", "needs_replace"].includes(
					query.state.data.status,
				))
				? 20_000
				: 120_000,
		retry: false,
	});
	const data = panel.data;
	if (!data) return null;
	return (
		<section
			className="grid gap-4 rounded-xl border p-4"
			aria-labelledby="claude-env-title"
		>
			<h2
				className="flex items-center gap-2 font-semibold text-lg"
				id="claude-env-title"
			>
				<ShieldCheck className="size-5" />
				{t(copy.title)}
			</h2>
			{data.state === "preparing" ? (
				<p className="text-muted-foreground text-sm leading-6">
					{t(copy.preparing)}
				</p>
			) : (
				<SubscriptionView data={data} orderNumber={orderNumber} />
			)}
		</section>
	);
}

type SubscriptionData = Extract<
	NonNullable<Awaited<ReturnType<typeof getClaudeEnvPanelFn>>>,
	{ state: "subscription" }
>;

function SubscriptionView({
	data,
	orderNumber,
}: {
	data: SubscriptionData;
	orderNumber: string;
}) {
	const t = useText();
	const status = statusCopy[data.status];
	const percent = Math.min(
		100,
		Math.round(
			(data.trafficUsedBytes / Math.max(1, data.trafficQuotaBytes)) * 100,
		),
	);
	return (
		<div className="grid gap-4">
			<div className="flex flex-wrap items-center gap-2">
				<Badge
					variant={
						status.tone === "ok"
							? "default"
							: status.tone === "wait"
								? "secondary"
								: "destructive"
					}
				>
					{t(status.label)}
				</Badge>
				<p className="text-sm leading-6">{t(status.text)}</p>
			</div>
			{data.expiringSoon && data.daysLeft !== null ? (
				<div
					className="grid gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm"
					role="alert"
				>
					<p className="font-semibold text-destructive">
						{(getLocale() === "en-US" ? copy.expiring[1] : copy.expiring[0])(
							data.daysLeft,
						)}
						{data.expiresAt ? ` · ${formatDateTime(data.expiresAt)}` : ""}
					</p>
					<p>{t(copy.renewKeep)}</p>
					<p className="font-semibold">{t(copy.renewWarning)}</p>
					<div>
						<Button asChild size="sm">
							<a href={data.renewUrl}>{t(copy.renew)}</a>
						</Button>
					</div>
				</div>
			) : null}
			<dl className="grid gap-3 text-sm sm:grid-cols-2">
				<Item label={t(copy.ip)} value={data.ip ?? "—"} mono />
				<Item label={t(copy.city)} value={data.city ?? "—"} />
				<Item label={t(copy.timezone)} value={data.timezone ?? "—"} mono />
				<Item label={t(copy.network)} value={t(copy.residential)} />
				<Item
					label={t(copy.expires)}
					value={data.expiresAt ? formatDateTime(data.expiresAt) : "—"}
				/>
				<Item
					label={t(copy.daysLeft)}
					value={
						data.daysLeft === null ? "—" : `${data.daysLeft} ${t(copy.days)}`
					}
				/>
				{data.lineOk !== null && data.lastCheckAt ? (
					<Item
						label={t(copy.line)}
						value={`${data.lineOk ? t(copy.lineOk) : t(copy.lineBad)} · ${formatDateTime(data.lastCheckAt)}`}
					/>
				) : null}
			</dl>
			<div className="grid gap-2">
				<div className="flex items-center justify-between text-sm">
					<span>{t(copy.traffic)}</span>
					<span className="tabular-nums">
						{formatBytes(data.trafficUsedBytes)} /{" "}
						{formatBytes(data.trafficQuotaBytes)}
					</span>
				</div>
				<div
					aria-valuemax={100}
					aria-valuemin={0}
					aria-valuenow={percent}
					className="h-2 overflow-hidden rounded-full bg-muted"
					role="progressbar"
				>
					<div className="h-full bg-primary" style={{ width: `${percent}%` }} />
				</div>
				{data.trafficResetAt ? (
					<p className="text-muted-foreground text-xs">
						{t(copy.trafficReset)}：{formatDateTime(data.trafficResetAt)}
					</p>
				) : null}
			</div>
			{data.codeAvailable ? (
				<CodeBlock orderNumber={orderNumber} />
			) : (
				<p className="text-muted-foreground text-sm">{t(copy.notReady)}</p>
			)}
			<p className="flex flex-wrap items-center gap-1 text-sm">
				<Globe className="size-4" />
				{t(copy.check)}
				<a
					className="underline"
					href={data.ipCheckUrl}
					rel="noreferrer"
					target="_blank"
				>
					{data.ipCheckUrl}
				</a>
			</p>
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
			<dd className={`break-all ${mono ? "font-mono" : ""}`}>{value}</dd>
		</div>
	);
}

function CodeBlock({ orderNumber }: { orderNumber: string }) {
	const t = useText();
	const [visible, setVisible] = useState(false);
	const reveal = useMutation({
		mutationFn: () => revealClaudeEnvCodeFn({ data: { orderNumber } }),
		onSuccess: () => setVisible(true),
		onError: () => toast.error(t(copy.revealFailed)),
	});
	const result = reveal.data;
	return (
		<div className="grid gap-3 rounded-lg bg-muted/40 p-3">
			<div className="flex flex-wrap items-center justify-between gap-2">
				<span className="font-medium text-sm">{t(copy.code)}</span>
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
					<CopyLine value={result.code} />
					<p className="text-muted-foreground text-xs">{t(copy.codeHint)}</p>
					<p className="text-sm">{t(copy.mac)}</p>
					<CopyLine value={result.mac} />
					<p className="text-sm">{t(copy.windows)}</p>
					<CopyLine value={result.windows} />
				</>
			) : (
				<p className="font-mono text-muted-foreground text-sm">
					CE1-••••••••••••••••
				</p>
			)}
		</div>
	);
}

function CopyLine({ value }: { value: string }) {
	const t = useText();
	return (
		<div className="flex items-start gap-2">
			<code className="min-w-0 flex-1 select-all break-all rounded bg-background p-2 font-mono text-xs">
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
