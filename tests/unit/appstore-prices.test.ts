import { describe, expect, it } from "vitest";
import {
	type AppStoreIngest,
	buildAppStoreSnapshot,
	parseLocalAmount,
	pickAppleTierAmount,
} from "#/features/appstore-prices/snapshot";

const rates = {
	base: "CNY" as const,
	date: "2026-11-10",
	rates: { USD: 0.15, JPY: 23.7, PHP: 9.43, TRY: 7.53 },
};

function ingest(overrides: Partial<AppStoreIngest> = {}): AppStoreIngest {
	return {
		fetchedAt: 2_000,
		rates,
		apple: [
			{
				app: "chatgpt",
				region: "ph",
				ok: true,
				items: [
					{ name: "ChatGPT Plus", price: "₱ 999.00" },
					{ name: "ChatGPT Plus", price: "₱ 9,990.00" },
					{ name: "ChatGPT Pro 200", price: "₱ 9,990.00" },
				],
			},
			{
				app: "claude",
				region: "tr",
				ok: true,
				items: [
					{ name: "Claude Pro - Monthly", price: "₺999,99" },
					{ name: "Claude Pro - Annual", price: "₺11.999,99" },
				],
			},
		],
		opentherank: [
			{
				app: "chatgpt",
				ok: true,
				regions: { tr: { plus: "≈ ₺999.99/mo", "pro-5x": "≈ ₺5299.99/mo" } },
			},
		],
		...overrides,
	};
}

const cell = (
	snapshot: ReturnType<typeof buildAppStoreSnapshot>,
	app: string,
	tier: string,
	region: "us" | "jp" | "ph" | "tr",
) =>
	snapshot?.apps.find((a) => a.id === app)?.tiers.find((t) => t.id === tier)
		?.cells[region];

describe("App Store price comparison", () => {
	it("reads every local price format", () => {
		expect(parseLocalAmount("₺5.299,99")).toBe("5299.99");
		expect(parseLocalAmount("₺26.499,00")).toBe("26499");
		expect(parseLocalAmount("₺999,99")).toBe("999.99");
		expect(parseLocalAmount("¥3,000")).toBe("3000");
		expect(parseLocalAmount("₱ 9,990.00")).toBe("9990");
		expect(parseLocalAmount("$19.99")).toBe("19.99");
		expect(parseLocalAmount("≈ ₺12999.99/mo")).toBe("12999.99");
		expect(parseLocalAmount("≈ ₱6490/mo")).toBe("6490");
		expect(parseLocalAmount("Free")).toBeNull();
	});

	it("splits same-name purchases into monthly and yearly and ignores duplicates", () => {
		const items = [
			{ name: "Google AI Pro (5 TB)", amount: "869.99" },
			{ name: "Google AI Pro (5 TB)", amount: "869.99" },
			{ name: "Google AI Pro (5 TB)", amount: "539.99" },
			{ name: "ChatGPT Plus", amount: "19.99" },
			{ name: "ChatGPT Plus", amount: "200" },
		];
		const pro = {
			appleNames: ["Google AI Pro (5 TB)"],
			period: "month" as const,
		};
		expect(pickAppleTierAmount(pro, items)).toBe("869.99");
		expect(
			pickAppleTierAmount(
				{ appleNames: ["ChatGPT Plus"], period: "month" },
				items,
			),
		).toBe("19.99");
		expect(
			pickAppleTierAmount(
				{ appleNames: ["ChatGPT Plus"], period: "year" },
				items,
			),
		).toBe("200");
		expect(
			pickAppleTierAmount(
				{ appleNames: ["Claude Pro - Annual"], period: "year" },
				[{ name: "Claude Pro - Annual", amount: "214.99" }],
			),
		).toBe("214.99");
	});

	it("maps Apple first, OpenTheRank as marked fallback, and converts to whole yuan", () => {
		const snapshot = buildAppStoreSnapshot(ingest(), null);
		expect(cell(snapshot, "chatgpt", "plus", "ph")).toMatchObject({
			amount: "999",
			currency: "PHP",
			cny: 106,
			source: "apple",
		});
		expect(cell(snapshot, "chatgpt", "plus-year", "ph")?.amount).toBe("9990");
		expect(cell(snapshot, "chatgpt", "pro-200", "ph")?.cny).toBe(1059);
		expect(cell(snapshot, "claude", "pro", "tr")?.cny).toBe(133);
		expect(cell(snapshot, "claude", "pro-year", "tr")?.amount).toBe("11999.99");
		// TR ChatGPT page was never read: OpenTheRank fills it, marked as such.
		expect(cell(snapshot, "chatgpt", "plus", "tr")).toMatchObject({
			amount: "999.99",
			source: "opentherank",
		});
		expect(snapshot?.rates.date).toBe("2026-11-10");
	});

	it("keeps yesterday's cell and rate when a source fails, never invents one", () => {
		const first = buildAppStoreSnapshot(ingest(), null);
		const second = buildAppStoreSnapshot(
			ingest({
				fetchedAt: 9_000,
				rates: null,
				apple: [
					{ app: "chatgpt", region: "ph", ok: false, items: [] },
					{
						app: "claude",
						region: "tr",
						ok: true,
						items: [{ name: "Claude Pro - Monthly", price: "₺999,99" }],
					},
				],
				opentherank: [{ app: "chatgpt", ok: true, regions: {} }],
			}),
			first,
		);
		expect(cell(second, "chatgpt", "plus", "ph")).toMatchObject({
			amount: "999",
			fetchedAt: 2_000,
		});
		expect(cell(second, "claude", "pro", "tr")?.fetchedAt).toBe(9_000);
		// Both sources read fine and neither lists it any more: empty, not stale.
		expect(cell(second, "claude", "pro-year", "tr")).toBeNull();
		// Its Apple page was not read today: yesterday's OpenTheRank value stays.
		expect(cell(second, "chatgpt", "plus", "tr")).toMatchObject({
			source: "opentherank",
			fetchedAt: 2_000,
		});
		expect(second?.rates).toEqual(first?.rates);
		expect(second?.updatedAt).toBe(9_000);
	});

	it("refuses to build without any exchange rate", () => {
		expect(buildAppStoreSnapshot(ingest({ rates: null }), null)).toBeNull();
	});
});
