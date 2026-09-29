"use client";

import { Headphones, LoaderCircle, Paperclip, Send, X } from "lucide-react";
import {
	type KeyboardEvent,
	type SyntheticEvent,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { Textarea } from "#/components/pro/base/fields/input";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { authClient } from "#/features/auth/auth-client";
import { useTurnstile } from "#/features/auth/components/turnstile";
import { cn } from "#/lib/utils";
import { m } from "#/paraglide/messages";
import { getLocale } from "#/paraglide/runtime";
import {
	decodeSupportReply,
	supportAttachmentSchema,
	supportAttachmentUrl,
	supportFileAccept,
	supportFileMaxBytes,
	supportFileRetentionMs,
} from "../web-support-attachments";
import {
	webSupportOpenEvent,
	webSupportPollIntervalMs,
} from "../web-support-contract";
import {
	decryptWebSupportReply,
	getWebSupportIdentity,
	loadWebSupportMessages,
	saveWebSupportMessage,
	setWebSupportConversationId,
	type WebSupportLocalMessage,
} from "../web-support-storage";

type SupportStatus = {
	enabled: boolean;
	hasConversation: boolean;
	conversationId?: string | null;
	status: string | null;
};

function formatMessageTime(timestamp: number) {
	return new Intl.DateTimeFormat(getLocale(), {
		hour: "2-digit",
		minute: "2-digit",
	}).format(timestamp);
}

export function WebSupportWidget() {
	const session = authClient.useSession();
	const [available, setAvailable] = useState(false);
	const [supportEnabled, setSupportEnabled] = useState(false);
	const [open, setOpen] = useState(false);
	const [status, setStatus] = useState<string | null>(null);
	const [email, setEmail] = useState("");
	const [messages, setMessages] = useState<WebSupportLocalMessage[]>([]);
	const [text, setText] = useState("");
	const [attachment, setAttachment] = useState<{
		file: File;
		id: string;
	} | null>(null);
	const fileInput = useRef<HTMLInputElement>(null);
	const challenge = useTurnstile("support");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const lastSequence = useRef(0);
	const conversationId = useRef<string | null>(null);
	const polling = useRef(false);
	const pendingTextId = useRef<{ text: string; id: string } | null>(null);
	const [receiveError, setReceiveError] = useState<string | null>(null);
	const [sendingPreview, setSendingPreview] = useState<{
		text: string;
		name?: string;
		url?: string;
		startedAt: number;
	} | null>(null);
	const [sendingSeconds, setSendingSeconds] = useState(0);
	const messagesViewportRef = useRef<HTMLDivElement>(null);
	const sessionEmail = session.data?.user?.email ?? "";

	useEffect(() => {
		void Promise.all([
			fetch("/api/support/web/status", { credentials: "include" }).then(
				(response) => response.json() as Promise<SupportStatus>,
			),
			loadWebSupportMessages(),
		])
			.then(([result, localMessages]) => {
				setAvailable(result.enabled || result.hasConversation);
				setSupportEnabled(result.enabled);
				setStatus(result.status);
				conversationId.current = result.conversationId ?? null;
				setMessages(
					localMessages.filter(
						(message) =>
							!message.conversationId ||
							message.conversationId === result.conversationId,
					),
				);
				lastSequence.current = 0;
			})
			.catch(() => undefined);
	}, []);

	useEffect(() => {
		if (sessionEmail) setEmail(sessionEmail);
	}, [sessionEmail]);

	useEffect(() => {
		const openSupport = () => setOpen(true);
		const openFromEmail = () => {
			if (window.location.hash === "#support") setOpen(true);
		};
		openFromEmail();
		window.addEventListener("hashchange", openFromEmail);
		window.addEventListener(webSupportOpenEvent, openSupport);
		return () => {
			window.removeEventListener(webSupportOpenEvent, openSupport);
			window.removeEventListener("hashchange", openFromEmail);
		};
	}, []);

	const poll = useCallback(async () => {
		if (
			!open ||
			polling.current ||
			!["active", "closing"].includes(status ?? "")
		)
			return;
		polling.current = true;
		try {
			const response = await fetch(
				`/api/support/web/current?version=2&after=${lastSequence.current}`,
				{ credentials: "include", signal: AbortSignal.timeout(15_000) },
			);
			if (!response.ok) throw new Error("receive_failed");
			const result = (await response.json()) as {
				conversationId: string;
				status: string;
				replies: Array<{
					id: string;
					sequence: number;
					text?: string;
					algorithm: string;
					wrapped_key: string;
					iv: string;
					ciphertext: string;
					created_at: number;
				}>;
			};
			if (
				conversationId.current &&
				conversationId.current !== result.conversationId
			) {
				lastSequence.current = 0;
				conversationId.current = result.conversationId;
				return;
			}
			conversationId.current = result.conversationId;
			setStatus(result.status);
			const received: WebSupportLocalMessage[] = [];
			let skipped = false;
			for (const reply of result.replies) {
				let text = reply.text;
				if (typeof text !== "string") {
					try {
						text = await decryptWebSupportReply(
							await getWebSupportIdentity(),
							result.conversationId,
							reply,
						);
					} catch {
						skipped = true;
						lastSequence.current = Math.max(
							lastSequence.current,
							reply.sequence,
						);
						continue;
					}
				}
				const message: WebSupportLocalMessage = {
					id: reply.id,
					role: "support",
					...decodeSupportReply(text),
					createdAt: reply.created_at,
					sequence: reply.sequence,
					conversationId: result.conversationId,
				};
				void saveWebSupportMessage(message).catch(() => undefined);
				received.push(message);
				lastSequence.current = Math.max(lastSequence.current, reply.sequence);
			}
			if (received.length)
				setMessages((current) => {
					const merged = new Map(
						current
							.filter(
								(message) =>
									message.createdAt > Date.now() - supportFileRetentionMs &&
									(!message.conversationId ||
										message.conversationId === result.conversationId),
							)
							.map((message) => [message.id, message]),
					);
					for (const message of received) merged.set(message.id, message);
					return [...merged.values()].sort((a, b) => a.createdAt - b.createdAt);
				});
			if (skipped) setReceiveError(m.web_support_legacy_unreadable());
			else
				setReceiveError((current) =>
					current === m.web_support_receive_failed() ? null : current,
				);
		} catch {
			setReceiveError(m.web_support_receive_failed());
		} finally {
			polling.current = false;
		}
	}, [open, status]);

	useEffect(() => {
		const timer = window.setInterval(() => {
			void loadWebSupportMessages();
			setMessages((current) =>
				current.filter(
					(message) => message.createdAt > Date.now() - supportFileRetentionMs,
				),
			);
		}, 60_000);
		return () => window.clearInterval(timer);
	}, []);
	useEffect(() => {
		if (!sendingPreview) return;
		setSendingSeconds(0);
		const timer = window.setInterval(
			() =>
				setSendingSeconds(
					Math.floor((Date.now() - sendingPreview.startedAt) / 1000),
				),
			1000,
		);
		return () => {
			window.clearInterval(timer);
			if (sendingPreview.url) URL.revokeObjectURL(sendingPreview.url);
		};
	}, [sendingPreview]);

	useEffect(() => {
		void poll();
		if (!open) return;
		const pollWhenAvailable = () => {
			if (document.visibilityState === "visible" && navigator.onLine)
				void poll();
		};
		const interval = window.setInterval(
			pollWhenAvailable,
			webSupportPollIntervalMs,
		);
		window.addEventListener("focus", pollWhenAvailable);
		window.addEventListener("online", pollWhenAvailable);
		document.addEventListener("visibilitychange", pollWhenAvailable);
		return () => {
			window.clearInterval(interval);
			window.removeEventListener("focus", pollWhenAvailable);
			window.removeEventListener("online", pollWhenAvailable);
			document.removeEventListener("visibilitychange", pollWhenAvailable);
		};
	}, [open, poll]);

	useEffect(() => {
		if (
			!open ||
			(messages.length === 0 && status !== "closed" && !sendingPreview)
		)
			return;
		const frame = window.requestAnimationFrame(() => {
			const viewport = messagesViewportRef.current;
			if (!viewport) return;
			viewport.scrollTop = viewport.scrollHeight;
		});
		return () => window.cancelAnimationFrame(frame);
	}, [messages.length, open, status, sendingPreview]);

	if (!available) return null;

	async function startConversation(
		event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
	) {
		event.preventDefault();
		if (!challenge.ready) return;
		setBusy(true);
		setError(null);
		try {
			const [identity, fingerprint] = await Promise.all([
				getWebSupportIdentity(),
				import("@fingerprintjs/fingerprintjs")
					.then((module) => module.default.load({ monitoring: false }))
					.then((agent) => agent.get())
					.then((result) => ({
						visitorId: result.visitorId,
						version: result.version,
					}))
					.catch(() => undefined),
			]);
			const response = await fetch("/api/support/web/conversations", {
				method: "POST",
				credentials: "include",
				headers: { "content-type": "application/json", ...challenge.headers },
				body: JSON.stringify({
					email: sessionEmail || email,
					visitorId: identity.visitorId,
					publicKeyJwk: identity.publicKeyJwk,
					fingerprint,
					diagnostics: {
						locale: getLocale(),
						timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
					},
				}),
			});
			if (!response.ok) throw new Error("start_failed");
			const result = (await response.json()) as { id: string; status: string };
			await setWebSupportConversationId(result.id);
			conversationId.current = result.id;
			lastSequence.current = 0;
			setStatus(result.status);
		} catch {
			setError(m.web_support_failed());
		} finally {
			challenge.reset();
			setBusy(false);
		}
	}

	async function sendMessage(
		event: SyntheticEvent<HTMLFormElement, SubmitEvent>,
	) {
		event.preventDefault();
		const value = text.trim();
		if ((!value && !attachment) || busy) return;
		if (attachment && value.length > 1000) {
			setError(m.web_support_attachment_caption_limit());
			return;
		}
		setBusy(true);
		setError(null);
		if (!attachment && pendingTextId.current?.text !== value)
			pendingTextId.current = { text: value, id: crypto.randomUUID() };
		setSendingPreview({
			text: value,
			name: attachment?.file.name,
			url: attachment?.file.type.startsWith("image/")
				? URL.createObjectURL(attachment.file)
				: undefined,
			startedAt: Date.now(),
		});
		const message: WebSupportLocalMessage = {
			id: attachment?.id ?? pendingTextId.current?.id ?? crypto.randomUUID(),
			conversationId: conversationId.current ?? undefined,
			role: "customer",
			text: value,
			createdAt: Date.now(),
		};
		try {
			let response: Response;
			if (attachment) {
				const form = new FormData();
				form.set("file", attachment.file);
				form.set("clientMessageId", attachment.id);
				form.set("text", value);
				response = await fetch("/api/support/web/attachments/", {
					method: "POST",
					credentials: "include",
					body: form,
					signal: AbortSignal.timeout(65_000),
				});
			} else {
				response = await fetch("/api/support/web/messages", {
					method: "POST",
					credentials: "include",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ clientMessageId: message.id, text: value }),
					signal: AbortSignal.timeout(35_000),
				});
			}
			const result = (await response.json()) as {
				code?: string;
				attachment?: unknown;
			};
			if (!response.ok) {
				setError(
					result.code === "attachment_pending"
						? m.web_support_attachment_pending()
						: attachment
							? m.web_support_attachment_failed()
							: m.web_support_failed(),
				);
				return;
			}
			if (attachment)
				message.attachment = supportAttachmentSchema.parse(result.attachment);
			void saveWebSupportMessage(message).catch(() =>
				setError(m.web_support_local_history_failed()),
			);
			setMessages((current) => [...current, message]);
			setText((current) => (current.trim() === value ? "" : current));
			setAttachment((current) =>
				current?.id === attachment?.id ? null : current,
			);
			pendingTextId.current = null;
		} catch {
			setError(
				attachment
					? m.web_support_attachment_pending()
					: m.web_support_failed(),
			);
		} finally {
			setBusy(false);
			setSendingPreview(null);
		}
	}

	function chooseAttachment(file: File) {
		if (busy) return;
		if (
			!file.size ||
			file.size > supportFileMaxBytes ||
			!supportFileAccept
				.split(",")
				.some((extension) => file.name.toLowerCase().endsWith(extension))
		) {
			setError(m.web_support_attachment_failed());
			return;
		}
		setError(null);
		setAttachment({ file, id: crypto.randomUUID() });
	}

	function handleMessageKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
		if (
			event.key !== "Enter" ||
			event.shiftKey ||
			event.nativeEvent.isComposing
		)
			return;
		event.preventDefault();
		event.currentTarget.form?.requestSubmit();
	}

	return (
		<>
			<Button
				className="fixed right-4 bottom-[calc(5.5rem+env(safe-area-inset-bottom))] z-40 rounded-full shadow-lg lg:bottom-6"
				size="lg"
				onClick={() => setOpen(true)}
				aria-label={m.web_support_button()}
			>
				<Headphones />{" "}
				<span className="hidden sm:inline">{m.web_support_button()}</span>
			</Button>
			{open ? (
				<section
					role="dialog"
					aria-modal="true"
					aria-labelledby="web-support-title"
					className="fixed inset-x-0 bottom-0 z-50 flex h-[min(78dvh,42rem)] flex-col rounded-t-2xl border bg-background shadow-2xl sm:inset-x-auto sm:right-4 sm:bottom-4 sm:h-[38rem] sm:w-[24rem] sm:rounded-2xl"
				>
					<header className="flex items-center justify-between border-b p-4">
						<h2 id="web-support-title" className="font-semibold">
							{m.web_support_title()}
						</h2>
						<Button
							variant="ghost"
							size="icon"
							onClick={() => setOpen(false)}
							aria-label={m.common_close()}
						>
							<X />
						</Button>
					</header>
					<p className="border-b bg-muted/50 px-4 py-3 text-xs text-muted-foreground">
						{m.web_support_reply_notice()}
						<br />
						{m.web_support_attachment_hint()}
					</p>
					{!["active", "closing", "closed"].includes(status ?? "") ? (
						session.isPending ? (
							<div className="flex flex-1 items-center justify-center">
								<LoaderCircle className="animate-spin text-muted-foreground" />
							</div>
						) : (
							<form
								className="flex flex-1 flex-col gap-4 overflow-y-auto p-5"
								onSubmit={startConversation}
							>
								{!sessionEmail ? (
									<Input
										type="email"
										required
										maxLength={254}
										disabled={busy}
										value={email}
										onChange={(event) => setEmail(event.target.value)}
										placeholder={m.web_support_email()}
										aria-label={m.web_support_email()}
									/>
								) : null}
								{receiveError ? (
									<p className="px-4 text-xs text-amber-600" aria-live="polite">
										{receiveError}
									</p>
								) : null}
								{error ? (
									<p className="text-sm text-destructive" role="alert">
										{error}
									</p>
								) : null}
								{challenge.widget}
								<Button
									className="mt-auto w-full"
									disabled={busy || !challenge.ready}
								>
									{busy ? <LoaderCircle className="animate-spin" /> : null}
									{busy ? m.web_support_connecting() : m.web_support_start()}
								</Button>
							</form>
						)
					) : (
						<>
							<div
								ref={messagesViewportRef}
								className="flex-1 scroll-smooth space-y-3 overflow-y-auto p-4 motion-reduce:scroll-auto"
								aria-live="polite"
							>
								{messages.map((message) => (
									<div
										key={message.id}
										className={cn(
											"w-fit max-w-[85%] rounded-2xl px-3 py-2 text-sm",
											message.role === "customer"
												? "ml-auto bg-primary text-primary-foreground"
												: "bg-muted",
										)}
									>
										<span className="mb-1 flex items-center gap-2 text-xs opacity-70">
											{message.role === "customer"
												? m.web_support_you()
												: m.web_support_agent()}
											<time
												dateTime={new Date(message.createdAt).toISOString()}
											>
												{formatMessageTime(message.createdAt)}
											</time>
										</span>
										{message.attachment ? (
											<div className="space-y-2">
												{message.attachment.mime.startsWith("image/") ? (
													<a
														href={supportAttachmentUrl(message.attachment.id)}
														target="_blank"
														rel="noopener noreferrer"
													>
														<img
															src={supportAttachmentUrl(message.attachment.id)}
															alt={message.attachment.name}
															className="max-h-52 max-w-full rounded-lg object-contain"
															loading="lazy"
														/>
													</a>
												) : null}
												<a
													className="block break-all font-medium underline"
													href={supportAttachmentUrl(
														message.attachment.id,
														true,
													)}
												>
													{message.attachment.name} ·{" "}
													{Math.ceil(message.attachment.size / 1024)} KB ·{" "}
													{m.web_support_attachment_download()}
												</a>
											</div>
										) : null}
										<p className="whitespace-pre-wrap break-words">
											{message.text}
										</p>
									</div>
								))}
								{sendingPreview ? (
									<div
										className="ml-auto w-fit max-w-[85%] space-y-2 rounded-2xl bg-primary/10 p-3 text-sm"
										aria-live="polite"
									>
										{sendingPreview.url ? (
											<img
												src={sendingPreview.url}
												alt={sendingPreview.name ?? ""}
												className="max-h-32 max-w-full rounded-lg object-contain"
											/>
										) : null}
										{sendingPreview.name ? (
											<p className="break-all">{sendingPreview.name}</p>
										) : null}
										{sendingPreview.text ? (
											<p className="whitespace-pre-wrap break-words">
												{sendingPreview.text}
											</p>
										) : null}
										<p className="flex items-center gap-2 text-xs">
											<LoaderCircle className="size-4 animate-spin" />
											{m.web_support_sending_status()} · {sendingSeconds}s
										</p>
									</div>
								) : null}
								{status === "closed" ? (
									<p className="text-center text-sm text-muted-foreground">
										{m.web_support_closed()}
									</p>
								) : null}
							</div>
							{receiveError ? (
								<p className="px-4 text-xs text-amber-600" aria-live="polite">
									{receiveError}
								</p>
							) : null}
							{error ? (
								<p className="px-4 text-sm text-destructive" role="alert">
									{error}
								</p>
							) : null}
							{status === "closed" && supportEnabled ? (
								<form className="border-t p-3" onSubmit={startConversation}>
									{challenge.widget}
									<Button
										className="w-full"
										disabled={busy || !challenge.ready}
									>
										{busy ? <LoaderCircle className="animate-spin" /> : null}
										{busy ? m.web_support_reopening() : m.web_support_reopen()}
									</Button>
								</form>
							) : status !== "closed" ? (
								<form
									className="border-t pb-[env(safe-area-inset-bottom)]"
									onSubmit={sendMessage}
								>
									<div className="flex items-center gap-2 px-3 pt-2">
										<input
											ref={fileInput}
											type="file"
											accept={supportFileAccept}
											className="hidden"
											aria-label={m.web_support_attach()}
											onChange={(event) => {
												const file = event.target.files?.[0];
												if (file) chooseAttachment(file);
												event.target.value = "";
											}}
										/>
										<Button
											type="button"
											variant="ghost"
											size="sm"
											disabled={busy}
											onClick={() => fileInput.current?.click()}
										>
											<Paperclip className="size-4" />
											{m.web_support_attach()}
										</Button>
										{attachment ? (
											<>
												<span className="min-w-0 flex-1 truncate text-xs">
													{attachment.file.name}
												</span>
												<Button
													type="button"
													variant="ghost"
													size="icon-sm"
													disabled={busy}
													aria-label={m.web_support_attachment_remove()}
													onClick={() => setAttachment(null)}
												>
													<X />
												</Button>
											</>
										) : null}
									</div>
									<Textarea
										allowClear={false}
										className="min-h-20 max-h-32 resize-none rounded-none border-0 bg-transparent px-4 py-3 pr-14 shadow-none focus-visible:border-transparent focus-visible:ring-0 dark:bg-transparent"
										maxLength={attachment ? 1000 : 3500}
										onPaste={(event) => {
											const file = Array.from(event.clipboardData.files).find(
												(file) => file.type.startsWith("image/"),
											);
											if (file) {
												event.preventDefault();
												chooseAttachment(file);
											}
										}}
										value={text}
										onChange={(event) => setText(event.target.value)}
										onKeyDown={handleMessageKeyDown}
										placeholder={m.web_support_message_placeholder()}
										aria-label={m.web_support_message_placeholder()}
										suffix={
											<Button
												className="rounded-full"
												size="icon-sm"
												disabled={busy || (!text.trim() && !attachment)}
												aria-label={m.web_support_send()}
											>
												{busy ? (
													<LoaderCircle className="animate-spin" />
												) : (
													<Send />
												)}
											</Button>
										}
									/>
								</form>
							) : null}
						</>
					)}
				</section>
			) : null}
		</>
	);
}
