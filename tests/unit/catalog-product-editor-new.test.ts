import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const routeSource = readFileSync(
	new URL("../../src/routes/admin/products/new.tsx", import.meta.url),
	"utf8",
);
const editorSource = readFileSync(
	new URL(
		"../../src/features/catalog/pages/product-editor.tsx",
		import.meta.url,
	),
	"utf8",
);

describe("catalog product editor creation flow", () => {
	it("uses the same editor for new and existing products", () => {
		expect(routeSource).toContain("ProductEditorPage");
		expect(routeSource).not.toContain("ProductCreatePage");
	});

	it("creates the database draft only from the save mutation", () => {
		const mutationStart = editorSource.indexOf("const save = useMutation");
		const createCall = editorSource.indexOf(
			"createProductDraftFn",
			mutationStart,
		);
		expect(mutationStart).toBeGreaterThan(0);
		expect(createCall).toBeGreaterThan(mutationStart);
		expect(editorSource).toContain("if (!savedProductId)");
	});

	it("uses the route-selected product type for every sellable item", () => {
		expect(routeSource).toContain("validateSearch");
		expect(routeSource).toContain(
			"initialProductType={Route.useSearch().type}",
		);
		expect(editorSource).toContain("newComponent(productType)");
		expect(editorSource).toContain("productType,");
		expect(editorSource).not.toContain("<DeliveryTypeSelect");
		expect(editorSource).not.toContain("assignSellableItemDelivery");
	});

	it("keeps Pro array sellable items expanded without a second accordion", () => {
		expect(editorSource).toContain("<ProArrayField");
		expect(editorSource).not.toContain("<Accordion");
		expect(editorSource).not.toContain("catalog_sellable_item_settings");
	});

	it("keeps the editor toolbar outside the scrolling form body", () => {
		expect(editorSource).not.toContain("sticky top-16");
		expect(editorSource).toContain(
			"min-h-0 flex-1 overflow-y-auto overscroll-contain",
		);
		expect(editorSource).toContain("shrink-0 border-b bg-background");
	});

	it("does not expose a storefront preview action in the editor toolbar", () => {
		expect(editorSource).not.toContain("window.open(`/products/");
	});

	it("separates supplier fulfillment from local inventory editing", () => {
		expect(editorSource).toContain("<SupplierFulfillmentPanel");
		expect(editorSource).toContain("canRemoveItem=");
		expect(editorSource).toContain(
			'sellableItem.fulfillmentSource === "local"',
		);
		expect(editorSource).toContain("m.catalog_supplier_manage_binding()");
		expect(editorSource).toContain("binding.normalizedApiOrigin");
	});

	it("documents the bulk text-inventory format in a field tooltip", () => {
		expect(editorSource).toContain(
			"tooltip={m.inventory_content_description()}",
		);
	});

	it("starts new delivery configurations with the delivery email on", () => {
		expect(editorSource).toContain('emailMode: "link"');
	});

	it("queues text inventory and download files before the first save", () => {
		expect(editorSource).toContain("<PendingComponentOperations");
		expect(editorSource).toContain("importInventoryFn");
		expect(editorSource).toContain("uploadPendingDownload");
		expect(editorSource).toContain("pendingCardImports");
		expect(editorSource).toContain("pendingDownloads");
	});

	it("saves new and existing automation configuration through the product form", () => {
		expect(editorSource).toContain("getBuildConfigurationFn");
		expect(editorSource).toContain("<BuildConfigurationFields");
		expect(editorSource).toContain("savedBuilds");
		expect(editorSource).not.toContain("<BuildConfigurationInline");
	});

	it("reports a failed save once through the surrounding form", () => {
		const mutationStart = editorSource.indexOf("const save = useMutation");
		const publishMutationStart = editorSource.indexOf(
			"const publish = useMutation",
			mutationStart,
		);
		const saveMutation = editorSource.slice(
			mutationStart,
			publishMutationStart,
		);

		expect(saveMutation).not.toContain("onError: showError");
		expect(editorSource).toContain("onFinishFailed={showError}");
	});

	it("removes the retired manual-delivery editor", () => {
		expect(editorSource).not.toContain('component.type === "manual"');
		expect(editorSource).not.toContain("ManualInputEditor");
		expect(editorSource).not.toContain("manualServiceTemplate");
		expect(editorSource).not.toContain("manualEstimatedDeliveryMs");
		expect(editorSource).not.toContain("manualInputs");
	});
});
