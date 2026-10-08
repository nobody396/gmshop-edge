import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "#/components/ui/button";
import { authClient } from "#/features/auth/auth-client";
import { isInternalIdentityEmail } from "#/features/auth/identity-email";
import { m } from "#/paraglide/messages";
import { getLocale } from "#/paraglide/runtime";
import {
	agentAccessKind,
	agentAccessProducts,
	agentAccessRefundPolicy,
} from "../products";
import {
	listAgentAccessIssuesFn,
	prepareAgentProductsFn,
	retryAgentAccessFn,
} from "../server/admin";
import {
	checkAgentAccessFn,
	getAgentDeliveryFn,
	openAgentAccountFn,
} from "../server/functions";

export function AgentAccessCheckout({ itemId }: { itemId: string }) {
	const session = authClient.useSession();
	const verification = useMutation({
		mutationFn: async () => {
			const email = session.data?.user.email;
			if (!email || isInternalIdentityEmail(email))
				throw new Error("email_required");
			const result = await authClient.sendVerificationEmail({
				email,
				callbackURL: window.location.pathname,
			});
			if (result.error) throw new Error("verification_unavailable");
		},
	});
	const check = useMutation({
		mutationFn: () => checkAgentAccessFn({ data: { itemId } }),
	});
	if (!agentAccessKind(itemId)) return null;
	return (
		<section className="my-4 grid gap-3 rounded-xl border p-4">
			<h3 className="font-semibold">{m.agent_access_title()}</h3>
			<p className="text-sm text-muted-foreground">
				{m.agent_access_purchase_notice()}{" "}
				{agentAccessRefundPolicy[getLocale()]}
			</p>

			{session.data?.user && !session.data.user.emailVerified ? (
				<>
					{!isInternalIdentityEmail(session.data.user.email) ? (
						<Button
							type="button"
							variant="outline"
							disabled={verification.isPending || verification.isSuccess}
							onClick={() => verification.mutate()}
						>
							{m.auth_verification_resend()}
						</Button>
					) : (
						<a className="underline" href="/account">
							{m.agent_access_bind_email()}
						</a>
					)}
					{verification.isSuccess ? (
						<output>{m.agent_access_verification_requested()}</output>
					) : null}
					{verification.isError ? (
						<p role="alert">{m.agent_access_check_error()}</p>
					) : null}
				</>
			) : null}
			<Button
				type="button"
				variant="outline"
				disabled={check.isPending}
				onClick={() => check.mutate()}
			>
				{m.agent_access_check()}
			</Button>
			{check.isError ? (
				<p role="alert">{m.agent_access_check_error()}</p>
			) : null}
			{check.data?.state === "eligible" ? (
				<output>{m.agent_access_eligible()}</output>
			) : null}
			{check.data?.state === "binding_required" ? (
				<p>
					<a
						className="underline"
						href={check.data.url}
						target="_blank"
						rel="noreferrer"
					>
						{m.agent_access_bind()}
					</a>
				</p>
			) : null}
			{check.data?.state === "already_active" ? (
				<output>{m.agent_access_existing()}</output>
			) : null}
		</section>
	);
}
export function AgentAccessDelivery({ orderNumber }: { orderNumber: string }) {
	const query = useQuery({
		queryKey: ["agent-access", orderNumber],
		queryFn: () => getAgentDeliveryFn({ data: { orderNumber } }),
		retry: false,
		refetchInterval: (q) =>
			q.state.data?.state === "pending" && !q.state.data.needsSupport
				? 15000
				: false,
	});
	const access = useMutation({
		mutationFn: () => openAgentAccountFn({ data: { orderNumber } }),
	});
	const data = query.data;
	return (
		<section className="grid gap-3 rounded-xl border p-4">
			<h3 className="font-semibold">{m.agent_access_title()}</h3>
			<p className="text-sm text-muted-foreground">
				{agentAccessRefundPolicy[getLocale()]}
			</p>
			{!data ? (
				<output>{m.agent_access_sign_in()}</output>
			) : (
				<>
					<output>
						{data.needsSupport
							? m.agent_access_support()
							: data.state === "active" && data.orderStatus === "completed"
								? m.agent_access_active()
								: data.state === "revoked"
									? m.agent_access_revoked()
									: m.agent_access_pending()}
					</output>
					{data.state === "active" && data.orderStatus === "completed" ? (
						<>
							<Button
								disabled={access.isPending}
								onClick={() => access.mutate()}
							>
								{m.agent_access_open()}
							</Button>
							{access.data ? (
								<a
									className="underline"
									href={access.data.url}
									target="_blank"
									rel="noreferrer"
								>
									{m.agent_access_continue()}
								</a>
							) : null}
							{access.isError ? (
								<p role="alert">{m.agent_access_support()}</p>
							) : null}
							{data.domain ? (
								<a
									className="break-all underline"
									href={`https://${data.domain}`}
									target="_blank"
									rel="noreferrer"
								>
									{data.domain}
								</a>
							) : null}
							<a
								className="underline"
								href="https://lsrai.shop/agent-access"
								target="_blank"
								rel="noreferrer"
							>
								{m.agent_access_guide()}
							</a>
							<p className="text-sm text-muted-foreground">
								{data.kind === "api"
									? m.agent_access_api_guide()
									: m.agent_access_subsite_guide()}
							</p>
						</>
					) : null}
				</>
			)}
		</section>
	);
}
export function AgentAccessDrafts() {
	const prepare = useMutation({ mutationFn: () => prepareAgentProductsFn() });
	const issues = useQuery({
		queryKey: ["agent-access-issues"],
		queryFn: () => listAgentAccessIssuesFn(),
		retry: false,
	});
	const retry = useMutation({
		mutationFn: (orderItemId: string) =>
			retryAgentAccessFn({ data: { orderItemId } }),
		onSuccess: () => {
			void issues.refetch();
		},
	});
	return (
		<section className="my-6 grid gap-3 rounded-xl border p-4">
			<h3 className="font-semibold">{m.agent_access_title()}</h3>
			<p>{m.agent_access_draft_notice()}</p>
			<Button
				variant="outline"
				disabled={prepare.isPending}
				onClick={() => prepare.mutate()}
			>
				{m.agent_access_prepare_drafts()}
			</Button>
			{prepare.isSuccess ? (
				<output>{m.agent_access_drafts_ready()}</output>
			) : null}
			{prepare.isError ? <p role="alert">{m.agent_access_support()}</p> : null}
			{issues.data?.map((row) => (
				<div
					key={row.orderItemId}
					className="flex flex-wrap items-center gap-3 border-t pt-3"
				>
					<span className="break-all">
						{row.orderNumber} · {row.kind} · {row.attempts}
					</span>
					<Button
						variant="outline"
						disabled={retry.isPending || row.orderStatus === "refunded"}
						onClick={() => retry.mutate(row.orderItemId)}
					>
						{m.agent_access_retry()}
					</Button>
				</div>
			))}
			{retry.isError ? <p role="alert">{m.agent_access_support()}</p> : null}
			{Object.values(agentAccessProducts).map((p) => (
				<a
					className="underline"
					key={p.productId}
					href={`/admin/products/${p.productId}`}
				>
					{p.priceMinor === "990" ? "API · ¥9.90" : "Subsite · ¥199"}
				</a>
			))}
		</section>
	);
}
