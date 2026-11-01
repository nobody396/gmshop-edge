import { Link } from "@tanstack/react-router";
import { ClaudeEnvPanel } from "../components/panel";

/**
 * The signed-in customer's own environments. Agent-site customers land here
 * (their order sits on the agent's account, so it is not in 「我的订单」).
 */
export function ClaudeEnvAccountPage({
	orderNumbers,
}: {
	orderNumbers: string[];
}) {
	return (
		<section className="mx-auto grid max-w-4xl gap-6 py-6">
			<header className="space-y-2">
				<h1 className="font-bold text-2xl">我的 Claude 专属环境</h1>
				<p className="text-muted-foreground text-sm leading-6">
					在这里查看专属 IP、开通码、到期时间和本期流量，也可以续费、加流量。
					<Link
						className="ml-1 text-primary underline"
						to="/account/claude-env-guide"
					>
						完整图文教程
					</Link>
				</p>
			</header>
			{orderNumbers.length === 0 ? (
				<p className="rounded-2xl border p-5 text-muted-foreground text-sm leading-7">
					这个账号下还没有开通的专属环境。付款后几分钟内会自动开通；如果你是在代理店铺购买的，请确认登录用的是下单时填写的邮箱，并且已经验证过邮箱。
				</p>
			) : (
				orderNumbers.map((orderNumber) => (
					<ClaudeEnvPanel key={orderNumber} orderNumber={orderNumber} />
				))
			)}
		</section>
	);
}
