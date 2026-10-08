import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { authClient } from "#/features/auth/auth-client";
import { useTurnstile } from "#/features/auth/components/turnstile";
import { isInternalIdentityEmail } from "#/features/auth/identity-email";
import { safePostAuthRedirect } from "#/features/auth/post-auth-redirect";
import { m } from "#/paraglide/messages";
import { getLocale } from "#/paraglide/runtime";
import { agentEmailSendErrorMessage } from "../error-message";

// Better Auth owns the OTP, verified identity and session. No guest identity table.
export function AgentEmailVerification({
	itemId,
	redirectTo,
}: {
	itemId: string;
	redirectTo?: string;
}) {
	const session = authClient.useSession();
	const currentEmail = session.data?.user.email;
	const [email, setEmail] = useState(
		currentEmail && !isInternalIdentityEmail(currentEmail) ? currentEmail : "",
	);
	const [sentEmail, setSentEmail] = useState("");
	const [otp, setOtp] = useState("");
	const challenge = useTurnstile("register");
	const normalized = email.trim().toLowerCase();
	const codeSent = Boolean(sentEmail && sentEmail === normalized);
	const send = useMutation({
		mutationFn: async () => {
			const result = await authClient.emailOtp.sendVerificationOtp(
				{ email: normalized, type: "sign-in" },
				{ headers: { "x-agent-access-item": itemId, ...challenge.headers } },
			);
			if (result.error) throw result.error;
			setSentEmail(normalized);
			setOtp("");
		},
		onError: () => challenge.reset(),
	});
	const verify = useMutation({
		mutationFn: async () => {
			const result = await authClient.signIn.emailOtp(
				{
					email: sentEmail,
					otp,
					name: sentEmail.split("@")[0],
					preferredLocale: getLocale(),
				},
				{ headers: { "x-agent-access-item": itemId } },
			);
			if (result.error) throw new Error("invalid_code");
			// Better Auth emailOTPClient already refreshes the session; stay on this form.
			if (redirectTo) window.location.assign(safePostAuthRedirect(redirectTo));
		},
	});
	return (
		<div className="grid gap-3">
			<p className="text-sm">
				{redirectTo
					? m.agent_access_reentry_notice()
					: m.agent_access_email_steps()}
			</p>
			<Label htmlFor={`access-email-${itemId}`}>
				{m.auth_email_required()}
			</Label>
			<Input
				id={`access-email-${itemId}`}
				type="email"
				autoComplete="email"
				value={email}
				onChange={(e) => {
					if (sentEmail) challenge.reset();
					setEmail(e.target.value);
					setSentEmail("");
					verify.reset();
					send.reset();
				}}
			/>
			{!codeSent ? (
				<>
					{" "}
					{challenge.widget}
					<Button
						type="button"
						variant="outline"
						disabled={
							!challenge.ready ||
							send.isPending ||
							verify.isPending ||
							!z.email().safeParse(normalized).success
						}
						onClick={() => send.mutate()}
					>
						{m.auth_email_otp_send_code()}
					</Button>
				</>
			) : null}
			{codeSent ? (
				<>
					<output>{m.auth_email_otp_sent({ email: sentEmail })}</output>
					<Label htmlFor={`access-otp-${itemId}`}>
						{m.auth_email_otp_code()}
					</Label>
					<Input
						id={`access-otp-${itemId}`}
						inputMode="numeric"
						autoComplete="one-time-code"
						maxLength={6}
						value={otp}
						onChange={(e) => setOtp(e.target.value)}
					/>
					<Button
						type="button"
						disabled={
							verify.isPending || send.isPending || !/^\d{6}$/.test(otp)
						}
						onClick={() => verify.mutate()}
					>
						{m.agent_access_verify_continue()}
					</Button>
					<Button
						type="button"
						variant="link"
						className="w-fit p-0"
						disabled={verify.isPending}
						onClick={() => {
							setSentEmail("");
							setOtp("");
							send.reset();
							challenge.reset();
						}}
					>
						{m.auth_reset_resend_code()}
					</Button>
				</>
			) : null}
			{send.isError ? (
				<p role="alert">{agentEmailSendErrorMessage(send.error)}</p>
			) : null}
			{verify.isError ? (
				<p role="alert">{m.agent_access_code_failed()}</p>
			) : null}
		</div>
	);
}
