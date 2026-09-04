import type { RuntimeConfig } from "#/server/runtime-config";
import { createSupplierAdapter } from "../providers/factory";
import type { SupplierProvider } from "../schema";
import { readSupplierCredentials } from "../secrets";
import {
	createSupplierHttpAudit,
	type SupplierDiagnosticsContext,
} from "./diagnostics";

export type SupplierAccountRuntimeRow = {
	id: string;
	provider: SupplierProvider;
	base_url: string;
	currency: string;
	currency_decimals: number;
	credentials_encrypted: string;
	credentials_revision: number;
};

export async function adapterForSupplierAccount(
	account: SupplierAccountRuntimeRow,
	runtime: Pick<RuntimeConfig, "commerceSecret">,
	options: {
		revision?: number;
		fetcher?: typeof fetch;
		diagnostics?: SupplierDiagnosticsContext;
	} = {},
) {
	if (!runtime.commerceSecret)
		throw new Error("supplier_configuration_unavailable");
	const revision = options.revision ?? account.credentials_revision;
	const credentials = await readSupplierCredentials(
		account.credentials_encrypted,
		revision,
		account.provider,
		runtime.commerceSecret,
	);
	return createSupplierAdapter({
		provider: account.provider,
		baseUrl: account.base_url,
		credentials,
		currency: account.currency,
		currencyDecimals: account.currency_decimals,
		fetcher: options.fetcher,
		audit: options.diagnostics
			? createSupplierHttpAudit({
					...options.diagnostics,
					accountId: account.id,
					commerceSecret: runtime.commerceSecret,
					credentialValues: Object.values(credentials).filter(
						(value): value is string => typeof value === "string",
					),
				})
			: undefined,
	});
}
