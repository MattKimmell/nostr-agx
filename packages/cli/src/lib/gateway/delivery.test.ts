import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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

	it("tells a webhook nobody could connect to from a connection that broke off", async () => {
		const refused = Object.assign(new TypeError("fetch failed"), {
			cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" }),
		});
		const reset = Object.assign(new TypeError("fetch failed"), {
			cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
		});
		network([refused, reset]);
		await expect(deliver(subscription, { event: "task" }, "e", 1000)).resolves.toMatchObject({
			kind: "unreachable",
			sent: false,
		});
		await expect(deliver(subscription, { event: "task" }, "e", 1000)).resolves.toMatchObject({
			kind: "unreachable",
			sent: true,
		});
	});

	it("counts an answer that stalls after its headers as a timeout", async () => {
		const server = createServer((_req, res) => {
			res.writeHead(200, { "content-type": "application/json" });
			res.write("{");
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
			await expect(deliver({ ...subscription, url }, { event: "task" }, "e", 300)).resolves.toEqual({ kind: "timeout" });
		} finally {
			server.closeAllConnections();
			server.close();
		}
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

	it("waits out a retry without holding up deliveries to other webhooks", async () => {
		const delivered: string[] = [];
		let releaseRetry: () => void = () => undefined;
		restore = setRuntimeForTests({
			fetch: async (url) => {
				if (String(url).includes("down")) {
					throw new TypeError("fetch failed");
				}
				delivered.push(String(url));
				return new Response("{}", { status: 200 });
			},
			sleep: () => new Promise<void>((resolve) => {
				releaseRetry = resolve;
			}),
		});
		const queue = new DeliveryQueue({ concurrency: 1, retryDelaysMs: [60_000] });
		queue.enqueue({ ...subscription, url: "http://down.example/hook" }, { event: "message" }, "e1");
		queue.enqueue({ ...subscription, url: "http://up.example/hook" }, { event: "message" }, "e2");
		for (let i = 0; i < 50 && delivered.length === 0; i++) {
			await new Promise((r) => setTimeout(r, 10));
		}
		// The healthy webhook got its delivery while the other waits to retry.
		expect(delivered).toEqual(["http://up.example/hook"]);
		releaseRetry();
		await queue.idle();
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
