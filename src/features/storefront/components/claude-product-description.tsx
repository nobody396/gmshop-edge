import { TriangleAlert } from "lucide-react";

/** Keep the owner-managed notice verbatim; only change its presentation. */
export function ClaudeProductDescription({
	description,
}: {
	description: string;
}) {
	const title = "重要提示｜Claude Max 身份验证（KYC）";
	const hasNotice = description.startsWith(`${title}\n`);
	const separator = description.indexOf("\n\n");
	if (!hasNotice || separator < 0) {
		return (
			<p className="mt-4 max-w-2xl whitespace-pre-wrap text-muted-foreground leading-7">
				{description}
			</p>
		);
	}
	const notice = description.slice(title.length + 1, separator);
	const remaining = description.slice(separator + 2);
	return (
		<>
			<section
				aria-labelledby="claude-max-kyc-title"
				className="mt-5 rounded-2xl border-2 border-amber-400 bg-amber-50 p-5 text-amber-950 shadow-lg shadow-amber-500/10 sm:p-6 dark:border-amber-400 dark:bg-amber-950 dark:text-amber-50"
			>
				<h2
					id="claude-max-kyc-title"
					className="flex items-start gap-3 font-extrabold text-xl leading-7 sm:text-2xl"
				>
					<TriangleAlert
						aria-hidden="true"
						className="mt-0.5 size-7 shrink-0 text-amber-700 dark:text-amber-300"
					/>
					{title}
				</h2>
				<p className="mt-4 whitespace-pre-wrap font-semibold text-base leading-8 sm:text-lg">
					{notice
						.split(
							/(新账号禁止充值|已注册至少一个月|可能存在不到账|无法事先检测|百分百需要 KYC 身份验证|KYC 需买家自行解决|请勿下单)/u,
						)
						.map((part, index) =>
							index % 2 === 1 ? (
								<mark
									key={part}
									className="rounded bg-amber-300 px-1 py-0.5 font-black text-amber-950"
								>
									{part}
								</mark>
							) : (
								part
							),
						)}
				</p>
			</section>
			{remaining ? (
				<p className="mt-4 max-w-2xl whitespace-pre-wrap text-muted-foreground leading-7">
					{remaining}
				</p>
			) : null}
		</>
	);
}
