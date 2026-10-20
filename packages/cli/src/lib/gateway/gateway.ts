import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
	AgxClient,
	type AgxIncomingMessage,
	type AgxIncomingReceipt,
	type AgxLogger,
	AgxPublicError,
	AgxTaskDeclined,
	AutoReplyGuard,
	DEFAULT_CONTENT_TYPE,
	parseTaskEnvelope,
	type Task,
	TASK_CONTENT_TYPE,
} from "@nostr-agx/core";
import { toNpub } from "@nostr-agx/nostr";
import { effectiveProfile } from "../config.js";
import { loadIdentity } from "../identity.js";
import { createCollector } from "../inbox.js";
import { acquireLock } from "../lock.js";
import { profileDir } from "../paths.js";
import { toHexPubkey } from "../peer.js";
import { FileSeenStore, loadState, updateState } from "../state.js";
import { MessageStore } from "../store/message-store.js";
import { createTransport } from "../transport.js";
import { AGX_CLI_VERSION } from "../version.js";
import { DeliveryQueue, deliver } from "./delivery.js";
import { messageEvent, receiptEvent, taskEvent } from "./events.js";
import { ApiError, readJson, sendError, sendJson } from "./http.js";
import { verifyGatewayKey } from "./keys.js";
import { type OperationDeps, readCard, requestTask, sendMessage } from "./operations.js";
import { Requester } from "./requester.js";
import {
	parseSubscriptionInput,
	SubscriptionError,
	SubscriptionStore,
	viewOf,
} from "./subscriptions.js";

/**
 * `agx gateway`: this profile's agent behind an HTTP API, for tools that can
 * make HTTP calls but cannot speak Nostr themselves — n8n Cloud's verified
 * nodes, Make, Zapier.
 *
 * Outbound, an API client requests tasks, sends messages and reads Agent Cards.
 * Inbound, it subscribes a webhook, and the gateway delivers what arrives for
 * this agent to it: messages and receipts in the background, and task requests
 * synchronously — the webhook's answer is the task's result.
 *
 * The gateway holds the profile's secret key and lock, as `agx serve` does,
 * and keeps the same durable state: the cursor, the replay store, and the
 * message store `agx inbox` reads.
 */

export interface GatewayOptions {
	profile: string;
	/** Interface to listen on. Default 127.0.0.1: put a TLS proxy in front. */
	host?: string;
	/** Port to listen on; 0 picks a free one. Default 8787. */
	port?: number;
	/** Inbox poll interval, ms. Default 3000. */
	pollIntervalMs?: number;
	logger?: AgxLogger;
	/** One line per thing the gateway did, for its console. */
	log?: (line: string) => void;
	/** For tests: waits before each retry of a background delivery. */
	deliveryRetryDelaysMs?: number[];
}

export interface RunningGateway {
	url: string;
	port: number;
	npub: string;
	/** Resolves once background deliveries are done (tests). */
	idle(): Promise<void>;
	close(): Promise<void>;
}

export const DEFAULT_GATEWAY_PORT = 8787;

function nowSec(): number {
	return Math.floor(Date.now() / 1000);
}

function bearer(req: IncomingMessage): string {
	const header = req.headers.authorization ?? "";
	return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

export async function startGateway(options: GatewayOptions): Promise<RunningGateway> {
	const name = options.profile;
	const log = options.log ?? (() => undefined);
	const profile = effectiveProfile(name);
	const identity = loadIdentity(name);
	const releaseLock = acquireLock(name);
	let closed = false;
	try {
		const state = loadState(name);
		const transport = await createTransport(profile, identity, options.logger);
		const seen = new FileSeenStore(name);
		const store = new MessageStore(profileDir(name), undefined, { claimSpool: true });
		const allowed = new Set<string>();
		const refreshAllowed = () => {
			try {
				const current = effectiveProfile(name).allow.map((entry) => toHexPubkey(entry, "allowlist entry"));
				allowed.clear();
				for (const entry of current) {
					allowed.add(entry);
				}
			} catch {
				// Keep the last good list; the next poll tries again.
			}
		};
		refreshAllowed();
		const collector = createCollector({
			store,
			allowed,
			onError: (error) =>
				log(`A message could not be stored and will be retried: ${error instanceof Error ? error.message : String(error)}`),
		});
		const subscriptions = new SubscriptionStore(name);
		const queue = new DeliveryQueue({
			retryDelaysMs: options.deliveryRetryDelaysMs,
			onFailure: (subscription, eventId, detail) =>
				log(`DROP  delivery of ${eventId.slice(0, 8)} to ${subscription.id} failed: ${detail}`),
		});
		const requester = new Requester(transport, options.logger);
		const deps: OperationDeps = {
			npub: identity.npub,
			publicKey: identity.publicKey,
			relays: profile.relays,
			signer: identity.signer,
			transport,
			requester,
			guard: new AutoReplyGuard(),
		};

		const runTask = async (task: Task): Promise<unknown> => {
			const targets = subscriptions.forTask(task.capability, task.from, task.sentAt ?? nowSec());
			if (targets.length === 0) {
				// The subscription went away between authorization and now.
				throw new AgxTaskDeclined("no webhook serves it any more");
			}
			log(`TASK  ${task.capability} from ${toNpub(task.from)}`);
			for (const subscription of targets) {
				const outcome = await deliver(
					subscription,
					taskEvent(task),
					task.eventId ?? task.taskId,
					subscription.resultTimeoutSec * 1000,
				);
				if (outcome.kind === "timeout") {
					throw new AgxPublicError("the workflow did not finish in time");
				}
				if (outcome.kind === "unreachable" || outcome.status === 404 || outcome.status === 410) {
					// Gone or down: an older subscription for the same capability may
					// still answer (a test webhook n8n dropped, say).
					log(`SKIP  ${subscription.id}: ${outcome.kind === "unreachable" ? outcome.error : `HTTP ${outcome.status}`}`);
					continue;
				}
				if (outcome.status >= 200 && outcome.status < 300) {
					return outcome.body;
				}
				// n8n answers a failed execution with a bare 500; whatever went wrong
				// stays on this side, and the requester hears `handler failed`.
				throw new Error(`the webhook answered HTTP ${outcome.status}`);
			}
			throw new Error("no webhook for this capability could be reached");
		};

		const client = new AgxClient({
			transport,
			seen,
			logger: options.logger,
			identity: { org: profile.org ?? undefined, nip05: profile.nip05 },
			// First run: from now. The poll still reaches back the full lookback,
			// and what is too old for a webhook is filtered below.
			startCursor: state.cursor > 0 ? state.cursor : nowSec(),
			// A task request every webhook serving it considers too old: dropped
			// before authorization, with no receipt and no reply.
			ignore: (event) => {
				if ("receipt" in event || event.contentType !== TASK_CONTENT_TYPE) {
					return false;
				}
				const env = parseTaskEnvelope(event.text);
				if (env?.t !== "req" || subscriptions.forTask(env.capability, event.from).length === 0) {
					return false;
				}
				const sentAt = event.sentAt ?? event.createdAt;
				if (subscriptions.forTask(env.capability, event.from, sentAt).length > 0) {
					return false;
				}
				log(`OLD   ${env.capability} from ${toNpub(event.from)}: too old for every webhook serving it, ignored`);
				return true;
			},
			// Default-deny, per subscription: a task runs only for a webhook that
			// serves its capability and allows its sender.
			authorize: ({ from, capability }) => subscriptions.forTask(capability, from).length > 0,
			onMessage: (msg: AgxIncomingMessage) => {
				// Task traffic no webhook took — a denied or unserved request, a result
				// for the requesting client — is not a message for anyone.
				if (msg.contentType === TASK_CONTENT_TYPE) {
					return;
				}
				collector.onMessage(msg);
				for (const { subscription, allowed: ok } of subscriptions.forEvent("message", msg.from, msg.sentAt ?? msg.createdAt)) {
					queue.enqueue(subscription, messageEvent(msg, ok), msg.eventId);
				}
			},
			onReceipt: (receipt: AgxIncomingReceipt) => {
				collector.onReceipt(receipt);
				for (const { subscription, allowed: ok } of subscriptions.forEvent("receipt", receipt.from, receipt.sentAt ?? receipt.createdAt)) {
					queue.enqueue(subscription, receiptEvent(receipt, ok), receipt.eventId);
				}
			},
		});

		const registered = new Set<string>();
		const registerHandlers = () => {
			for (const capability of subscriptions.capabilities()) {
				if (!registered.has(capability)) {
					client.handle(capability, runTask);
					registered.add(capability);
				}
			}
		};
		registerHandlers();

		// The card lists what subscriptions that advertise serve, and is
		// republished when that changes.
		let advertised: string | null = null;
		const advertise = async () => {
			const capabilities = subscriptions.advertised();
			const key = capabilities.join("\n");
			if (key === advertised || (advertised === null && capabilities.length === 0) || !transport.advertise) {
				return;
			}
			try {
				await transport.advertise(capabilities, {
					org: profile.org ?? undefined,
					nip05: profile.nip05,
					payloadTypes: [DEFAULT_CONTENT_TYPE, TASK_CONTENT_TYPE],
				});
				advertised = key;
				log(`CARD  advertised ${capabilities.length ? capabilities.join(", ") : "no capabilities"}`);
			} catch (error) {
				log(`CARD  could not be published: ${error instanceof Error ? error.message : String(error)}`);
			}
		};

		await client.start({ pollIntervalMs: 0, advertise: false });
		await advertise();

		let cursor = state.cursor;
		const persist = () => {
			store.absorbSpool();
			store.flush();
			seen.flush();
			updateState(name, { cursor, lastPumpAt: new Date().toISOString() });
		};
		let wake: (() => void) | null = null;
		const pumpLoop = (async () => {
			const interval = options.pollIntervalMs ?? 3000;
			while (!closed) {
				try {
					refreshAllowed();
					store.absorbSpool();
					const result = await client.pump();
					if (result.complete) {
						cursor = result.cursor;
					}
					persist();
				} catch (error) {
					log(`poll failed: ${error instanceof Error ? error.message : String(error)}`);
				}
				if (!closed) {
					await new Promise<void>((resolve) => {
						const timer = setTimeout(resolve, interval);
						wake = () => {
							clearTimeout(timer);
							resolve();
						};
					});
					wake = null;
				}
			}
		})();

		const route = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
			const url = new URL(req.url ?? "/", "http://gateway");
			const method = req.method ?? "GET";
			const path = url.pathname.replace(/\/+$/, "") || "/";
			if (method === "GET" && path === "/v1/health") {
				sendJson(res, 200, { ok: true });
				return;
			}
			if (!path.startsWith("/v1/")) {
				throw new ApiError(404, "not_found", `No route for ${method} ${path}`);
			}
			const keyId = verifyGatewayKey(name, bearer(req));
			if (keyId === null) {
				res.setHeader("www-authenticate", 'Bearer realm="agx-gateway"');
				throw new ApiError(401, "unauthorized", "A valid gateway API key is required", "Create one with `agx gateway key new`, and send it as `Authorization: Bearer <key>`.");
			}
			if (method === "GET" && path === "/v1/identity") {
				sendJson(res, 200, {
					npub: identity.npub,
					pubkey: identity.publicKey,
					relays: profile.relays,
					org: profile.org,
					nip05: profile.nip05,
					gatewayVersion: AGX_CLI_VERSION,
				});
				return;
			}
			if (method === "POST" && path === "/v1/tasks") {
				sendJson(res, 200, await requestTask(deps, await readJson(req)));
				return;
			}
			if (method === "POST" && path === "/v1/messages") {
				sendJson(res, 200, await sendMessage(deps, await readJson(req)));
				return;
			}
			const agent = /^\/v1\/agents\/([^/]+)$/.exec(path);
			if (method === "GET" && agent) {
				sendJson(res, 200, await readCard(deps, decodeURIComponent(agent[1]), url.searchParams));
				return;
			}
			if (path === "/v1/subscriptions") {
				if (method === "GET") {
					sendJson(res, 200, { subscriptions: subscriptions.list().map(viewOf) });
					return;
				}
				if (method === "POST") {
					let input: ReturnType<typeof parseSubscriptionInput>;
					try {
						input = parseSubscriptionInput(await readJson(req));
					} catch (error) {
						if (error instanceof SubscriptionError) {
							throw new ApiError(400, "invalid_subscription", error.message);
						}
						throw error;
					}
					const subscription = subscriptions.create(input);
					registerHandlers();
					void advertise();
					log(`SUB   ${subscription.id} → ${subscription.url} (${subscription.events.join(", ")})`);
					// The secret is shown once, here: the webhook verifies deliveries with it.
					sendJson(res, 201, { ...viewOf(subscription), secret: subscription.secret });
					return;
				}
			}
			const one = /^\/v1\/subscriptions\/([^/]+)$/.exec(path);
			if (one) {
				const id = decodeURIComponent(one[1]);
				if (method === "GET") {
					const subscription = subscriptions.get(id);
					if (!subscription) {
						throw new ApiError(404, "not_found", `No subscription ${id}`);
					}
					sendJson(res, 200, viewOf(subscription));
					return;
				}
				if (method === "DELETE") {
					if (!subscriptions.delete(id)) {
						throw new ApiError(404, "not_found", `No subscription ${id}`);
					}
					void advertise();
					log(`UNSUB ${id}`);
					res.writeHead(204);
					res.end();
					return;
				}
			}
			throw new ApiError(404, "not_found", `No route for ${method} ${path}`);
		};

		const server: Server = createServer((req, res) => {
			route(req, res).catch((error: unknown) => {
				if (res.headersSent) {
					res.end();
					return;
				}
				if (error instanceof ApiError) {
					sendError(res, error);
					return;
				}
				log(`API error on ${req.method} ${req.url}: ${error instanceof Error ? error.message : String(error)}`);
				sendError(res, new ApiError(500, "internal_error", "The gateway could not complete the request"));
			});
		});
		// A task request waits for its result, up to an hour.
		server.requestTimeout = 0;
		server.headersTimeout = 60_000;
		const host = options.host ?? "127.0.0.1";
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(options.port ?? DEFAULT_GATEWAY_PORT, host, () => {
				server.off("error", reject);
				resolve();
			});
		});
		const port = (server.address() as AddressInfo).port;
		const shownHost = host.includes(":") ? `[${host}]` : host;

		return {
			url: `http://${shownHost === "0.0.0.0" ? "127.0.0.1" : shownHost}:${port}`,
			port,
			npub: identity.npub,
			idle: () => queue.idle(),
			close: async () => {
				if (closed) {
					return;
				}
				closed = true;
				(wake as (() => void) | null)?.();
				await new Promise<void>((resolve) => {
					server.close(() => resolve());
					server.closeAllConnections();
				});
				requester.stop();
				await Promise.race([pumpLoop, new Promise((resolve) => setTimeout(resolve, 10_000))]);
				await client.stop().catch(() => undefined);
				persist();
				releaseLock();
			},
		};
	} catch (error) {
		if (!closed) {
			releaseLock();
		}
		throw error;
	}
}
