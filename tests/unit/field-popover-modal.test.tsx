// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { Select } from "#/components/pro/base/fields/select";
import { ProModal } from "#/components/pro/overlay";

(
	globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
globalThis.ResizeObserver = class ResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
};
Element.prototype.scrollIntoView = () => {};

describe("field popovers inside modal forms", () => {
	let container: HTMLDivElement | undefined;

	afterEach(() => {
		container?.remove();
		container = undefined;
	});

	it("portals searchable option lists into the active modal scroll boundary", async () => {
		container = document.createElement("div");
		document.body.appendChild(container);
		const root = createRoot(container);
		await act(async () => {
			root.render(
				<ProModal open title="Inventory">
					<Select
						ariaLabel="Target SKU"
						searchable
						options={Array.from({ length: 20 }, (_, index) => ({
							label: `Option ${index + 1}`,
							value: String(index + 1),
						}))}
					/>
				</ProModal>,
			);
		});
		await act(async () => {
			document.querySelector<HTMLButtonElement>('[role="combobox"]')?.click();
			await Promise.resolve();
		});

		const modal = document.querySelector('[data-slot="pro-modal-content"]');
		const popover = document.querySelector(
			'[data-slot="field-popover-content"]',
		);
		const list = popover?.querySelector("[cmdk-list]");
		expect(modal?.contains(popover)).toBe(true);
		expect(list?.className).toContain("overflow-y-auto");

		await act(async () => root.unmount());
	});
});
