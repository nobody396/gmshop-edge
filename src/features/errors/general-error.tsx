import { useNavigate } from "@tanstack/react-router";
import { RotateCcw } from "lucide-react";
import type { HTMLAttributes } from "react";
import { Button } from "#/components/ui/button";
import { ErrorPage } from "#/features/errors/error-page";
import { m } from "#/paraglide/messages";

type GeneralErrorProps = HTMLAttributes<HTMLDivElement> & {
	minimal?: boolean;
	error?: unknown;
};

// Shown on the page so a customer screenshot identifies client-only crashes
// (e.g. inside in-app browsers) that never reach server logs.
function errorDetail(error: unknown) {
	if (!(error instanceof Error))
		return error ? String(error).slice(0, 200) : "";
	const frame = error.stack
		?.split("\n")
		.map((line) => line.trim())
		.find((line) => line && !line.startsWith(error.name));
	return [`${error.name}: ${error.message}`.slice(0, 300), frame?.slice(0, 200)]
		.filter(Boolean)
		.join("\n");
}

export function GeneralError({
	className,
	minimal = false,
	error,
}: GeneralErrorProps) {
	const navigate = useNavigate();

	return (
		<ErrorPage
			actions={
				!minimal ? (
					<>
						<Button variant="ghost" onClick={() => window.location.reload()}>
							{m.common_retry()}
						</Button>
						<Button onClick={() => navigate({ to: "/" })}>
							{m.errors_back_to_store()}
						</Button>
					</>
				) : undefined
			}
			className={className}
			code={minimal ? undefined : "500"}
			description={m.errors_generalDescription()}
			detail={minimal ? undefined : errorDetail(error)}
			icon={RotateCcw}
			minimal={minimal}
			title={m.errors_generalTitle()}
		/>
	);
}
