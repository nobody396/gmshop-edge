import { z } from "zod";

export const regionPolicyDate = "2026-09-15";
// Claude.ai list, not API list: https://www.anthropic.com/supported-countries
const supportedCountries = new Set(
	"AL DZ AD AO AG AR AM AU AT AZ BS BH BD BB BE BZ BJ BT BO BA BW BR BN BG BF BI CV KH CM CA CF TD CL CO KM CG CR CI HR CY CZ DK DJ DM DO EC EG SV GQ ER EE SZ ET FJ FI FR GA GM GE DE GH GR GD GT GN GW GY HT HN HU IS IN ID IQ IE IL IT JM JP JO KZ KE KI KW KG LA LV LB LS LR LY LI LT LU MG MW MY MV ML MT MH MR MU MX FM MD MC MN ME MA MZ NA NR NP NL NZ NI NE NG MK NO OM PK PW PS PA PG PY PE PH PL PT QA RO RW KN LC VC WS SM ST SA SN RS SC SL SG SK SI SO SB ZA KR SS ES LK SD SR SE CH TW TJ TZ TH TL TG TO TT TN TR TM TV UG UA AE GB US UY UZ VU VA VN ZM ZW".split(
		" ",
	),
);
// Small, explicit heuristic, NOT a VPN database. Unmatched ASNs stay unknown.
const hostingAsns = new Set([
	16509, 14618, 15169, 8075, 14061, 63949, 20473, 16276, 24940, 45102, 132203,
]);
const hostingName =
	/\b(amazon|aws|google cloud|microsoft|digitalocean|ovh|hetzner|vultr|linode|alibaba|tencent|hosting|datacenter|data center)\b/i;
const edgeSchema = z.object({
	country: z
		.string()
		.regex(/^[A-Z]{2}$/)
		.optional()
		.catch(undefined),
	city: z.string().max(120).optional().catch(undefined),
	regionCode: z.string().max(10).optional().catch(undefined),
	asn: z.number().int().positive().optional().catch(undefined),
	asOrganization: z.string().max(200).optional().catch(undefined),
	colo: z.string().max(10).optional().catch(undefined),
});
export const ipCheckSchema = z.object({
	ip: z.union([z.ipv4(), z.ipv6()]).nullable(),
	country: z.string().nullable(),
	city: z.string().nullable(),
	asn: z.number().int().positive().nullable(),
	organization: z.string().nullable(),
	colo: z.string().nullable(),
	region: z.enum(["listed", "unlisted", "review", "unknown"]),
	hosting: z.enum(["suspected", "unknown"]),
	status: z.enum(["incomplete", "region", "hosting", "limited"]),
});
export type IpCheck = z.infer<typeof ipCheckSchema>;

export function checkIp(
	request: Request,
	runtime: "cloudflare" | "bun",
): IpCheck {
	// Never trust forwarding headers on Bun or invent an IP in local preview.
	const hostname = new URL(request.url).hostname;
	const local =
		hostname === "localhost" ||
		hostname.endsWith(".localhost") ||
		hostname === "[::1]" ||
		hostname.startsWith("127.");
	const parsed = edgeSchema.safeParse(
		runtime === "cloudflare" && !local ? request.cf : undefined,
	);
	const cf = parsed.success ? parsed.data : undefined;
	const rawIp = cf ? request.headers.get("cf-connecting-ip") : null;
	const ip = z.union([z.ipv4(), z.ipv6()]).safeParse(rawIp);
	const country = cf?.country ?? null;
	const region =
		!country || ["XX", "T1"].includes(country)
			? "unknown"
			: country === "UA"
				? "review" // Country-level data cannot resolve territorial restrictions.
				: supportedCountries.has(country)
					? "listed"
					: "unlisted";
	const hosting =
		(cf?.asn && hostingAsns.has(cf.asn)) ||
		hostingName.test(cf?.asOrganization ?? "")
			? "suspected"
			: "unknown";
	return {
		ip: ip.success ? ip.data : null,
		country,
		city: cf?.city ?? null,
		asn: cf?.asn ?? null,
		organization: cf?.asOrganization ?? null,
		colo: cf?.colo ?? null,
		region,
		hosting,
		status:
			region === "unlisted" || region === "review"
				? "region"
				: !ip.success || region === "unknown" || !cf?.asn || !cf?.asOrganization
					? "incomplete"
					: hosting === "suspected"
						? "hosting"
						: "limited",
	};
}

export function handleIpCheck(request: Request, runtime: "cloudflare" | "bun") {
	const url = new URL(request.url);
	if (url.pathname !== "/api/ip-check") return null;
	const headers = {
		"cache-control": "private, no-store",
		"cdn-cache-control": "no-store",
		"referrer-policy": "no-referrer",
	};
	if (request.method !== "GET")
		return Response.json(
			{ error: "method_not_allowed" },
			{ status: 405, headers: { ...headers, allow: "GET" } },
		);
	if (url.search)
		return Response.json(
			{ error: "current_connection_only" },
			{ status: 400, headers },
		);
	return Response.json(checkIp(request, runtime), { headers });
}

export function maskIp(ip: string | null) {
	if (!ip) return "—";
	return ip.includes(":")
		? `${ip.split(":")[0]}:••••:••••`
		: `${ip.split(".")[0]}.•••.•••.${ip.split(".")[3]}`;
}
