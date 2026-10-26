import { describe, expect, it } from "vitest";
import { agentPrompt } from "#/features/claude-env/components/panel";

describe("Claude env agent prompt", () => {
	const input = {
		mac: "curl -fsSL https://laoshirenvip.com/claude-env.sh -o /tmp/claude-env.sh && bash /tmp/claude-env.sh 'CE1-abc'",
		windows:
			"irm https://laoshirenvip.com/claude-env.ps1 -OutFile $env:TEMP\\claude-env.ps1",
		code: "CE1-abc",
		ip: "203.0.113.45",
	};

	it("carries the code, both commands, the IP check and the OK reply", () => {
		const text = agentPrompt(input, true);
		for (const part of [
			input.code,
			input.mac,
			input.windows,
			"203.0.113.45",
			"「OK」",
			"定位服务",
		])
			expect(text).toContain(part);
		expect(text).not.toContain("住宅");
	});

	it("falls back to the order page when the IP is not known yet", () => {
		expect(agentPrompt({ ...input, ip: null }, true)).toContain(
			"订单页上的专属 IP",
		);
		expect(agentPrompt(input, false)).toContain('reply only "OK"');
	});
});
