import type { ReactNode } from "react";
import { PaymentProviderLogo } from "#/components/provider-logo";
import { paymentChannelLabel } from "../payment-channel-label";

export function PaymentChannelOption({
	channel,
	selected,
	onSelect,
	children,
}: {
	channel: {
		id: string;
		name: string;
		provider: string;
		logoUrl: string | null;
	};
	selected: string;
	onSelect: (id: string) => void;
	children?: ReactNode;
}) {
	return (
		<label className="grid min-h-16 cursor-pointer place-items-center content-center gap-1.5 rounded-lg bg-background/70 px-3 py-2.5 text-center text-sm ring-offset-background transition hover:bg-background has-checked:bg-primary/10 has-checked:ring-2 has-checked:ring-primary has-checked:ring-offset-2 has-focus-visible:ring-2 has-focus-visible:ring-ring">
			<input
				checked={selected === channel.id}
				className="sr-only"
				name="payment-channel"
				onChange={() => onSelect(channel.id)}
				required
				type="radio"
				value={channel.id}
			/>
			<PaymentProviderLogo
				className="size-6 rounded-md"
				logoUrl={channel.logoUrl}
				providerId={channel.provider}
			/>
			<span className="font-medium leading-snug">
				{paymentChannelLabel(channel.name)}
			</span>
			{children}
		</label>
	);
}
