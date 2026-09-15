import {
	ArrowLeft,
	Globe,
	RefreshCw,
	ScanSearch,
	ShieldQuestion,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useRef, useState } from "react";
import { Button } from "#/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "#/components/ui/dialog";
import { m } from "#/paraglide/messages";
import { getLocale } from "#/paraglide/runtime";
import { publicIpSchema } from "./address";
import { type IpCheck, ipCheckSchema, maskIp, regionPolicyDate } from "./check";
import { LocalChecks } from "./local-checks";
import { checkerShareUrl, createShareImage } from "./share";
import { checkWebRtc } from "./webrtc";

export function IpCheckPage() {
	const [result, setResult] = useState<IpCheck | null>(null);
	const [busy, setBusy] = useState(true);
	const [failed, setFailed] = useState(false);
	const [visible, setVisible] = useState(false);
	const [timezone, setTimezone] = useState("—");
	const [attempt, setAttempt] = useState(0);
	const [query, setQuery] = useState("");
	const [queryError, setQueryError] = useState(false);
	const [target, setTarget] = useState("");
	const [ready, setReady] = useState(false);
	const [share, setShare] = useState<{ url: string; file: File } | null>(null);
	const [sharing, setSharing] = useState(false);
	const [shareMessage, setShareMessage] = useState("");
	const qr = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const ip = new URLSearchParams(location.search).get("ip");
		if (ip) {
			setQuery(ip);
			setTarget(ip);
		}
		setReady(true);
	}, []);
	useEffect(
		() => () => {
			if (share) URL.revokeObjectURL(share.url);
		},
		[share],
	);
	const [rtc, setRtc] = useState<string[] | "busy" | "error" | null>(null);
	const rtcAbort = useRef<AbortController | null>(null);
	useEffect(() => {
		setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || "—");
		return () => rtcAbort.current?.abort();
	}, []);
	useEffect(() => {
		void attempt;
		if (!ready) return;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 15000);
		let active = true;
		setBusy(true);
		setFailed(false);
		setResult(null);
		setVisible(false);
		rtcAbort.current?.abort();
		setRtc(null);
		setShareMessage("");
		fetch(`/api/ip-check${target ? `?ip=${encodeURIComponent(target)}` : ""}`, {
			cache: "no-store",
			signal: controller.signal,
		})
			.then(async (response) => {
				if (!response.ok && response.status !== 429)
					throw new Error("check_failed");
				return ipCheckSchema.parse(await response.json());
			})
			.then((data) => {
				if (active) setResult(data);
			})
			.catch(() => {
				if (active) setFailed(true);
			})
			.finally(() => {
				clearTimeout(timer);
				if (active) setBusy(false);
			});
		return () => {
			active = false;
			clearTimeout(timer);
			controller.abort();
		};
	}, [attempt, target, ready]);
	async function makeShare() {
		if (!result || result.score === null || !qr.current) return;
		setSharing(true);
		setShareMessage("");
		try {
			const svg = qr.current.querySelector("svg");
			if (!svg) throw new Error("qr_missing");
			const file = await createShareImage(
				result,
				new XMLSerializer().serializeToString(svg),
				{
					title: m.ip_score_title(),
					source:
						result.mode === "intelligence"
							? `${m.ip_score_full()} · ${result.source}`
							: m.ip_score_edge(),
					note: m.ip_score_note(),
					cta: m.ip_share_cta(),
				},
			);
			setShare({ file, url: URL.createObjectURL(file) });
		} catch {
			setShareMessage(m.ip_share_error());
		} finally {
			setSharing(false);
		}
	}
	async function copyLink() {
		try {
			await navigator.clipboard.writeText(checkerShareUrl);
			setShareMessage(m.ip_share_done());
		} catch {
			setShareMessage(m.ip_share_error());
		}
	}
	async function nativeShare() {
		if (!share) return;
		try {
			if (navigator.canShare?.({ files: [share.file] }))
				await navigator.share({ files: [share.file], title: m.ip_title() });
			else if (navigator.share)
				await navigator.share({ title: m.ip_title(), url: checkerShareUrl });
			else setShareMessage(m.ip_share_error());
		} catch {
			setShareMessage(m.ip_share_error());
		}
	}

	async function probe() {
		rtcAbort.current?.abort();
		const controller = new AbortController();
		rtcAbort.current = controller;
		setRtc("busy");
		try {
			const ips = await checkWebRtc(controller.signal);
			if (!controller.signal.aborted) setRtc(ips);
		} catch {
			if (!controller.signal.aborted) setRtc("error");
		}
	}
	const titles = {
		incomplete: m.ip_incomplete,
		region: m.ip_region_status,
		hosting: m.ip_hosting_status,
		limited: m.ip_limited,
		clear: m.ip_clear_status,
		risk: m.ip_risk_status,
	};
	const bodies = {
		incomplete: m.ip_incomplete_body,
		region: m.ip_region_body,
		hosting: m.ip_hosting_body,
		limited: m.ip_limited_body,
		clear: m.ip_clear_body,
		risk: m.ip_risk_body,
	};
	const regionLabels = {
		listed: m.ip_listed,
		unlisted: m.ip_unlisted,
		review: m.ip_review,
		unknown: m.ip_unknown,
	};
	const timezoneMismatch = Boolean(
		result?.networkTimezone && result.networkTimezone !== timezone,
	);
	const rows = result
		? [
				[m.ip_country(), result.country],
				[m.ip_city(), result.city],
				[m.ip_edge_country(), result.edgeCountry],
				[m.ip_network_timezone(), result.networkTimezone],
				[
					m.ip_time(),
					result.checkedAt
						? new Date(result.checkedAt).toLocaleString(getLocale())
						: null,
				],
				[
					m.ip_org(),
					[result.asn ? `AS${result.asn}` : null, result.organization]
						.filter(Boolean)
						.join(" · "),
				],
				[m.ip_edge(), result.colo],
				[m.ip_asn_abuse(), m.ip_unknown()],
				[m.ip_region_label(), regionLabels[result.region]()],
				[
					m.ip_risk(),
					result.risk === null ? m.ip_unknown() : `${result.risk}/100`,
				],
				[
					m.ip_provider_risk(),
					result.providerRisk === null
						? m.ip_unknown()
						: `${result.providerRisk}/100`,
				],
				...(
					[
						["datacenter", m.ip_flag_datacenter()],
						["chinaCloud", m.ip_flag_china()],
						["vpn", "VPN"],
						["proxy", "Proxy"],
						["residentialProxy", m.ip_flag_residential()],
						["tor", "Tor"],
						["mobile", m.ip_flag_mobile()],
						["anycast", m.ip_flag_anycast()],
					] as const
				).map(([key, label]) => [
					label,
					result.flags[key] === null
						? m.ip_unknown()
						: result.flags[key]
							? m.ip_flag_yes()
							: m.ip_flag_no(),
				]),
			]
		: [];
	return (
		<div className="mx-auto max-w-5xl space-y-8 px-4 py-10 sm:px-6 sm:py-16">
			<header className="max-w-3xl space-y-4">
				<p className="flex items-center gap-2 font-medium text-primary text-sm">
					<ScanSearch className="size-4" aria-hidden="true" />
					{m.ip_eyebrow()}
				</p>
				<h1 className="font-bold text-3xl tracking-tight sm:text-5xl">
					{m.ip_title()}
				</h1>
				<p className="text-muted-foreground leading-7">{m.ip_intro()}</p>
			</header>
			<form
				className="space-y-3 rounded-2xl border p-5"
				onSubmit={(event) => {
					event.preventDefault();
					if (query.trim() && !publicIpSchema.safeParse(query.trim()).success) {
						setQueryError(true);
						return;
					}
					setQueryError(false);
					setTarget(query.trim());
					setAttempt((n) => n + 1);
				}}
			>
				<label className="block font-medium text-sm" htmlFor="query-ip">
					{m.ip_query_label()}
				</label>
				<div className="flex flex-wrap gap-2">
					<input
						id="query-ip"
						aria-invalid={queryError}
						aria-describedby={queryError ? "query-error" : undefined}
						value={query}
						onChange={(event) => setQuery(event.target.value)}
						maxLength={45}
						placeholder={m.ip_query_placeholder()}
						className="min-w-0 flex-1 rounded-lg border bg-background px-3 py-2 text-sm"
					/>
					<Button disabled={busy} type="submit">
						{m.ip_query_button()}
					</Button>
					<Button
						disabled={busy}
						variant="outline"
						type="button"
						onClick={() => {
							setQuery("");
							setQueryError(false);
							setTarget("");
							setAttempt((n) => n + 1);
						}}
					>
						{m.ip_query_current()}
					</Button>
				</div>
				{queryError && (
					<p id="query-error" role="alert" className="text-destructive text-sm">
						{m.ip_query_invalid()}
					</p>
				)}
				<p className="text-muted-foreground text-xs leading-5">
					{m.ip_query_notice()}
				</p>
			</form>
			<div className="grid items-start gap-6 lg:grid-cols-[1.35fr_1fr]">
				<section
					className="space-y-5 rounded-2xl border bg-card p-5 sm:p-7"
					aria-busy={busy}
				>
					<div className="flex flex-wrap items-center justify-between gap-3">
						<Globe className="size-6 text-primary" aria-hidden="true" />
						<Button
							variant="outline"
							disabled={busy}
							onClick={() => setAttempt((n) => n + 1)}
						>
							<RefreshCw className="size-4" aria-hidden="true" />
							{m.ip_refresh()}
						</Button>
					</div>
					<p className="break-all font-mono font-semibold text-2xl sm:text-3xl">
						{visible && result?.ip ? result.ip : maskIp(result?.ip ?? null)}
					</p>
					{result?.ip && (
						<button
							type="button"
							className="rounded text-primary text-sm underline underline-offset-4 focus-visible:outline-2"
							aria-pressed={visible}
							onClick={() => setVisible((v) => !v)}
						>
							{visible ? m.ip_hide() : m.ip_show()}
						</button>
					)}
					<p className="text-muted-foreground text-xs">{m.ip_mask_note()}</p>
					{target && (
						<p className="font-medium text-sm">{m.ip_query_other()}</p>
					)}
					{result && !busy && !failed && result.score !== null && (
						<div className="space-y-3 rounded-xl border bg-primary/5 p-5">
							<p className="font-semibold">{m.ip_score_title()}</p>
							<p className="font-bold text-6xl text-primary">
								{result.score}
								<span className="text-muted-foreground text-xl"> /100</span>
							</p>
							<progress
								className="h-2 w-full accent-primary"
								max={100}
								value={result.score}
								aria-label={m.ip_score_title()}
							/>
							<p className="font-semibold text-sm">
								{result.score >= 90
									? m.ip_grade_good()
									: result.score >= 50
										? m.ip_grade_caution()
										: m.ip_grade_risk()}
							</p>
							<p className="text-muted-foreground text-xs">
								{result.mode === "intelligence"
									? `${m.ip_score_full()} · ${result.source}`
									: m.ip_score_edge()}
							</p>
							<p className="text-muted-foreground text-xs leading-5">
								{m.ip_score_note()}
							</p>
							<p className="text-muted-foreground text-xs">
								{result.ranking && result.ranking.total >= 20
									? m.ip_rank({
											percent: result.ranking.percentile,
											count: result.ranking.total,
										})
									: m.ip_rank_wait({ count: result.ranking?.total ?? 0 })}
							</p>
						</div>
					)}
					{result?.warning && (
						<output className="block rounded-lg bg-amber-500/10 p-3 text-sm">
							{m.ip_provider_warning()}
						</output>
					)}
					<div className="flex flex-wrap gap-2">
						<Button
							disabled={!result || result.score === null || busy || sharing}
							onClick={makeShare}
						>
							{sharing ? m.ip_share_busy() : m.ip_share()}
						</Button>
						<Button variant="outline" onClick={copyLink}>
							{m.ip_share_copy()}
						</Button>
					</div>
					<output className="block text-sm">{shareMessage}</output>
					<a
						href="/guides/claude-network-check"
						className="block text-primary text-sm underline"
					>
						{m.ip_read_guide()} →
					</a>

					<div
						aria-live="polite"
						className={`rounded-xl border p-4 ${result?.status === "risk" || result?.status === "region" ? "border-destructive/30 bg-destructive/5" : result?.status === "clear" ? "border-primary/30 bg-primary/5" : "border-amber-500/25 bg-amber-500/5"}`}
					>
						{busy ? (
							<p>{m.ip_loading()}</p>
						) : failed ? (
							<p role="alert">{m.ip_error()}</p>
						) : (
							result && (
								<>
									<h2 className="flex items-start gap-2 font-semibold">
										<ShieldQuestion
											className="size-5 shrink-0"
											aria-hidden="true"
										/>
										{titles[result.status]()}
									</h2>
									<p className="mt-3 text-sm leading-6">
										{bodies[result.status]()}
									</p>
								</>
							)
						)}
					</div>
					<h2 className="font-semibold">{m.ip_next_title()}</h2>
					<p className="text-muted-foreground text-sm leading-6">
						{m.ip_next_body()}
					</p>
					<a
						href="https://www.anthropic.com/supported-countries"
						target="_blank"
						rel="noopener noreferrer"
						className="inline-block rounded text-primary text-sm underline underline-offset-4"
					>
						{m.ip_policy()} ↗
					</a>
				</section>
				<section className="rounded-2xl border bg-card p-5 sm:p-7">
					<h2 className="mb-4 font-semibold">{m.ip_facts()}</h2>
					{result ? (
						<dl className="divide-y">
							{rows.map(([label, value]) => (
								<div key={label} className="space-y-1 py-3">
									<dt className="text-muted-foreground text-xs">{label}</dt>
									<dd className="break-words text-sm">
										{value || m.ip_unknown()}
									</dd>
								</div>
							))}
						</dl>
					) : (
						<p className="text-muted-foreground text-sm">
							{busy ? m.ip_loading() : m.ip_error()}
						</p>
					)}
					<p className="mt-4 text-muted-foreground text-xs leading-5">
						{m.ip_source()}
					</p>
					<p className="mt-3 text-muted-foreground text-xs">
						{m.ip_policy_date({ date: regionPolicyDate })}
					</p>
				</section>
			</div>
			<section className="space-y-5 rounded-2xl border p-5 sm:p-7">
				<h2 className="font-semibold text-xl">{m.ip_browser()}</h2>
				<p className="text-muted-foreground text-sm">{m.ip_browser_scope()}</p>
				<div className="grid gap-6 sm:grid-cols-2">
					<div className="space-y-3">
						<h3 className="font-medium">{m.ip_timezone()}</h3>
						<p className="break-all font-mono text-sm">{timezone}</p>
						<p className="text-sm">
							{timezoneMismatch
								? m.ip_timezone_mismatch()
								: m.ip_timezone_no_conflict()}
						</p>
						<p className="text-muted-foreground text-sm leading-6">
							{m.ip_timezone_note()}
						</p>
					</div>
					<div className="space-y-3">
						<h3 className="font-medium">{m.ip_webrtc()}</h3>
						<p className="text-muted-foreground text-sm leading-6">
							{m.ip_webrtc_note()}
						</p>
						<Button
							className="h-auto whitespace-normal text-left"
							variant="outline"
							disabled={rtc === "busy"}
							onClick={probe}
						>
							{rtc === "busy" ? m.ip_loading() : m.ip_webrtc_start()}
						</Button>
						<div aria-live="polite" className="text-sm leading-6">
							{rtc === "error" ? (
								m.ip_webrtc_unavailable()
							) : Array.isArray(rtc) ? (
								rtc.length ? (
									<>
										<p>{m.ip_webrtc_found()}</p>
										{rtc.map((ip) => (
											<p className="break-all font-mono" key={ip}>
												{visible ? ip : maskIp(ip)}
											</p>
										))}
									</>
								) : (
									m.ip_webrtc_empty()
								)
							) : null}
						</div>
					</div>
				</div>
			</section>
			<section className="space-y-3 rounded-2xl border p-5">
				<h2 className="font-semibold">{m.ip_coverage_title()}</h2>
				<p className="text-muted-foreground text-sm leading-7">
					{m.ip_coverage_body()}
				</p>
				<p className="text-muted-foreground text-sm leading-7">
					{m.ip_anycast_note()}
				</p>
			</section>
			<section id="guide" className="space-y-6">
				<h2 className="font-semibold text-2xl">{m.ip_guide()}</h2>
				{(
					[
						[m.ip_g1_title, m.ip_g1_body],
						[m.ip_g2_title, m.ip_g2_body],
						[m.ip_g3_title, m.ip_g3_body],
						[m.ip_g4_title, m.ip_g4_body],
						[m.ip_g5_title, m.ip_g5_body],
					] as const
				).map(([title, body], index) => (
					<article key={title()} className="space-y-3 border-t pt-6">
						<h3 className="font-semibold text-lg">{title()}</h3>
						<p className="max-w-3xl text-muted-foreground text-sm leading-7">
							{body()}
						</p>
						{index === 3 && <LocalChecks />}
					</article>
				))}
			</section>
			<div ref={qr} className="hidden" aria-hidden="true">
				<QRCodeSVG value={checkerShareUrl} size={230} marginSize={4} />
			</div>
			<Dialog
				open={Boolean(share)}
				onOpenChange={(open) => {
					if (!open) setShare(null);
				}}
			>
				<DialogContent className="max-h-[90dvh] overflow-y-auto">
					<DialogHeader>
						<DialogTitle>{m.ip_share_title()}</DialogTitle>
						<DialogDescription>{m.ip_share_description()}</DialogDescription>
					</DialogHeader>
					{share && (
						<>
							<img
								src={share.url}
								alt={m.ip_share_title()}
								className="mx-auto max-h-[55vh] w-auto rounded-xl"
							/>
							<div className="flex flex-wrap gap-3">
								<a
									href={share.url}
									download="laoshirenvip-ip-check.png"
									className="rounded-lg bg-primary px-4 py-2 text-primary-foreground text-sm"
								>
									{m.ip_share_download()}
								</a>
								<Button variant="outline" onClick={nativeShare}>
									{m.ip_share_native()}
								</Button>
							</div>
							<output>{shareMessage}</output>
						</>
					)}
				</DialogContent>
			</Dialog>
			<footer className="space-y-5 border-t pt-6">
				<a
					href="/products/ba540b83-388d-45d1-9dcb-25c3da3f9956#claude-purchase-guide"
					className="inline-flex items-center gap-2 text-primary text-sm underline underline-offset-4"
				>
					<ArrowLeft className="size-4" aria-hidden="true" />
					{m.ip_return()}
				</a>
				<p className="text-muted-foreground text-xs">{m.ip_footnote()}</p>
			</footer>
		</div>
	);
}
