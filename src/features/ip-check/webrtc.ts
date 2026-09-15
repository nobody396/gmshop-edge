// Explicit opt-in only. No candidate is sent to our server or persisted.
export async function checkWebRtc(signal: AbortSignal): Promise<string[]> {
	if (typeof RTCPeerConnection === "undefined") throw new Error("unavailable");
	const peer = new RTCPeerConnection({
		iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
	});
	const addresses = new Set<string>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let finish = () => {};
	try {
		await new Promise<void>((resolve, reject) => {
			finish = () => resolve();
			if (signal.aborted) {
				resolve();
				return;
			}
			signal.addEventListener("abort", finish, { once: true });
			peer.onicecandidate = ({ candidate }) => {
				// STUN-derived reflexive addresses only; never local/host candidates.
				if (candidate?.type === "srflx" && candidate.address)
					addresses.add(candidate.address);
				if (!candidate) resolve();
			};
			timer = setTimeout(finish, 5000);
			peer.createDataChannel("network-check");
			void peer
				.createOffer()
				.then((offer) => peer.setLocalDescription(offer))
				.catch(reject);
		});
		return [...addresses];
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", finish);
		peer.onicecandidate = null;
		peer.close();
	}
}
