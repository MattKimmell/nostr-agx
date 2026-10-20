import { generateKeypair, toNpub } from "@nostr-agx/nostr";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sandbox } from "../../test/helpers.js";
import { createGatewayKey, revokeGatewayKey, verifyGatewayKey } from "./keys.js";
import { parseSubscriptionInput, START_GRACE_SEC, SubscriptionError, SubscriptionStore } from "./subscriptions.js";

let box: ReturnType<typeof sandbox>;
beforeEach(() => {
	box = sandbox();
});
afterEach(() => box.restore());

const alice = generateKeypair().publicKey;
const bob = generateKeypair().publicKey;

describe("parseSubscriptionInput", () => {
	it("normalizes allowed agents to hex and fills the defaults", () => {
		const input = parseSubscriptionInput({
			url: "https://n8n.example.com/webhook/abc",
			events: ["task", "task", "message"],
			capabilities: [" invoice.review ", "invoice.review"],
			allowedPeers: [toNpub(alice), bob],
		});
		expect(input).toMatchObject({
			events: ["task", "message"],
			capabilities: ["invoice.review"],
			allowedPeers: [alice, bob],
			acceptAll: false,
			maxTaskAgeSec: 600,
			resultTimeoutSec: 120,
			advertise: false,
		});
	});

	it("refuses what could never work: nobody allowed, wildcards, too many on a card, bad keys", () => {
		const base = { url: "https://x.example/h", events: ["task"], capabilities: ["a.b"] };
		expect(() => parseSubscriptionInput(base)).toThrow(/No agent is allowed/);
		expect(() => parseSubscriptionInput({ ...base, capabilities: ["a.*"], acceptAll: true })).toThrow(/cannot be served/);
		expect(() =>
			parseSubscriptionInput({
				...base,
				acceptAll: true,
				advertise: true,
				capabilities: Array.from({ length: 65 }, (_, i) => `c.n${i}`),
			}),
		).toThrow(/at most 64/);
		expect(() => parseSubscriptionInput({ ...base, allowedPeers: ["npub1nope"] })).toThrow(SubscriptionError);
		// Messages from anyone, marked as such, is a choice a webhook can make.
		expect(parseSubscriptionInput({ url: base.url, events: ["message"], includeUnlisted: true }).includeUnlisted).toBe(true);
	});
});

describe("SubscriptionStore", () => {
	it("picks the newest subscription first, and leaves out a task too old for it", () => {
		const store = new SubscriptionStore("default");
		const now = Math.floor(Date.now() / 1000);
		const older = store.create(parseSubscriptionInput({ url: "https://a.example/h", events: ["task"], capabilities: ["x.y"], allowedPeers: [alice] }));
		const newer = store.create(parseSubscriptionInput({ url: "https://b.example/h", events: ["task"], capabilities: ["x.y"], acceptAll: true, maxTaskAgeSec: 60 }));
		// Same second: order by creation, then the newer first.
		newer.createdAt = older.createdAt + 1;
		expect(store.forTask("x.y", alice).map((s) => s.id)).toEqual([newer.id, older.id]);
		expect(store.forTask("x.y", bob).map((s) => s.id)).toEqual([newer.id]);
		expect(store.forTask("x.y", alice, now - 120).map((s) => s.id)).toEqual([older.id]);
		expect(store.forTask("x.y", alice, now - START_GRACE_SEC - 10_000)).toEqual([]);
		expect(new SubscriptionStore("default").list()).toHaveLength(2);
	});

	it("sends messages from unlisted agents only to a subscription that asked, marked as such", () => {
		const store = new SubscriptionStore("default");
		const now = Math.floor(Date.now() / 1000);
		store.create(parseSubscriptionInput({ url: "https://a.example/h", events: ["message"], allowedPeers: [alice] }));
		const open = store.create(parseSubscriptionInput({ url: "https://b.example/h", events: ["message"], allowedPeers: [alice], includeUnlisted: true }));
		expect(store.forEvent("message", alice, now).map((r) => r.allowed)).toEqual([true, true]);
		expect(store.forEvent("message", bob, now)).toEqual([{ subscription: open, allowed: false }]);
		expect(store.forEvent("receipt", alice, now)).toEqual([]);
	});
});

describe("gateway API keys", () => {
	it("accepts a key it made, never stores it, and refuses it once revoked", () => {
		const { id, key } = createGatewayKey("default", "n8n");
		expect(verifyGatewayKey("default", key)).toBe(id);
		expect(verifyGatewayKey("default", `${key}x`)).toBeNull();
		expect(verifyGatewayKey("default", "")).toBeNull();
		expect(revokeGatewayKey("default", id)).toBe(true);
		expect(verifyGatewayKey("default", key)).toBeNull();
	});

	it("accepts AGX_GATEWAY_KEY from the environment", () => {
		process.env.AGX_GATEWAY_KEY = "env-provided-key-0123456789";
		expect(verifyGatewayKey("default", "env-provided-key-0123456789")).toBe("env");
		expect(verifyGatewayKey("default", "env-provided-key-012345678")).toBeNull();
	});
});
