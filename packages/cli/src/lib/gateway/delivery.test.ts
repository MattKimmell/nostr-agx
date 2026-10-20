import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { setRuntimeForTests } from "../runtime.js";
import { DeliveryQueue, deliver, signDelivery } from "./delivery.js";
import type { Subscription } from "./subscriptions.js";

const subscription: Subscription = {
	id: "sub_1",
	secret: "s3cret",
	createdAt: 0,
	label: null,
	url: "http://127.0.0.1:1/hook",
	events: ["message"],
	capabilities: [],
	acceptAll: true,
	allowedPeers: [],
	includeUnlisted: false,
	maxTaskAgeSec: 600,
	resultTimeoutSec: 5,
	advertise: false,
};

let restore: (() => void) | undefined;
afterEach(() => {
	restore?.();
	restore = undefined;
});

/** Stub the network: each call takes the next answer; an Error is thrown. */
function network(answers: (Response | Error)[]) {
	const calls: { url: string; init: RequestInit }[] = [];
	restore = setRuntimeForTests({
		fetch: async (url, init) => {
			calls.push({ url: String(url), init: init ?? {} });
			const next = answers.shift();
			if (!next || next instanceof Error) {
				throw next ?? new Error("no more answers");
			}
			return next;
		},
		sleep: async () => undefined,
	});
	return calls;
}

describe("signDelivery", () => {
	it("is an HMAC-SHA256 of the timestamp and the exact body", () => {
		const body = '{"event":"message"}';
		const expected = createHmac("sha256", "s3cret").update(`1700000000.${body}`).digest("hex");
		expect(signDelivery("s3cret", 1700000000, body)).toBe(`v1=${expected}`);
	});
});

describe("deliver", () => {
	it("signs what it sends, and does not follow redirects", async () => {
		const calls = network([new Response(JSON.stringify({ ok: 1 }), { status: 200 })]);
		const outcome = await deliver(subscription, { event: "message", text: "hi" }, "evt1", 1000);
		expect(outcome).toEqual({ kind: "response", status: 200, body: { ok: 1 } });
		const [{ init }] = calls;
		const headers = init.headers as Record<string, string>;
		expect(init.redirect).toBe("manual");
		expect(headers["x-agx-signature"]).toBe(
			signDelivery("s3cret", Number(headers["x-agx-timestamp"]), String(init.body)),
		);
		expect(headers["x-agx-delivery"]).toBe("evt1");
	});

	it("tells a webhook that cannot be reached from one that answered", async () => {
		network([new TypeError("fetch failed")]);
		await expect(deliver(subscription, { event: "message" }, "e", 1000)).resolves.toMatchObject({
			kind: "unreachable",
		});
	});
});

describe("DeliveryQueue", () => {
	it("retries a webhook that could not be reached, then stops", async () => {
		const calls = network([new TypeError("down"), new Response("", { status: 503 }), new Response("{}", { status: 200 })]);
		const failures: string[] = [];
		const queue = new DeliveryQueue({ retryDelaysMs: [1, 1], onFailure: (_s, id) => failures.push(id) });
		queue.enqueue(subscription, { event: "message" }, "e1");
		await queue.idle();
		expect(calls).toHaveLength(3);
		expect(failures).toEqual([]);
	});

	it("does not retry the webhook's own error, since the workflow may have run", async () => {
		const calls = network([new Response("{}", { status: 500 })]);
		const failures: string[] = [];
		const queue = new DeliveryQueue({ retryDelaysMs: [1, 1], onFailure: (_s, id, detail) => failures.push(`${id}: ${detail}`) });
		queue.enqueue(subscription, { event: "message" }, "e2");
		await queue.idle();
		expect(calls).toHaveLength(1);
		expect(failures).toEqual(["e2: HTTP 500"]);
	});
});
