// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PromotionAccount } from "#/features/promotions/account";
import { m } from "#/paraglide/messages";

const { success, error } = vi.hoisted(() => ({
	success: vi.fn(),
	error: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: { success, error } }));
vi.mock("#/features/promotions/server/functions", () => ({
	getPromotionAccountFn: vi.fn(),
	openReferralFn: vi.fn(),
	setMarketingConsentFn: vi.fn(),
}));
vi.mock("@tanstack/react-query", () => ({
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
	useMutation: () => ({ mutate: vi.fn() }),
	useQuery: () => ({
		data: {
			balanceMinor: "0",
			referral: { code: "INV-ABCDEFGHIJKLMNOPQRST", enabled: true },
			marketingConsent: false,
			coupons: [],
			rewards: [],
			entries: [],
		},
	}),
}));
let root: Root;
let container: HTMLDivElement;
const original = Object.getOwnPropertyDescriptor(navigator, "clipboard");
beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.clearAllMocks();
	container = document.createElement("div");
	root = createRoot(container);
	await act(async () => root.render(<PromotionAccount />));
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	if (original) Object.defineProperty(navigator, "clipboard", original);
	else Reflect.deleteProperty(navigator, "clipboard");
	vi.unstubAllGlobals();
});
function clipboard(value: unknown) {
	Object.defineProperty(navigator, "clipboard", { configurable: true, value });
}
async function click() {
	const button = [...container.querySelectorAll("button")].find(
		(b) => b.textContent === m.promotion_copy_link(),
	);
	if (!button) throw Error("Copy button missing");
	await act(async () => button.click());
}
it("shows success only after the invitation link has been copied", async () => {
	let done: () => void = () => {};
	const writeText = vi.fn(
		() =>
			new Promise<void>((resolve) => {
				done = resolve;
			}),
	);
	clipboard({ writeText });
	await click();
	expect(success).not.toHaveBeenCalled();
	expect(writeText).toHaveBeenCalledWith(
		new URL("/?ref=INV-ABCDEFGHIJKLMNOPQRST", window.location.origin).href,
	);
	await act(async () => done());
	expect(success).toHaveBeenCalledWith(m.common_copy_success());
	expect(error).not.toHaveBeenCalled();
});
it("reports a rejected clipboard write rather than success", async () => {
	clipboard({ writeText: vi.fn().mockRejectedValue(new Error("denied")) });
	await click();
	expect(error).toHaveBeenCalledWith(m.common_copy_failed());
	expect(success).not.toHaveBeenCalled();
});
it("reports an unavailable clipboard API", async () => {
	clipboard(undefined);
	await click();
	expect(error).toHaveBeenCalledWith(m.common_copy_failed());
	expect(success).not.toHaveBeenCalled();
});
