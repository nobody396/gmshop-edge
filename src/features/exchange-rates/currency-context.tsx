"use client";

import { queryOptions, useQuery } from "@tanstack/react-query";
import {
	createContext,
	type ReactNode,
	useContext,
	useEffect,
	useMemo,
	useState,
} from "react";
import { convertMinorAmount } from "#/features/exchange-rates/rates";
import { getStoreCurrencyConfigurationFn } from "#/features/exchange-rates/server/public";
import { formatMinorAmount } from "#/lib/format";

const preferenceKey = "gmshop-payment-currency:v1";

type CurrencyContextValue = {
	currency: string;
	currencies: string[];
	setCurrency: (currency: string) => void;
	format: (
		amountMinor: string | bigint,
		currency: string,
		decimals: number,
	) => string;
};

const CurrencyContext = createContext<CurrencyContextValue | null>(null);

/** Route loaders prefetch this so server-rendered prices use the store symbol. */
export function storeCurrencyConfigurationQueryOptions() {
	return queryOptions({
		queryKey: ["storefront", "currency-configuration"],
		queryFn: () => getStoreCurrencyConfigurationFn(),
		staleTime: 60_000,
	});
}

export function CurrencyProvider({ children }: { children: ReactNode }) {
	const configuration = useQuery(storeCurrencyConfigurationQueryOptions());
	const baseCurrency = configuration.data?.baseCurrency ?? "USD";
	const baseCurrencySymbol = configuration.data?.baseCurrencySymbol ?? "$";
	const currencies = configuration.data?.currencies ?? [baseCurrency];
	const [currency, setCurrencyState] = useState(baseCurrency);
	useEffect(() => {
		const preferred = window.localStorage.getItem(preferenceKey)?.toUpperCase();
		setCurrencyState(
			preferred && currencies.includes(preferred) ? preferred : baseCurrency,
		);
	}, [baseCurrency, currencies]);
	const value = useMemo<CurrencyContextValue>(
		() => ({
			currency,
			currencies,
			setCurrency: (next) => {
				if (!currencies.includes(next)) return;
				window.localStorage.setItem(preferenceKey, next);
				setCurrencyState(next);
			},
			format: (amountMinor, sourceCurrency, decimals) => {
				const normalizedSource = sourceCurrency.toUpperCase();
				if (currency === normalizedSource)
					return formatStoreAmount(
						amountMinor,
						normalizedSource,
						decimals,
						baseCurrency,
						baseCurrencySymbol,
					);
				const rate = configuration.data?.rates.find(
					(item) =>
						(item.baseCurrency === normalizedSource &&
							item.quoteCurrency === currency) ||
						(item.baseCurrency === currency &&
							item.quoteCurrency === normalizedSource),
				);
				if (!rate)
					return formatStoreAmount(
						amountMinor,
						normalizedSource,
						decimals,
						baseCurrency,
						baseCurrencySymbol,
					);
				const converted = convertMinorAmount({
					amountMinor: String(amountMinor),
					fromCurrency: normalizedSource,
					fromDecimals: decimals,
					toCurrency: currency,
					rate: rate.rate,
					direction:
						rate.baseCurrency === normalizedSource ? "multiply" : "divide",
				});
				return formatStoreAmount(
					converted.amountMinor,
					converted.currency,
					converted.currencyDecimals,
					baseCurrency,
					baseCurrencySymbol,
				);
			},
		}),
		[
			baseCurrency,
			baseCurrencySymbol,
			currency,
			currencies,
			configuration.data,
		],
	);
	return (
		<CurrencyContext.Provider value={value}>
			{children}
		</CurrencyContext.Provider>
	);
}

function formatStoreAmount(
	amountMinor: string | bigint,
	currency: string,
	decimals: number,
	baseCurrency: string,
	baseCurrencySymbol: string,
) {
	const formatted = formatMinorAmount(amountMinor, currency, decimals);
	return currency === baseCurrency
		? `${baseCurrencySymbol}${formatted.slice(currency.length + 1)}`
		: formatted;
}

export function useCurrency() {
	const value = useContext(CurrencyContext);
	if (!value) throw new Error("CurrencyProvider is missing");
	return value;
}

export function StoreMoney({
	amountMinor,
	currency,
	decimals,
}: {
	amountMinor: string | bigint;
	currency: string;
	decimals: number;
}) {
	const selection = useCurrency();
	return selection.format(amountMinor, currency, decimals);
}
