import {
	ArrowLeft,
	Globe,
	RefreshCw,
	ScanSearch,
	ShieldQuestion,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "#/components/ui/button";
import { m } from "#/paraglide/messages";
import { type IpCheck, ipCheckSchema, maskIp, regionPolicyDate } from "./check";
import { checkWebRtc } from "./webrtc";

export function IpCheckPage() {
	const [result, setResult] = useState<IpCheck | null>(null);
	const [busy, setBusy] = useState(true);
	const [failed, setFailed] = useState(false);
	const [visible, setVisible] = useState(false);
	const [timezone, setTimezone] = useState("—");
	const [attempt, setAttempt] = useState(0);
	const [rtc, setRtc] = useState<string[] | "busy" | "error" | null>(null);
	const rtcAbort = useRef<AbortController | null>(null);
	useEffect(() => {
		setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || "—");
		return () => rtcAbort.current?.abort();
	}, []);
	useEffect(() => {
		void attempt;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 10000);
		let active = true;
		setBusy(true);
		setFailed(false);
		setResult(null);
		setVisible(false);
		fetch("/api/ip-check", { cache: "no-store", signal: controller.signal })
			.then(async (response) => {
				if (!response.ok) throw new Error("check_failed");
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
	}, [attempt]);
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
	};
	const bodies = {
		incomplete: m.ip_incomplete_body,
		region: m.ip_region_body,
		hosting: m.ip_hosting_body,
		limited: m.ip_limited_body,
	};
	const regionLabels = {
		listed: m.ip_listed,
		unlisted: m.ip_unlisted,
		review: m.ip_review,
		unknown: m.ip_unknown,
	};
	const rows = result
		? [
				[m.ip_country(), result.country],
				[m.ip_city(), result.city],
				[
					m.ip_org(),
					[result.asn ? `AS${result.asn}` : null, result.organization]
						.filter(Boolean)
						.join(" · "),
				],
				[m.ip_edge(), result.colo],
				[m.ip_region_label(), regionLabels[result.region]()],
				[
					m.ip_hosting_label(),
					result.hosting === "suspected" ? m.ip_suspected() : m.ip_unknown(),
				],
				[m.ip_threats(), m.ip_unknown()],
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
					<div
						aria-live="polite"
						className="rounded-xl border border-amber-500/25 bg-amber-500/5 p-4"
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
				<div className="grid gap-6 sm:grid-cols-2">
					<div className="space-y-3">
						<h3 className="font-medium">{m.ip_timezone()}</h3>
						<p className="break-all font-mono text-sm">{timezone}</p>
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
						{index === 3 && (
							<pre className="overflow-x-auto rounded-xl bg-muted p-4 text-xs leading-6">
								<code>{`# macOS / Linux · read-only · presence only\nnode -e 'for (const k of ["HTTP_PROXY","HTTPS_PROXY","ALL_PROXY","http_proxy","https_proxy","all_proxy","ANTHROPIC_BASE_URL"]) console.log(k+": "+(process.env[k]?"SET":"NOT SET"))'\n\n# Browser-independent timezone\nnode -e 'console.log(Intl.DateTimeFormat().resolvedOptions().timeZone)'`}</code>
							</pre>
						)}
					</article>
				))}
			</section>
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
