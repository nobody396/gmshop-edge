"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Switch } from "#/components/ui/switch";
import { PageHeader } from "#/layouts/components/page-header";
import { formatDateTime } from "#/lib/format";
import { displayCity, formatBytes } from "../domain";
import {
	claudeEnvSubscriptionActionFn,
	getClaudeEnvAdminFn,
	saveClaudeEnvRelayFn,
	setClaudeEnvEnabledFn,
} from "../server/admin";

const queryKey = ["admin", "claude-env"] as const;

const statusLabel: Record<string, string> = {
	awaiting_ip: "等 IP",
	provisioning: "开通中（质检）",
	active: "正常",
	needs_replace: "待换 IP",
	expired: "已到期（IP 已释放）",
	suspended: "已暂停",
	cancelled: "已取消",
};

type Data = Awaited<ReturnType<typeof getClaudeEnvAdminFn>>;
type Sub = Data["subscriptions"][number];

const time = (value: unknown) =>
	typeof value === "number"
		? formatDateTime(value, "zh-CN", "Asia/Shanghai")
		: "—";
const num = (value: unknown) => (typeof value === "number" ? value : 0);
const str = (value: unknown) =>
	typeof value === "string" && value ? value : "—";

function errorText(error: unknown) {
	return error instanceof Error ? error.message : "操作失败";
}

export function ClaudeEnvAdminPage() {
	const client = useQueryClient();
	const data = useQuery({
		queryKey,
		queryFn: () => getClaudeEnvAdminFn(),
		refetchInterval: 30_000,
	});
	const refresh = () => client.invalidateQueries({ queryKey });
	const flag = useMutation({
		mutationFn: setClaudeEnvEnabledFn,
		onSuccess: async () => {
			await refresh();
			toast.success("已保存");
		},
		onError: (error) => toast.error(errorText(error)),
	});
	const [selected, setSelected] = useState<string | null>(null);
	const switchId = useId();
	const value = data.data;
	const current = value?.subscriptions.find((row) => row.id === selected);
	return (
		<div className="flex w-full flex-col gap-4">
			<PageHeader
				description="Claude 稳定使用环境：订阅、专属 IP、中转机。客户看不到 IPRoyal 信息；交付后的 IP 不自动更换。"
				title="Claude 专属环境"
			/>
			<section className="flex items-start justify-between gap-3 rounded-lg border p-4">
				<div className="flex flex-col gap-1">
					<label className="font-medium text-sm" htmlFor={switchId}>
						自动开通（总开关）
					</label>
					<p className="text-muted-foreground text-xs">
						打开后：从打开那一刻起付款的 4 个 Claude 环境 SKU 订单会自动买
						IP、质检、开通、续费。原来的库存「订单码」照常发，不受影响。关掉后不再处理新订单（中转机接口照常工作）。
					</p>
				</div>
				<Switch
					checked={value?.enabled ?? false}
					disabled={!value || flag.isPending}
					id={switchId}
					onCheckedChange={(enabled) => flag.mutate({ data: { enabled } })}
				/>
			</section>
			<RelaysSection relays={value?.relays ?? []} onSaved={refresh} />
			<section className="flex flex-col gap-2">
				<h2 className="font-medium">
					订阅（{value?.subscriptions.length ?? 0}）
				</h2>
				<div className="overflow-x-auto rounded-lg border">
					<table className="w-full min-w-[1100px] text-sm">
						<thead className="bg-muted/50 text-muted-foreground">
							<tr>
								{[
									"状态",
									"客户",
									"订单",
									"IP / 城市",
									"中转",
									"到期",
									"本期流量",
									"最近检查",
									"备注",
									"",
								].map((h) => (
									<th
										className="px-3 py-2 text-start font-medium"
										key={h}
										scope="col"
									>
										{h}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{(value?.subscriptions ?? []).map((row) => {
								return (
									<tr
										className={`border-t ${row.id === selected ? "bg-muted/40" : ""}`}
										key={String(row.id)}
									>
										<td className="px-3 py-2">
											{statusLabel[String(row.status)] ?? String(row.status)}
										</td>
										<td className="px-3 py-2">{row.email}</td>
										<td className="px-3 py-2 font-mono text-xs">
											{str(row.order_number)}
										</td>
										<td className="px-3 py-2">
											<div className="font-mono text-xs">{str(row.ip)}</div>
											<div className="text-muted-foreground text-xs">
												{displayCity(row.ip_city) ?? "—"} · {str(row.ip_tz)}
											</div>
										</td>
										<td className="px-3 py-2 text-xs">
											{str(row.relay_id)}:
											{str(
												row.relay_port === null ? null : String(row.relay_port),
											)}
										</td>
										<td className="px-3 py-2 text-xs">
											{row.expires_at
												? time(row.expires_at)
												: `待开通 +${num(row.pending_days)} 天`}
										</td>
										<td className="px-3 py-2 text-xs tabular-nums">
											{formatBytes(num(row.traffic_period_bytes))} /{" "}
											{formatBytes(num(row.traffic_quota_bytes))}
										</td>
										<td className="px-3 py-2 text-xs">
											{time(row.last_check_at)}
											{row.last_exit_ok === 0
												? " ❌"
												: row.last_exit_ok === 1
													? " ✅"
													: ""}
										</td>
										<td className="max-w-[260px] px-3 py-2 text-xs">
											{[
												row.needs_replace_reason,
												row.qc_note,
												row.last_apply_error,
												row.last_error,
												row.iproyal_order_state === "unknown" ||
												row.iproyal_order_state === "posting"
													? "IPRoyal 下单结果不明"
													: null,
												row.iproyal_order_id
													? `IPRoyal #${row.iproyal_order_id}`
													: null,
											]
												.filter(Boolean)
												.join("；") || "—"}
										</td>
										<td className="px-3 py-2">
											<Button
												onClick={() =>
													setSelected(
														row.id === selected ? null : String(row.id),
													)
												}
												size="sm"
												variant="outline"
											>
												操作
											</Button>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			</section>
			{current ? <SubscriptionActions onDone={refresh} sub={current} /> : null}
			<PeriodsSection onDone={refresh} periods={value?.periods ?? []} />
		</div>
	);
}

function RelaysSection({
	relays,
	onSaved,
}: {
	relays: Data["relays"];
	onSaved: () => Promise<unknown>;
}) {
	const [form, setForm] = useState({
		id: "r1",
		hostname: "",
		secret: "",
		maxCustomers: "10",
		quotaTb: "5",
		status: "active",
	});
	const save = useMutation({
		mutationFn: saveClaudeEnvRelayFn,
		onSuccess: async () => {
			setForm((f) => ({ ...f, secret: "" }));
			await onSaved();
			toast.success("中转机已保存");
		},
		onError: (error) => toast.error(errorText(error)),
	});
	return (
		<section className="flex flex-col gap-2">
			<h2 className="font-medium">中转机</h2>
			<div className="overflow-x-auto rounded-lg border">
				<table className="w-full min-w-[800px] text-sm">
					<thead className="bg-muted/50 text-muted-foreground">
						<tr>
							{[
								"ID",
								"域名",
								"状态",
								"客户（在线/占位/上限）",
								"本月流量 / 额度",
								"最近上报",
							].map((h) => (
								<th
									className="px-3 py-2 text-start font-medium"
									key={h}
									scope="col"
								>
									{h}
								</th>
							))}
						</tr>
					</thead>
					<tbody>
						{relays.map((relay) => (
							<tr className="border-t" key={String(relay.id)}>
								<td className="px-3 py-2 font-mono">{String(relay.id)}</td>
								<td className="px-3 py-2 font-mono text-xs">
									{String(relay.hostname)}
								</td>
								<td className="px-3 py-2">
									{relay.status === "active" ? "启用" : "停用"}
								</td>
								<td className="px-3 py-2">
									{num(relay.live_customers)} / {num(relay.customers)} /{" "}
									{num(relay.max_customers)}
								</td>
								<td className="px-3 py-2 text-xs tabular-nums">
									{str(relay.host_month)}：
									{formatBytes(
										num(relay.host_rx_bytes) + num(relay.host_tx_bytes),
									)}{" "}
									/ {formatBytes(num(relay.monthly_quota_bytes))}
								</td>
								<td className="px-3 py-2 text-xs">
									{time(relay.last_report_at)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
			<form
				className="grid gap-2 rounded-lg border p-3 sm:grid-cols-3 lg:grid-cols-6"
				onSubmit={(event) => {
					event.preventDefault();
					save.mutate({
						data: {
							id: form.id.trim(),
							hostname: form.hostname.trim(),
							secret: form.secret.trim() || undefined,
							status: form.status === "disabled" ? "disabled" : "active",
							maxCustomers: Number(form.maxCustomers),
							monthlyQuotaBytes: Math.round(Number(form.quotaTb) * 1e12),
						},
					});
				}}
			>
				<Field
					label="ID"
					onChange={(id) => setForm({ ...form, id })}
					value={form.id}
				/>
				<Field
					label="域名（开通码里用）"
					onChange={(hostname) => setForm({ ...form, hostname })}
					value={form.hostname}
				/>
				<Field
					label="密钥（64 位十六进制，改时才填）"
					onChange={(secret) => setForm({ ...form, secret })}
					type="password"
					value={form.secret}
				/>
				<Field
					label="客户上限"
					onChange={(maxCustomers) => setForm({ ...form, maxCustomers })}
					value={form.maxCustomers}
				/>
				<Field
					label="月流量额度（TB）"
					onChange={(quotaTb) => setForm({ ...form, quotaTb })}
					value={form.quotaTb}
				/>
				<Field
					label="状态（active/disabled）"
					onChange={(status) => setForm({ ...form, status })}
					value={form.status}
				/>
				<div className="sm:col-span-3 lg:col-span-6">
					<Button disabled={save.isPending} size="sm" type="submit">
						保存中转机（新增或按 ID 修改）
					</Button>
				</div>
			</form>
		</section>
	);
}

function Field({
	label,
	value,
	onChange,
	type = "text",
}: {
	label: string;
	value: string;
	onChange: (value: string) => void;
	type?: string;
}) {
	const id = useId();
	return (
		<div className="flex flex-col gap-1">
			<Label className="text-xs" htmlFor={id}>
				{label}
			</Label>
			<Input
				autoComplete="off"
				id={id}
				onChange={(event) => onChange(event.target.value)}
				type={type}
				value={value}
			/>
		</div>
	);
}

function SubscriptionActions({
	sub,
	onDone,
}: {
	sub: Sub;
	onDone: () => Promise<unknown>;
}) {
	const action = useMutation({
		mutationFn: claudeEnvSubscriptionActionFn,
		onSuccess: async () => {
			await onDone();
			toast.success("已处理");
		},
		onError: (error) => toast.error(errorText(error)),
	});
	const [days, setDays] = useState("30");
	const [replace, setReplace] = useState({
		sameOrder: false,
		ip: "",
		port: "12323",
		user: "",
		pass: "",
		city: "",
		order: "",
	});
	const [orderId, setOrderId] = useState("");
	const id = String(sub.id);
	const status = String(sub.status);
	const unknownOrder =
		sub.iproyal_order_state === "unknown" ||
		sub.iproyal_order_state === "posting";
	return (
		<section className="grid gap-3 rounded-lg border p-4">
			<h2 className="font-medium">
				操作：{sub.email}（{statusLabel[status] ?? status}，{id}）
			</h2>
			{status === "expired" ? (
				<p className="text-muted-foreground text-sm">
					IP 已随 IPRoyal 订单到期释放，不能恢复；客户再买会自动开新订阅、分配新
					IP。
				</p>
			) : null}
			<div className={status === "expired" ? "hidden" : "flex flex-wrap gap-2"}>
				{status === "suspended" ? (
					<Button
						disabled={action.isPending}
						onClick={() => action.mutate({ data: { action: "resume", id } })}
						size="sm"
					>
						恢复
					</Button>
				) : (
					<Button
						disabled={action.isPending}
						onClick={() => action.mutate({ data: { action: "suspend", id } })}
						size="sm"
						variant="outline"
					>
						暂停
					</Button>
				)}
				<Input
					aria-label="延长天数"
					className="w-24"
					onChange={(e) => setDays(e.target.value)}
					value={days}
				/>
				<Button
					disabled={action.isPending}
					onClick={() =>
						action.mutate({
							data: { action: "extend_days", id, days: Number(days) },
						})
					}
					size="sm"
					variant="outline"
				>
					只改本地到期（不碰 IPRoyal，IPRoyal 要另外手动续）
				</Button>
			</div>
			{unknownOrder ? (
				<div className="flex flex-wrap items-end gap-2">
					<Field
						label="IPRoyal 订单号（后台查到的）"
						onChange={setOrderId}
						value={orderId}
					/>
					<Button
						disabled={action.isPending}
						onClick={() =>
							action.mutate({
								data: {
									action: "set_iproyal_order",
									id,
									iproyalOrderId: orderId,
								},
							})
						}
						size="sm"
					>
						填入订单号
					</Button>
					<Button
						disabled={action.isPending || !sub.reorderAllowed}
						onClick={() =>
							action.mutate({ data: { action: "allow_reorder", id } })
						}
						size="sm"
						variant="outline"
					>
						允许重新下单
					</Button>
					<p className="basis-full text-muted-foreground text-xs">
						先去 IPRoyal
						后台核对有没有这一单，确认没有再点「允许重新下单」；有的话填订单号。
						{sub.reorderAllowed ? "" : "（下单不到 5 分钟，按钮暂不可用）"}
					</p>
				</div>
			) : null}
			{["needs_replace", "provisioning", "awaiting_ip"].includes(status) ? (
				<form
					className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6"
					onSubmit={(event) => {
						event.preventDefault();
						action.mutate({
							data: {
								action: "replace_ip",
								id,
								ip: replace.ip,
								port: Number(replace.port),
								user: replace.user,
								pass: replace.pass,
								city: replace.city || undefined,
								iproyalOrderId: replace.order || undefined,
								sameOrder: replace.sameOrder || undefined,
							},
						});
					}}
				>
					<Field
						label="新 IP"
						onChange={(ip) => setReplace({ ...replace, ip })}
						value={replace.ip}
					/>
					<Field
						label="端口"
						onChange={(port) => setReplace({ ...replace, port })}
						value={replace.port}
					/>
					<Field
						label="上游用户名"
						onChange={(user) => setReplace({ ...replace, user })}
						value={replace.user}
					/>
					<Field
						label="上游密码"
						onChange={(pass) => setReplace({ ...replace, pass })}
						type="password"
						value={replace.pass}
					/>
					<Field
						label="城市（可空）"
						onChange={(city) => setReplace({ ...replace, city })}
						value={replace.city}
					/>
					<Field
						label="新的 IPRoyal 订单号（必填，除非勾选右边）"
						onChange={(order) => setReplace({ ...replace, order })}
						value={replace.order}
					/>
					<label className="flex items-center gap-2 text-xs">
						<input
							checked={replace.sameOrder}
							onChange={(event) =>
								setReplace({ ...replace, sameOrder: event.target.checked })
							}
							type="checkbox"
						/>
						还是原来那张订单（IPRoyal 在原订单里换的 IP）
					</label>
					<div className="sm:col-span-3 lg:col-span-6">
						<Button disabled={action.isPending} size="sm" type="submit">
							已在 IPRoyal 换好 IP：保存并重新质检
						</Button>
					</div>
				</form>
			) : null}
		</section>
	);
}

function PeriodsSection({
	periods,
	onDone,
}: {
	periods: Data["periods"];
	onDone: () => Promise<unknown>;
}) {
	const action = useMutation({
		mutationFn: claudeEnvSubscriptionActionFn,
		onSuccess: async () => {
			await onDone();
			toast.success("已处理");
		},
		onError: (error) => toast.error(errorText(error)),
	});
	if (!periods.length) return null;
	return (
		<section className="flex flex-col gap-2">
			<h2 className="font-medium">需要人工处理的续期 / 订单</h2>
			<div className="overflow-x-auto rounded-lg border">
				<table className="w-full min-w-[800px] text-sm">
					<tbody>
						{periods.map((period) => {
							const orderItemId = String(period.order_item_id);
							const stuck =
								period.extend_status === "failed" ||
								period.extend_status === "extending";
							return (
								<tr className="border-t" key={orderItemId}>
									<td className="px-3 py-2 font-mono text-xs">
										{str(period.order_number)}
									</td>
									<td className="px-3 py-2">
										{period.kind === "skipped"
											? "未自动处理"
											: period.kind === "waiting"
												? "游客订单，等客户注册"
												: `续期 ${num(period.days)} 天（${num(period.units_extended)}/${num(period.units)}）`}
									</td>
									<td className="px-3 py-2 text-xs">{str(period.note)}</td>
									<td className="px-3 py-2 text-xs">
										{time(period.created_at)}
									</td>
									<td className="flex gap-2 px-3 py-2">
										{stuck ? (
											<>
												<Button
													disabled={action.isPending}
													onClick={() =>
														action.mutate({
															data: { action: "period_done", orderItemId },
														})
													}
													size="sm"
												>
													已手动续期
												</Button>
												<Button
													disabled={action.isPending || !period.retryAllowed}
													onClick={() =>
														action.mutate({
															data: { action: "period_retry", orderItemId },
														})
													}
													size="sm"
													variant="outline"
												>
													重试续期
												</Button>
												{period.extend_status === "extending" ? (
													<span className="text-muted-foreground text-xs">
														结果不明：先核对 IPRoyal
														这张订单的到期时间有没有延长，再决定
													</span>
												) : null}
											</>
										) : null}
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
		</section>
	);
}
