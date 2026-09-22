import { z } from "zod";
import { loadRequestSettings } from "#/server/request-settings";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

type AuthoritySettings = {
	allowedHosts: string[];
	blockedIps: string[];
};

const requestSettings = new WeakMap<Request, Promise<AuthoritySettings>>();

export async function validateRequestAuthority(
	request: Request,
	db: D1Database | undefined,
): Promise<Response | null> {
	if (!db) return authorityUnavailable();
	let settings: AuthoritySettings;
	try {
		settings = await loadAuthoritySettings(request, db);
	} catch {
		console.error(JSON.stringify({ event: "request_authority_unavailable" }));
		return authorityUnavailable();
	}
	if (
		settings.blockedIps.includes(
			request.headers.get("cf-connecting-ip")?.toLowerCase() ?? "",
		)
	)
		return new Response("Forbidden", { status: 403 });
	const url = new URL(request.url);
	if (
		settings.allowedHosts.length > 0 &&
		!settings.allowedHosts.includes(url.host.toLowerCase())
	)
		return new Response("Misdirected Request", { status: 421 });

	const origin = request.headers.get("origin");
	const originHost = origin ? parseOriginHost(origin) : null;
	if (
		origin &&
		!SAFE_METHODS.has(request.method) &&
		(originHost === null ||
			(originHost !== url.host.toLowerCase() &&
				!settings.allowedHosts.includes(originHost)))
	)
		return new Response("Forbidden Origin", { status: 403 });
	return null;
}

function authorityUnavailable() {
	return new Response("Service Unavailable", { status: 503 });
}

export async function loadRequestAllowedHosts(
	request: Request,
	db: D1Database,
) {
	return (await loadAuthoritySettings(request, db)).allowedHosts;
}

function parseOriginHost(origin: string): string | null {
	try {
		const url = new URL(origin);
		return url.origin === origin ? url.host.toLowerCase() : null;
	} catch {
		return null;
	}
}

async function loadAuthoritySettings(
	request: Request,
	db: D1Database,
): Promise<AuthoritySettings> {
	const cached = requestSettings.get(request);
	if (cached) return cached;
	const pending = loadRequestSettings(request, db).then((values) => ({
		blockedIps: parseBlockedIps(values.get("security.blocked_ips")),
		allowedHosts: parseStringArray(values.get("security.allowed_hosts")).map(
			(host) => host.toLowerCase(),
		),
	}));
	requestSettings.set(request, pending);
	return pending;
}

function parseStringArray(value: string | undefined): string[] {
	if (!value) return [];
	try {
		const parsed: unknown = JSON.parse(value);
		if (
			!Array.isArray(parsed) ||
			parsed.length > 100 ||
			!parsed.every(
				(item): item is string =>
					typeof item === "string" &&
					/^(?:\[[0-9a-f:]+\]|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::\d{1,5})?$/i.test(
						item.trim(),
					),
			)
		)
			throw new Error("Invalid Allowed Hosts setting");
		return [...new Set(parsed.map((host) => host.trim().toLowerCase()))];
	} catch {
		throw new Error("Invalid Allowed Hosts setting");
	}
}

function parseBlockedIps(value: string | undefined): string[] {
	if (!value) return [];
	return z
		.array(z.union([z.ipv4(), z.ipv6()]))
		.max(100)
		.parse(JSON.parse(value))
		.map((ip) => ip.toLowerCase());
}
