import { afterEach, expect, it, vi } from "vitest";
import { checkWebRtc } from "#/features/ip-check/webrtc";

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});
function mockPeer() {
	const peer = {
		onicecandidate: null as
			| null
			| ((event: {
					candidate: { type: string; address: string } | null;
			  }) => void),
		createDataChannel: vi.fn(),
		createOffer: vi.fn().mockResolvedValue({}),
		setLocalDescription: vi.fn().mockResolvedValue(undefined),
		close: vi.fn(),
	};
	vi.stubGlobal("RTCPeerConnection", function MockPeer() {
		return peer;
	});
	return peer;
}
it("ignores host addresses, deduplicates STUN candidates and closes the connection", async () => {
	const peer = mockPeer();
	const result = checkWebRtc(new AbortController().signal);
	peer.onicecandidate?.({
		candidate: { type: "host", address: "192.168.1.1" },
	});
	peer.onicecandidate?.({
		candidate: { type: "srflx", address: "203.0.113.2" },
	});
	peer.onicecandidate?.({
		candidate: { type: "srflx", address: "203.0.113.2" },
	});
	peer.onicecandidate?.({ candidate: null });
	expect(await result).toEqual(["203.0.113.2"]);
	expect(peer.close).toHaveBeenCalledOnce();
});
it("finishes after a bounded timeout even when STUN is blocked", async () => {
	vi.useFakeTimers();
	const peer = mockPeer();
	const result = checkWebRtc(new AbortController().signal);
	await vi.advanceTimersByTimeAsync(5000);
	expect(await result).toEqual([]);
	expect(peer.close).toHaveBeenCalledOnce();
});
it("cleans up on unmount/cancellation", async () => {
	const peer = mockPeer();
	const controller = new AbortController();
	const result = checkWebRtc(controller.signal);
	controller.abort();
	await result;
	expect(peer.close).toHaveBeenCalledOnce();
});
it("reports unsupported browsers", async () => {
	vi.stubGlobal("RTCPeerConnection", undefined);
	await expect(checkWebRtc(new AbortController().signal)).rejects.toThrow(
		"unavailable",
	);
});
