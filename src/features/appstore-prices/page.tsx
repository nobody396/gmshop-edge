import { queryOptions, useQuery } from "@tanstack/react-query";
import {
	type AppStoreCurrency,
	appStorePriceApps,
	appStoreRegions,
} from "./config";
import { getAppStorePricesFn } from "./server/functions";
import type { AppStorePriceCell, AppStorePriceSnapshot } from "./snapshot";

const appleIdProductPath = "/products/c70d10e8-b781-4782-bc98-1f034bcd069a";
const beijingOffsetMs = 8 * 3_600_000;

export function appStorePricesQueryOptions() {
	return queryOptions({
		queryKey: ["storefront", "appstore-prices"],
		queryFn: () => getAppStorePricesFn(),
		staleTime: 300_000,
	});
}

const currencyNames: Record<AppStoreCurrency, { unit: number; name: string }> =
	{
		USD: { unit: 1, name: "美元" },
		JPY: { unit: 100, name: "日元" },
		PHP: { unit: 1, name: "菲律宾比索" },
		TRY: { unit: 1, name: "土耳其里拉" },
	};

const currencySymbols: Record<AppStoreCurrency, string> = {
	USD: "$",
	JPY: "JP¥",
	PHP: "₱",
	TRY: "₺",
};

function beijingDateTime(ms: number) {
	return new Date(ms + beijingOffsetMs)
		.toISOString()
		.slice(0, 16)
		.replace("T", " ");
}

function beijingDay(ms: number) {
	return new Date(ms + beijingOffsetMs).toISOString().slice(0, 10);
}

function formatLocal(cell: AppStorePriceCell) {
	const value = Number(cell.amount);
	const hasFraction = !Number.isInteger(value);
	return `${currencySymbols[cell.currency]}${value.toLocaleString("en-US", {
		minimumFractionDigits: hasFraction ? 2 : 0,
		maximumFractionDigits: 2,
	})}`;
}

function formatRate(value: number, unit: number) {
	const total = value * unit;
	return total >= 1 ? total.toFixed(2) : total.toFixed(4);
}

function PriceTable({
	snapshot,
	appIndex,
}: {
	snapshot: AppStorePriceSnapshot;
	appIndex: number;
}) {
	const app = appStorePriceApps[appIndex];
	if (!app) return null;
	const stored = snapshot.apps.find((entry) => entry.id === app.id);
	const today = beijingDay(snapshot.updatedAt);
	const rows = app.tiers.flatMap((tier) => {
		const cells = stored?.tiers.find((entry) => entry.id === tier.id)?.cells;
		if (!cells || appStoreRegions.every((region) => !cells[region.id]))
			return [];
		const prices = appStoreRegions.flatMap((region) => {
			const cell = cells[region.id];
			return cell ? [cell.cny] : [];
		});
		return [{ tier, cells, cheapest: Math.min(...prices) }];
	});
	return (
		<section
			id={app.id}
			className="scroll-mt-24 space-y-3 border-t pt-8"
			aria-labelledby={`${app.id}-title`}
		>
			<h2 id={`${app.id}-title`} className="font-semibold text-xl">
				{app.title}
			</h2>
			{rows.length === 0 ? (
				<p className="text-muted-foreground text-sm">暂时没有数据。</p>
			) : (
				<div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
					<table className="w-full min-w-[340px] border-collapse text-sm">
						<thead>
							<tr className="border-b text-muted-foreground text-xs">
								<th scope="col" className="py-2 pr-2 text-left font-medium">
									档位
								</th>
								{appStoreRegions.map((region) => (
									<th
										key={region.id}
										scope="col"
										className="px-1 py-2 text-right font-medium"
									>
										{region.label}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{rows.map(({ tier, cells, cheapest }) => (
								<tr key={tier.id} className="border-b last:border-b-0">
									<th scope="row" className="py-2.5 pr-2 text-left align-top">
										<span className="block font-semibold leading-5">
											{tier.label}
										</span>
										<span
											className={`mt-0.5 inline-block rounded px-1.5 text-[11px] leading-5 ${tier.period === "year" ? "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-100" : "bg-muted text-muted-foreground"}`}
										>
											{tier.period === "year" ? "年付" : "月付"}
										</span>
										{tier.hint ? (
											<span className="block font-normal text-[11px] text-muted-foreground leading-4">
												{tier.hint}
											</span>
										) : null}
									</th>
									{appStoreRegions.map((region) => {
										const cell = cells[region.id];
										if (!cell)
											return (
												<td
													key={region.id}
													className="px-1 py-2.5 text-right align-top text-muted-foreground"
												>
													—
												</td>
											);
										const best = cell.cny === cheapest;
										const day = beijingDay(cell.fetchedAt);
										return (
											<td
												key={region.id}
												className={`px-1 py-2.5 text-right align-top ${best ? "bg-emerald-50 dark:bg-emerald-950/60" : ""}`}
											>
												<span
													className={`block font-semibold tabular-nums leading-5 ${best ? "text-emerald-700 dark:text-emerald-300" : ""}`}
												>
													¥{cell.cny.toLocaleString("en-US")}
													{cell.source === "opentherank" ? (
														<sup className="ml-0.5 text-amber-600">*</sup>
													) : null}
												</span>
												<span className="block text-[11px] text-muted-foreground tabular-nums leading-4">
													{formatLocal(cell)}
												</span>
												{day !== today ? (
													<span className="block text-[10px] text-muted-foreground leading-4">
														{day.slice(5)} 数据
													</span>
												) : null}
												{best ? (
													<span className="sr-only">（最便宜）</span>
												) : null}
											</td>
										);
									})}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
		</section>
	);
}

export function AppStorePricesPage() {
	const { data: snapshot } = useQuery(appStorePricesQueryOptions());
	return (
		<article className="mx-auto max-w-3xl space-y-8 px-4 py-12 sm:px-5 sm:py-16">
			<header className="space-y-4">
				<h1 className="font-bold text-3xl leading-tight sm:text-4xl">
					各区 App Store 开会员价格对比
				</h1>
				<p className="text-muted-foreground leading-7">
					同一个会员，在不同地区的 App Store 里价格差很多。下面把
					ChatGPT、Claude、Google AI（Gemini）在美区、日区、菲区、土区的 App
					内订阅价换算成人民币，每行最便宜的格子标绿。
				</p>
				{snapshot ? (
					<div className="space-y-1 rounded-xl bg-muted/50 p-4 text-sm leading-6">
						<p>
							<span className="text-muted-foreground">
								数据日期（北京时间）：
							</span>
							{beijingDateTime(snapshot.updatedAt)}
						</p>
						<p>
							<span className="text-muted-foreground">汇率日期：</span>
							{snapshot.rates.date}（欧洲央行参考价）
						</p>
						<p className="text-muted-foreground">
							{appStoreRegions
								.map((region) => {
									const { unit, name } = currencyNames[region.currency];
									const rate = snapshot.rates.cnyPer[region.currency];
									return `${unit} ${name} ≈ ${formatRate(rate, unit)} 元`;
								})
								.join("；")}
						</p>
					</div>
				) : null}
				<nav className="flex flex-wrap gap-x-4 gap-y-1 text-sm underline underline-offset-4">
					{appStorePriceApps.map((app) => (
						<a key={app.id} href={`#${app.id}`}>
							{app.title}
						</a>
					))}
				</nav>
			</header>

			{snapshot ? (
				appStorePriceApps.map((app, index) => (
					<PriceTable key={app.id} snapshot={snapshot} appIndex={index} />
				))
			) : (
				<p className="rounded-xl bg-muted/50 p-4 text-muted-foreground text-sm">
					价格数据正在准备，请稍后再来看。
				</p>
			)}

			<footer className="space-y-3 border-t pt-8 text-muted-foreground text-sm leading-7">
				<p className="font-medium text-foreground">
					含当地税；实际以 App Store 结账页为准；通过 Apple ID 在 App 内订阅。
				</p>
				<p>
					来源：各地区苹果 App Store 官网上这个 App 的「App
					内购买项目」列表（apps.apple.com），每天北京时间早上自动更新；人民币按当天汇率换算后取整，小字是当地原价。
				</p>
				<p>
					<sup className="text-amber-600">*</sup>{" "}
					该区苹果页面没有列出这个档位，价格取自 OpenTheRank 公开整理的各区 App
					Store
					价格。「—」表示两处都没有这个档位（未上架或没有公开价格）。格子里写「MM-DD
					数据」表示当天没抓到，显示的是那天的价格。
				</p>
				<p>
					想在这些地区开会员，需要对应地区的 Apple ID：
					<a
						className="text-foreground underline underline-offset-4"
						href={appleIdProductPath}
					>
						购买 Apple ID
					</a>
					，登录方法见
					<a
						className="text-foreground underline underline-offset-4"
						href="/guides/apple-id-login"
					>
						Apple ID 登录教程
					</a>
					。
				</p>
			</footer>
		</article>
	);
}
