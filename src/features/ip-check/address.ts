import { z } from "zod";
export function canonicalIp(ip: string) {
	return ip.includes(":")
		? new URL(`http://[${ip}]/`).hostname.slice(1, -1)
		: ip;
}
export const publicIpSchema = z
	.union([z.ipv4(), z.ipv6()])
	.transform(canonicalIp)
	.refine((ip) => {
		if (ip.includes(":"))
			return !/^(::|fc|fd|fe[89ab]|ff)/i.test(ip) && !/^2001:db8:/i.test(ip);
		const [a = 0, b = 0, c = 0] = ip.split(".").map(Number);
		return (
			a > 0 &&
			a < 224 &&
			a !== 10 &&
			a !== 127 &&
			!(a === 169 && b === 254) &&
			!(a === 172 && b >= 16 && b <= 31) &&
			!(a === 192 && b === 168) &&
			!(a === 100 && b >= 64 && b <= 127) &&
			!(a === 192 && b === 0) &&
			!(a === 198 && (b === 18 || b === 19)) &&
			!(a === 198 && b === 51 && c === 100) &&
			!(a === 203 && b === 0 && c === 113)
		);
	});
// Positive matches only: published Google/Cloudflare public DNS anycast addresses.
// Not matching this small set MUST NOT be interpreted as "not anycast".
const anycastResolvers = new Set([
	"1.1.1.1",
	"1.0.0.1",
	"2606:4700:4700::1111",
	"2606:4700:4700::1001",
	"8.8.8.8",
	"8.8.4.4",
	"2001:4860:4860::8888",
	"2001:4860:4860::8844",
]);
export function knownAnycast(ip: string) {
	return anycastResolvers.has(canonicalIp(ip)) ? true : null;
}
