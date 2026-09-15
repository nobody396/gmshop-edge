// Port of leeguooooo/claude-code-usage-bar ip_score.py (MIT).
// Pinned source a36a0b51c464b31c1b9b6189c29857e06ef63795; see LICENSE.upstream.
export type Signals = {
	datacenter: boolean | null;
	vpn: boolean | null;
	proxy: boolean | null;
	tor: boolean | null;
	org?: string | null;
	asn?: number | null;
	abuser?: number | null;
};
const chinaNames = [
	"alibaba",
	"aliyun",
	"alicloud",
	"taobao",
	"alipay",
	"cainiao",
	"ant group",
	"antgroup",
	"tencent",
	"qcloud",
	"huawei",
	"bytedance",
	"volcengine",
	"volces",
	"ucloud",
	"kingsoft",
	"ksyun",
	"baidu",
];
const chinaAsns = new Set([
	45102, 37963, 134963, 134964, 24429, 45104, 45090, 132203, 132591, 55990,
	136907, 38365, 55967, 396986, 138421, 135377,
]);
export function abusePoints(value: number | null | undefined) {
	if (!value || value <= 0) return 0;
	return value > 0.2
		? 40
		: value > 0.03
			? 30
			: value > 0.0085
				? 20
				: value > 0.0005
					? 10
					: 0;
}
export function scoreIp(signals: Signals, country: string | null) {
	const chinaCloud =
		chinaNames.some((name) =>
			(signals.org ?? "").toLowerCase().includes(name),
		) ||
		chinaAsns.has(signals.asn ?? 0) ||
		(Boolean(signals.datacenter) && /[,\s]cn\s*$/i.test(signals.org ?? ""));
	const datacenter = Boolean(signals.datacenter) || chinaCloud;
	const residentialProxy =
		Boolean(signals.proxy) && !datacenter && !signals.vpn;
	let risk = 0,
		type = "residential";
	if (signals.tor) {
		risk += 75;
		type = "tor";
	}
	if (datacenter) {
		risk += 33;
		if (type === "residential") type = "hosting";
	}
	if (chinaCloud) risk += 25;
	if (signals.vpn) {
		risk += 50;
		type =
			type === "hosting"
				? "vpn/hosting"
				: type === "residential"
					? "vpn"
					: type;
	}
	if (residentialProxy) {
		risk += 100;
		type = "residential-proxy";
	} else if (signals.proxy && !signals.vpn) risk += 50;
	risk = Math.min(100, Math.max(0, risk + abusePoints(signals.abuser)));
	let score = 100 - risk;
	if (["vpn", "proxy", "residential-proxy", "tor"].includes(type))
		score = Math.min(score, 40);
	else if (type === "hosting") score = Math.min(score, 60);
	if (["KP", "IR", "CU", "SY", "RU", "BY"].includes(country ?? ""))
		score = Math.min(score, 5);
	else if (["CN", "HK"].includes(country ?? "")) score = Math.min(score, 40);
	return { risk, score, type, chinaCloud, residentialProxy };
}
