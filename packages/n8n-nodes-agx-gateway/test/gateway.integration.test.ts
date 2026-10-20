import { createHmac } from "node:crypto";
import type { AgxClient } from "@nostr-agx/core";
import { DEFAULT_CONTENT_TYPE } from "@nostr-agx/core";
import { generateKeypair, toNpub } from "@nostr-agx/nostr";
import type { IDataObject, ICredentialDataDecryptedObject } from "n8n-workflow";
import { NodeApiError } from "n8n-workflow";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { AgxGateway } from "../nodes/AgxGateway/AgxGateway.node";
import { executeContext, n8nHost, peer, pumping, startTestGateway, waitFor } from "./helpers";

/**
 * Both nodes end to end: a real `agx gateway` on its own relay, real AGX peers,
 * and the AGX Gateway Trigger behind a webhook URL that answers the way n8n
 * does.
 */

let env: Awaited<ReturnType<typeof startTestGateway>>;
const clients: AgxClient[] = [];
const hosts: Awaited<ReturnType<typeof n8nHost>>[] = [];

async function agent(options: Parameters<typeof peer>[1] = {}) {
	const created = await peer(env.relay, options);
	clients.push(created.client);
	return created;
}

async function host(params: IDataObject, workflow?: Parameters<typeof n8nHost>[0]["workflow"]) {
	const created = await n8nHost({ credentials: env.credentials, params, workflow });
	hosts.push(created);
	return created;
}

function run(params: IDataObject, opts: { credentials?: ICredentialDataDecryptedObject; continueOnFail?: boolean } = {}) {
	return new AgxGateway().execute.call(
		executeContext({
			credentials: opts.credentials ?? env.credentials,
			params: () => params,
			continueOnFail: opts.continueOnFail,
		}),
	);
}

function gatewayApi(path: string, init: RequestInit = {}) {
	return fetch(`${env.gateway.url}${path}`, {
		...init,
		headers: { authorization: `Bearer ${env.key}`, "content-type": "application/json", ...init.headers },
	});
}

beforeAll(async () => {
	env = await startTestGateway();
}, 30_000);

afterEach(async () => {
	for (const client of clients.splice(0)) {
		await client.stop();
	}
	for (const created of hosts.splice(0)) {
		await created.delete().catch(() => undefined);
		await created.close();
	}
});

afterAll(async () => {
	await env?.close();
});

describe("AGX Gateway node", () => {
	it("returns the gateway agent's identity", async () => {
		const [[item]] = await run({ resource: "agent", operation: "getIdentity" });
		expect(item.json).toMatchObject({ npub: env.gateway.npub, relays: [`ws://127.0.0.1:${env.relay.port}`] });
	});

	it("requests a task from another agent and outputs its result", async () => {
		const reviewer = await agent({ authorize: "accept-all" });
		reviewer.client.handle("invoice.review", (task) => ({ approved: (task.payload as { amount: number }).amount < 100 }));
		const output = run({
			resource: "task",
			operation: "request",
			peer: reviewer.npub,
			capability: "invoice.review",
			payload: '{"amount": 42}',
			options: { timeout: 20 },
		});
		const [[item]] = await pumping(output, reviewer.client);
		expect(item.json).toEqual({
			peer: reviewer.npub,
			capability: "invoice.review",
			status: "completed",
			output: { approved: true },
		});
		expect(item.pairedItem).toEqual({ item: 0 });
	});

	it("fails a request nobody answers with the gateway's explanation", async () => {
		const stranger = await agent();
		const output = run({
			resource: "task",
			operation: "request",
			peer: stranger.npub,
			capability: "x.y",
			payload: "{}",
			options: { timeout: 2 },
		});
		const error = await output.then(
			() => undefined,
			(e: unknown) => e,
		);
		expect(error).toBeInstanceOf(NodeApiError);
		expect((error as NodeApiError).description).toContain("allowed this one");
		expect((error as NodeApiError).httpCode).toBe("504");
	}, 20_000);

	it("refuses a payload that is not JSON before calling the gateway", async () => {
		await expect(
			run({ resource: "task", operation: "request", peer: toNpub(generateKeypair().publicKey), capability: "x", payload: "{nope" }),
		).rejects.toThrow("Payload is not valid JSON");
	});

	it("sends a message, and refuses an automated reply whose depth is missing", async () => {
		const reader = await agent();
		const [[sent]] = await run({
			resource: "message",
			operation: "send",
			peer: reader.npub,
			text: "Invoice 1234 is approved.",
			options: { contextId: "1234", autoDepth: 2 },
		});
		expect(sent.json).toMatchObject({ contextId: "1234", autoDepth: 2 });
		let found: unknown;
		for (let i = 0; i < 40 && !found; i++) {
			const { messages } = await reader.transport.poll({ since: 0 });
			found = messages.find((m) => m.eventId === sent.json.eventId);
			if (!found) {
				await new Promise((r) => setTimeout(r, 200));
			}
		}
		expect(found).toMatchObject({ text: "Invoice 1234 is approved.", contextId: "1234", autoDepth: 2 });

		// An expression that came out empty: refused, not sent as a person's message.
		await expect(
			run({ resource: "message", operation: "send", peer: reader.npub, text: "automated", options: { autoDepth: undefined } }),
		).rejects.toThrow("Automated Reply Depth is empty");
	});

	it("reads an agent's card and checks a capability against it", async () => {
		const reviewer = await agent({ authorize: "accept-all", identity: { org: "Acme Finance" } });
		reviewer.client.handle("invoice.review", () => ({}));
		await reviewer.client.start({ pollIntervalMs: 0 });
		const [[card]] = await run({
			resource: "agent",
			operation: "getCard",
			peer: reviewer.npub,
			options: { capability: "invoice.review", verifyNip05: false },
		});
		expect(card.json).toMatchObject({
			npub: reviewer.npub,
			found: true,
			org: "Acme Finance",
			capabilities: ["invoice.review"],
			supportsCapability: true,
		});
	});

	it("says how to fix a refused API key, and an unreachable gateway", async () => {
		const refused = await run(
			{ resource: "agent", operation: "getIdentity" },
			{ credentials: { url: env.gateway.url, apiKey: "agxg_wrong" } },
		).then(
			() => undefined,
			(e: unknown) => e as NodeApiError,
		);
		expect(refused).toBeInstanceOf(NodeApiError);
		expect(refused?.httpCode).toBe("401");
		expect(refused?.description).toContain("agx gateway key new");

		await expect(
			run({ resource: "agent", operation: "getIdentity" }, { credentials: { url: "http://127.0.0.1:9/", apiKey: env.key } }),
		).rejects.toThrow("Could not reach the agx gateway at http://127.0.0.1:9");
	});

	it("outputs the error as the item with Continue On Fail", async () => {
		const [[item]] = await run(
			{ resource: "agent", operation: "getIdentity" },
			{ credentials: { url: env.gateway.url, apiKey: "agxg_wrong" }, continueOnFail: true },
		);
		expect(item.json.error).toBe("A valid gateway API key is required");
		expect(item.pairedItem).toEqual({ item: 0 });
	});
});

describe("AGX Gateway Trigger: webhook lifecycle", () => {
	it("subscribes on activation, keeps the subscription, and removes it on deactivation", async () => {
		const allowed = toNpub(generateKeypair().publicKey);
		const n8n = await host({ events: ["task"], capabilities: "invoice.review, invoice.approve", allowedPeers: allowed });
		expect(await n8n.checkExists()).toBe(false);
		await n8n.activate();
		const id = String(n8n.staticData.subscriptionId);
		const shown = (await (await gatewayApi(`/v1/subscriptions/${id}`)).json()) as IDataObject;
		expect(shown).toMatchObject({
			url: n8n.url,
			label: "n8n: Invoice review",
			events: ["task"],
			capabilities: ["invoice.review", "invoice.approve"],
			acceptAll: false,
			maxTaskAgeSec: 600,
			resultTimeoutSec: 120,
		});
		expect(typeof n8n.staticData.secret).toBe("string");
		expect(await n8n.checkExists()).toBe(true);

		expect(await n8n.delete()).toBe(true);
		expect((await gatewayApi(`/v1/subscriptions/${id}`)).status).toBe(404);
		expect(n8n.staticData.subscriptionId).toBeUndefined();
		// Deactivating again, or after the gateway lost it, is not an error.
		expect(await n8n.delete()).toBe(true);
	});

	it("replaces the subscription when the node's settings change", async () => {
		const allowed = toNpub(generateKeypair().publicKey);
		const n8n = await host({ events: ["task"], capabilities: "invoice.review", allowedPeers: allowed });
		await n8n.activate();
		const first = String(n8n.staticData.subscriptionId);
		n8n.setParams({ events: ["task"], capabilities: "invoice.review, invoice.void", allowedPeers: allowed });
		expect(await n8n.checkExists()).toBe(false);
		expect((await gatewayApi(`/v1/subscriptions/${first}`)).status).toBe(404);
		await n8n.create();
		expect(n8n.staticData.subscriptionId).not.toBe(first);
	});

	it("subscribes again when the gateway no longer has the subscription", async () => {
		const n8n = await host({ events: ["message"], acceptAll: true });
		await n8n.activate();
		const id = String(n8n.staticData.subscriptionId);
		expect((await gatewayApi(`/v1/subscriptions/${id}`, { method: "DELETE" })).status).toBe(204);
		expect(await n8n.checkExists()).toBe(false);
		expect(n8n.staticData.secret).toBeUndefined();
	});

	it("reports the gateway's reason when it refuses the subscription", async () => {
		// Default-deny: a task subscription nobody could reach is refused.
		const n8n = await host({ events: ["task"], capabilities: "invoice.review", allowedPeers: "" });
		await expect(n8n.activate()).rejects.toThrow("No agent is allowed to reach this webhook");
	});
});

describe("AGX Gateway Trigger: deliveries", () => {
	it("runs the workflow for an allowed agent's task and sends what it ends with back as the result", async () => {
		const requester = await agent();
		const n8n = await host(
			{ events: ["task"], capabilities: "invoice.check", allowedPeers: requester.npub },
			(items) => [{ json: { reviewed: (items[0].json.payload as { id: number }).id, by: "n8n" } }],
		);
		await n8n.activate();
		const result = requester.client.request(env.gateway.npub, "invoice.check", { id: 7 }, { timeoutMs: 20_000 });
		await expect(pumping(result, requester.client)).resolves.toEqual({ reviewed: 7, by: "n8n" });
		expect(n8n.runs).toHaveLength(1);
		expect(n8n.runs[0].json).toMatchObject({
			event: "task",
			capability: "invoice.check",
			payload: { id: 7 },
			from: requester.npub,
			fromPubkey: requester.publicKey,
		});
	});

	it("sends every item back with Result: All Items", async () => {
		const requester = await agent();
		const n8n = await host(
			{ events: ["task"], capabilities: "invoice.split", allowedPeers: requester.npub, options: { result: "allItems" } },
			() => [{ json: { line: 1 } }, { json: { line: 2 } }],
		);
		await n8n.activate();
		const result = requester.client.request(env.gateway.npub, "invoice.split", {}, { timeoutMs: 20_000 });
		await expect(pumping(result, requester.client)).resolves.toEqual([{ line: 1 }, { line: 2 }]);
	});

	it("never starts the workflow for an agent the node does not allow", async () => {
		const stranger = await agent();
		const n8n = await host({
			events: ["task"],
			capabilities: "invoice.deny",
			allowedPeers: toNpub(generateKeypair().publicKey),
		});
		await n8n.activate();
		const result = stranger.client.request(env.gateway.npub, "invoice.deny", {}, { timeoutMs: 3_000 });
		await expect(pumping(result, stranger.client)).rejects.toThrow(/timed out/);
		expect(n8n.requests).toHaveLength(0);
	}, 15_000);

	it("reports a failed workflow to the requester as `handler failed`", async () => {
		const requester = await agent();
		const n8n = await host({ events: ["task"], capabilities: "invoice.fail", allowedPeers: requester.npub }, () => {
			throw new Error("db.internal:5432 refused");
		});
		await n8n.activate();
		const result = requester.client.request(env.gateway.npub, "invoice.fail", {}, { timeoutMs: 20_000 });
		await expect(pumping(result, requester.client)).rejects.toThrow("handler failed");
	});

	it("starts the workflow for an allowed agent's message, with the depth a reply declares", async () => {
		const sender = await agent();
		const n8n = await host({ events: ["message"], allowedPeers: sender.npub });
		await n8n.activate();
		const sent = await sender.transport.publishMessage(env.gateway.npub, {
			text: "hello n8n",
			contextId: "thread-9",
			contentType: DEFAULT_CONTENT_TYPE,
			autoDepth: 2,
		});
		expect(sent.ok).toBe(true);
		const delivered = await waitFor(() => n8n.runs.find((r) => r.json.text === "hello n8n"));
		expect(delivered.json).toMatchObject({
			event: "message",
			from: sender.npub,
			allowed: true,
			contextId: "thread-9",
			autoDepth: 2,
			replyAutoDepth: 3,
		});
		expect(n8n.requests.at(-1)?.status).toBe(200);
	});

	it("refuses a request that the gateway did not sign, without starting the workflow", async () => {
		const n8n = await host({ events: ["message"], acceptAll: true });
		await n8n.activate();
		const secret = String(n8n.staticData.secret);
		const body = JSON.stringify({ event: "message", text: "forged", from: toNpub(generateKeypair().publicKey) });
		const now = Math.floor(Date.now() / 1000);
		const sign = (timestamp: number, signed: string, key = secret) =>
			`v1=${createHmac("sha256", key).update(`${timestamp}.${signed}`).digest("hex")}`;
		const post = (headers: Record<string, string>, payload = body) =>
			fetch(n8n.url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: payload });

		const cases: Record<string, string>[] = [
			{},
			{ "x-agx-timestamp": String(now), "x-agx-signature": "v1=00" },
			{ "x-agx-timestamp": String(now), "x-agx-signature": sign(now, body, "another secret") },
			// Signed, but over different bytes.
			{ "x-agx-timestamp": String(now), "x-agx-signature": sign(now, body.replace("forged", "edited")) },
			// Signed long ago: a replay.
			{ "x-agx-timestamp": String(now - 3600), "x-agx-signature": sign(now - 3600, body) },
		];
		for (const headers of cases) {
			const res = await post(headers);
			expect(res.status).toBe(401);
		}
		expect(n8n.runs).toHaveLength(0);

		// The same request, signed as the gateway signs it, gets through.
		const ok = await post({ "x-agx-timestamp": String(now), "x-agx-signature": sign(now, body) });
		expect(ok.status).toBe(200);
		expect(n8n.runs).toHaveLength(1);
	});
});
