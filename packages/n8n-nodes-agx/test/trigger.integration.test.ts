import { DEFAULT_CONTENT_TYPE } from "@nostr-agx/core";
import { localSigner, NostrTransport, toNpub } from "@nostr-agx/nostr";
import type { IDataObject, ITriggerResponse } from "n8n-workflow";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { AgxTrigger } from "../nodes/AgxTrigger/AgxTrigger.node";
import { __resetManualRunClaimsForTests } from "../nodes/shared/trigger-state";
import {
	finishedRun,
	newAgent,
	peerClient,
	pumpUntil,
	relayUrl,
	type RunningRelay,
	startTestRelay,
	triggerContext,
	waitFor,
} from "./helpers";

let relay: RunningRelay;
beforeAll(async () => {
	relay = await startTestRelay();
});
afterAll(async () => {
	await relay.close();
});

const open: ITriggerResponse[] = [];
beforeEach(() => __resetManualRunClaimsForTests());
afterEach(async () => {
	for (const response of open.splice(0)) {
		await response.closeFunction?.();
	}
});

async function startTrigger(ctx: ReturnType<typeof triggerContext>["ctx"]) {
	const response = await new AgxTrigger().trigger.call(ctx);
	open.push(response);
	if (response.manualTriggerFunction) {
		await response.manualTriggerFunction();
	}
	return response;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("AGX Trigger: task requests", () => {
	it("runs the workflow for an allowed agent's task and sends its output back", async () => {
		const n8nAgent = newAgent(relay);
		const requester = newAgent(relay);
		const { ctx, emitted, staticData } = triggerContext({
			credentials: n8nAgent.credentials,
			params: {
				events: ["task"],
				capabilities: "invoice.review",
				allowedPeers: toNpub(requester.publicKey),
				options: { pollInterval: 1 },
			},
		});
		await startTrigger(ctx);

		const client = await peerClient(relay, requester);
		const result = client.request(n8nAgent.publicKey, "invoice.review", { amount: 4200 }, {
			timeoutMs: 20_000,
		});
		const run = pumpUntil(result, [client]);

		const event = await waitFor(() => emitted[0]);
		expect(event.json).toMatchObject({
			event: "task",
			capability: "invoice.review",
			payload: { amount: 4200 },
			from: toNpub(requester.publicKey),
			fromPubkey: requester.publicKey,
		});
		expect(typeof event.json.sentAt).toBe("string");
		// Claimed before the emit, so the save that goes with it carries the claim.
		const claimed = Object.keys((staticData.agx as { claimed: IDataObject }).claimed);
		expect(claimed).toHaveLength(1);

		event.done?.resolve(finishedRun([{ approved: true, reviewer: "n8n" }]));
		await expect(run).resolves.toEqual({ approved: true, reviewer: "n8n" });
	});

	it("gives a requester that is not allowed no reply, and never runs the workflow", async () => {
		const n8nAgent = newAgent(relay);
		const allowed = newAgent(relay);
		const stranger = newAgent(relay);
		const { ctx, emitted } = triggerContext({
			credentials: n8nAgent.credentials,
			params: {
				events: ["task"],
				capabilities: "invoice.review",
				allowedPeers: allowed.publicKey,
				options: { pollInterval: 1 },
			},
		});
		await startTrigger(ctx);
		const client = await peerClient(relay, stranger);
		const result = client.request(n8nAgent.publicKey, "invoice.review", {}, { timeoutMs: 4000 });
		await expect(pumpUntil(result, [client])).rejects.toThrow(/timed out/);
		expect(emitted).toHaveLength(0);
	});

	it("reports a failed execution as `handler failed`, or verbatim when forwarding errors", async () => {
		for (const forwardErrors of [false, true]) {
			const n8nAgent = newAgent(relay);
			const requester = newAgent(relay);
			const { ctx, emitted } = triggerContext({
				credentials: n8nAgent.credentials,
				params: {
					events: ["task"],
					capabilities: "invoice.review",
					allowedPeers: requester.publicKey,
					options: { pollInterval: 1, forwardErrors },
				},
			});
			await startTrigger(ctx);
			const client = await peerClient(relay, requester);
			const result = client.request(n8nAgent.publicKey, "invoice.review", {}, { timeoutMs: 20_000 });
			const run = pumpUntil(result, [client]);
			const event = await waitFor(() => emitted[0]);
			event.done?.resolve(finishedRun([], "getaddrinfo ENOTFOUND db.internal"));
			await expect(run).rejects.toThrow(
				forwardErrors ? "getaddrinfo ENOTFOUND db.internal" : /^handler failed$/,
			);
		}
	});

	it("fails the task when the workflow does not finish within the result timeout", async () => {
		const n8nAgent = newAgent(relay);
		const requester = newAgent(relay);
		const { ctx, emitted } = triggerContext({
			credentials: n8nAgent.credentials,
			params: {
				events: ["task"],
				capabilities: "invoice.review",
				allowedPeers: requester.publicKey,
				options: { pollInterval: 1, resultTimeout: 1 },
			},
		});
		await startTrigger(ctx);
		const client = await peerClient(relay, requester);
		const result = client.request(n8nAgent.publicKey, "invoice.review", {}, { timeoutMs: 20_000 });
		await expect(pumpUntil(result, [client])).rejects.toThrow(/did not finish in time/);
		expect(emitted).toHaveLength(1);
	});

	it("does not run a task again after a restart (a workflow save)", async () => {
		const n8nAgent = newAgent(relay);
		const requester = newAgent(relay);
		const staticData: IDataObject = {};
		const params = {
			events: ["task"],
			capabilities: "invoice.review",
			allowedPeers: requester.publicKey,
			options: { pollInterval: 1 },
		};
		const first = triggerContext({ credentials: n8nAgent.credentials, params, staticData });
		const firstResponse = await startTrigger(first.ctx);
		const client = await peerClient(relay, requester);
		const result = client.request(n8nAgent.publicKey, "invoice.review", {}, { timeoutMs: 20_000 });
		const run = pumpUntil(result, [client]);
		const event = await waitFor(() => first.emitted[0]);
		event.done?.resolve(finishedRun([{ ok: 1 }]));
		await expect(run).resolves.toEqual({ ok: 1 });
		await firstResponse.closeFunction?.();

		// n8n hands the restarted trigger the static data the emit saved.
		const second = triggerContext({
			credentials: n8nAgent.credentials,
			params,
			staticData: JSON.parse(JSON.stringify(staticData)),
		});
		await startTrigger(second.ctx);
		await sleep(3000);
		expect(second.emitted).toHaveLength(0);
	});

	it("handles one task per manual test run, and leaves the next for the next run", async () => {
		const n8nAgent = newAgent(relay);
		const requester = newAgent(relay);
		const params = {
			events: ["task"],
			capabilities: "invoice.review",
			allowedPeers: requester.publicKey,
			options: { pollInterval: 1 },
		};
		const client = await peerClient(relay, requester);
		const a = client.request(n8nAgent.publicKey, "invoice.review", { n: 1 }, { timeoutMs: 30_000 });
		const b = client.request(n8nAgent.publicKey, "invoice.review", { n: 2 }, { timeoutMs: 30_000 });
		const both = pumpUntil(Promise.allSettled([a, b]), [client]);
		// Both requests in the inbox before the first run polls it, so they
		// arrive in one batch.
		await waitFor(
			() =>
				relay
					.events()
					.filter((e) => e.tags.some((t) => t[0] === "p" && t[1] === n8nAgent.publicKey))
					.length >= 2,
		);

		const firstRun = triggerContext({ credentials: n8nAgent.credentials, params, mode: "manual" });
		const firstResponse = await startTrigger(firstRun.ctx);
		const first = await waitFor(() => firstRun.emitted[0]);
		await sleep(2500);
		expect(firstRun.emitted).toHaveLength(1);
		// n8n closes a manual trigger as soon as it emits, and only then finishes
		// the execution: the result must still go out after the close.
		await firstResponse.closeFunction?.();
		first.done?.resolve(finishedRun([{ run: 1 }]));

		const secondRun = triggerContext({ credentials: n8nAgent.credentials, params, mode: "manual" });
		await startTrigger(secondRun.ctx);
		const second = await waitFor(() => secondRun.emitted[0]);
		expect((second.json.payload as IDataObject).n).not.toBe((first.json.payload as IDataObject).n);
		second.done?.resolve(finishedRun([{ run: 2 }]));

		const settled = await both;
		expect(settled.map((s) => s.status)).toEqual(["fulfilled", "fulfilled"]);
		expect(
			settled.map((s) => (s.status === "fulfilled" ? s.value : null)).sort((x, y) =>
				JSON.stringify(x).localeCompare(JSON.stringify(y)),
			),
		).toEqual([{ run: 1 }, { run: 2 }]);
	});
});

describe("AGX Trigger: messages", () => {
	async function send(from: { secretKey: Uint8Array }, to: string, text: string, autoDepth?: number) {
		const transport = await NostrTransport.create({
			signer: localSigner(from.secretKey),
			relays: [relayUrl(relay)],
		});
		const res = await transport.publishMessage(to, {
			text,
			contextId: "thread-7",
			contentType: DEFAULT_CONTENT_TYPE,
			autoDepth,
		});
		expect(res.ok).toBe(true);
	}

	it("starts the workflow for an allowed agent's message, with the depth a reply declares", async () => {
		const n8nAgent = newAgent(relay);
		const sender = newAgent(relay);
		const stranger = newAgent(relay);
		const { ctx, emitted } = triggerContext({
			credentials: n8nAgent.credentials,
			params: {
				events: ["message"],
				allowedPeers: sender.publicKey,
				options: { pollInterval: 1 },
			},
		});
		await startTrigger(ctx);
		await send(stranger, n8nAgent.publicKey, "let me in");
		await send(sender, n8nAgent.publicKey, "Invoice 1234 is ready.", 2);
		const event = await waitFor(() => emitted[0]);
		expect(event.json).toMatchObject({
			event: "message",
			from: toNpub(sender.publicKey),
			allowed: true,
			text: "Invoice 1234 is ready.",
			contextId: "thread-7",
			autoDepth: 2,
			replyAutoDepth: 3,
		});
		await sleep(1500);
		expect(emitted).toHaveLength(1);
	});

	it("leaves task requests to the workflow that serves them, with no reply", async () => {
		const n8nAgent = newAgent(relay);
		const requester = newAgent(relay);
		const { ctx, emitted } = triggerContext({
			credentials: n8nAgent.credentials,
			params: {
				events: ["message"],
				allowedPeers: requester.publicKey,
				options: { pollInterval: 1 },
			},
		});
		await startTrigger(ctx);
		const client = await peerClient(relay, requester);
		const result = client.request(n8nAgent.publicKey, "invoice.review", {}, { timeoutMs: 3000 });
		await expect(pumpUntil(result, [client])).rejects.toThrow(/timed out/);
		await send(requester, n8nAgent.publicKey, "a plain one");
		const event = await waitFor(() => emitted[0]);
		expect(event.json.text).toBe("a plain one");
		expect(emitted).toHaveLength(1);
	});

	it("emits one message per manual test run, though a batch holds several", async () => {
		const n8nAgent = newAgent(relay);
		const sender = newAgent(relay);
		const params = {
			events: ["message"],
			allowedPeers: sender.publicKey,
			options: { pollInterval: 1 },
		};
		await send(sender, n8nAgent.publicKey, "first");
		await send(sender, n8nAgent.publicKey, "second");

		// Unlike a task's, a message's emit does not wait for the execution, so
		// both would go out in the same pump — and n8n would run the test with
		// the first and drop the second.
		const firstRun = triggerContext({ credentials: n8nAgent.credentials, params, mode: "manual" });
		const firstResponse = await startTrigger(firstRun.ctx);
		await waitFor(() => firstRun.emitted[0]);
		await sleep(1500);
		expect(firstRun.emitted).toHaveLength(1);
		await firstResponse.closeFunction?.();

		const secondRun = triggerContext({ credentials: n8nAgent.credentials, params, mode: "manual" });
		await startTrigger(secondRun.ctx);
		await waitFor(() => secondRun.emitted[0]);
		expect(
			[firstRun.emitted[0].json.text, secondRun.emitted[0].json.text].sort(),
		).toEqual(["first", "second"]);
	});

	it("includes unlisted senders, marked as such, only when asked to", async () => {
		const n8nAgent = newAgent(relay);
		const stranger = newAgent(relay);
		const { ctx, emitted } = triggerContext({
			credentials: n8nAgent.credentials,
			params: {
				events: ["message"],
				allowedPeers: "",
				options: { pollInterval: 1, includeUnlisted: true },
			},
		});
		await startTrigger(ctx);
		await send(stranger, n8nAgent.publicKey, "hello?");
		const event = await waitFor(() => emitted[0]);
		expect(event.json).toMatchObject({ allowed: false, text: "hello?", autoDepth: 0, replyAutoDepth: 1 });
	});
});

describe("AGX Trigger: configuration", () => {
	it("refuses to start when nobody could ever reach it", async () => {
		const n8nAgent = newAgent(relay);
		const { ctx } = triggerContext({
			credentials: n8nAgent.credentials,
			params: { events: ["task"], capabilities: "invoice.review", allowedPeers: "" },
		});
		await expect(new AgxTrigger().trigger.call(ctx)).rejects.toThrow(/No agent is allowed/);
	});

	it("names a malformed allowlist entry", async () => {
		const n8nAgent = newAgent(relay);
		const { ctx } = triggerContext({
			credentials: n8nAgent.credentials,
			params: { events: ["task"], capabilities: "invoice.review", allowedPeers: "alice" },
		});
		await expect(new AgxTrigger().trigger.call(ctx)).rejects.toThrow(/alice/);
	});
});
