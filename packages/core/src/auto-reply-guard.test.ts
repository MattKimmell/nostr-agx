import { describe, expect, it } from "vitest";
import { AutoReplyGuard, DEFAULT_AUTO_REPLY_LIMITS } from "./auto-reply-guard";

describe("AutoReplyGuard", () => {
	const send = { from: "me", to: "peer", contextId: "c1" };
	const refused = (admission: ReturnType<AutoReplyGuard["admit"]>) => admission.refused;

	it("never bounds a message a person wrote (depth 0)", () => {
		const guard = new AutoReplyGuard();
		for (let i = 0; i < 100; i++) {
			expect(refused(guard.admit({ ...send, depth: 0 }, DEFAULT_AUTO_REPLY_LIMITS))).toBeNull();
		}
	});

	it("refuses an automated reply over the depth ceiling", () => {
		const guard = new AutoReplyGuard();
		expect(refused(guard.admit({ ...send, depth: 8 }, DEFAULT_AUTO_REPLY_LIMITS))).toBeNull();
		expect(refused(guard.admit({ ...send, depth: 9 }, DEFAULT_AUTO_REPLY_LIMITS))).toMatch(
			/ceiling of 8/,
		);
	});

	it("bounds automated replies per conversation, and per peer across conversations", () => {
		const guard = new AutoReplyGuard();
		const limits = { maxDepth: 8, perConversation: 2, perPeerPerHour: 3 };
		expect(refused(guard.admit({ ...send, depth: 1 }, limits))).toBeNull();
		expect(refused(guard.admit({ ...send, depth: 1 }, limits))).toBeNull();
		expect(refused(guard.admit({ ...send, depth: 1 }, limits))).toMatch(/this conversation/);
		// A fresh contextId resets the conversation count but not the peer's.
		expect(refused(guard.admit({ ...send, contextId: "c2", depth: 1 }, limits))).toBeNull();
		expect(refused(guard.admit({ ...send, contextId: "c3", depth: 1 }, limits))).toMatch(
			/last hour/,
		);
		// Another of our identities talking to the same peer is another agent.
		expect(
			refused(guard.admit({ ...send, from: "me2", contextId: "c3", depth: 1 }, limits)),
		).toBeNull();
	});

	it("forgets replies older than an hour", () => {
		const guard = new AutoReplyGuard();
		const limits = { maxDepth: 8, perConversation: 100, perPeerPerHour: 1 };
		const t0 = 1_000_000_000_000;
		expect(refused(guard.admit({ ...send, depth: 1 }, limits, t0))).toBeNull();
		expect(refused(guard.admit({ ...send, depth: 1 }, limits, t0 + 1000))).not.toBeNull();
		expect(refused(guard.admit({ ...send, depth: 1 }, limits, t0 + 3_600_001))).toBeNull();
	});

	it("takes back a reply that was not sent, once", () => {
		const guard = new AutoReplyGuard();
		const limits = { maxDepth: 8, perConversation: 1, perPeerPerHour: 1 };
		const admission = guard.admit({ ...send, depth: 1 }, limits);
		expect(refused(admission)).toBeNull();
		expect(refused(guard.admit({ ...send, depth: 1 }, limits))).not.toBeNull();
		if (admission.refused === null) {
			admission.release();
			admission.release();
		}
		expect(refused(guard.admit({ ...send, depth: 1 }, limits))).toBeNull();
		expect(refused(guard.admit({ ...send, depth: 1 }, limits))).not.toBeNull();
	});
});
