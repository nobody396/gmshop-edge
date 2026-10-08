import { AgentEmailVerification } from "#/features/agent-access/components/email-verification";
import { agentAccessProducts } from "#/features/agent-access/products";
import { UserAuthForm } from "#/features/auth/components/user-auth-form";
import { m } from "#/paraglide/messages";

type SignInProps = {
	redirectTo?: string;
};

export function SignIn({ redirectTo = "/" }: SignInProps) {
	return (
		<div className="w-full space-y-6">
			<div className="space-y-2">
				<h1 className="font-semibold text-3xl tracking-tight">
					{m.auth_signIn_title()}
				</h1>
				<p className="text-muted-foreground leading-6">
					{m.auth_signIn_description()}
				</p>
			</div>
			<UserAuthForm redirectTo={redirectTo} />
			<details className="rounded-xl border p-4">
				<summary className="cursor-pointer font-medium">
					{m.agent_access_order_signin()}
				</summary>
				<div className="mt-4">
					<AgentEmailVerification
						itemId={agentAccessProducts.api.itemId}
						redirectTo={redirectTo === "/" ? "/account/orders" : redirectTo}
					/>
				</div>
			</details>
		</div>
	);
}
