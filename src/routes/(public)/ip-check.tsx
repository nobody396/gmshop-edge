import { createFileRoute } from "@tanstack/react-router";
import { IpCheckPage } from "#/features/ip-check/page";
import { m } from "#/paraglide/messages";
export const Route = createFileRoute("/(public)/ip-check")({
	head: () => ({
		meta: [
			{ title: m.ip_title() },
			{ name: "description", content: m.ip_intro() },
		],
	}),
	component: IpCheckPage,
});
