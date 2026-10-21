import { createHmac } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { runtime } from "../runtime.js";
import { AGX_CLI_VERSION } from "../version.js";
import type { Subscription } from "./subscriptions.js";

/**
 * Delivering events to webhooks.
 *
 * Every delivery is signed with the subscription's secret, so a webhook can
 * tell the gateway's POSTs from anyone else's: `x-agx-signature` is
 * `v1=<hex HMAC-SHA256 of "<x-agx-timestamp>.<body>">`. A receiver checks the
 * signature over the exact bytes it received and rejects a timestamp that is
 * not recent, so a captured delivery cannot be replayed later.
 *
 * Redirects are not followed: a signed task, with its payload, goes only to the
 * URL the subscription names.
 */

export const SIGNATURE_HEADER = "x-agx-signature";
export const TIMESTAMP_HEADER = "x-agx-timestamp";

export function signDelivery(secret: string, timestamp: number, body: string): string {
	return `v1=${createHmac("sha256", secret).update(`${timestamp}.${body}`, "utf8").digest("hex")}`;
}

export type DeliveryOutcome =
	| { kind: "response"; status: number; body: unknown }
	| { kind: "timeout" }
	/** The answer was larger than {@link MAX_ANSWER_BYTES}. */
	| { kind: "oversized" }
	/** `sent`: the connection was made, so the webhook may have the event. */
	| { kind: "unreachable"; error: string; sent: boolean };

/** Errors from a connection that was made and then broke, so the webhook may
 * have the event. Anything else (refused, no such host, a bad certificate)
 * failed before the request went out. */
const BROKE_OFF = new Set([
	"ECONNRESET",
	"ECONNABORTED",
	"EPIPE",
	"UND_ERR_SOCKET",
	"UND_ERR_CLOSED",
	"UND_ERR_HEADERS_TIMEOUT",
	"UND_ERR_BODY_TIMEOUT",
]);

function isTimeout(error: unknown): boolean {
	return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

/** The most of a webhook's answer that is read. A task's result has to fit in
 * one encrypted Nostr message, which is far smaller. */
export const MAX_ANSWER_BYTES = 1024 * 1024;

class OversizedAnswer extends Error {}

/**
 * POST with Node's http client rather than `fetch`, which gives up after five
 * minutes without response headers whatever its signal allows, while a
 * workflow may take an hour. Redirects are not followed, and at most
 * {@link MAX_ANSWER_BYTES} of the answer is read.
 */
function post(
	url: URL,
	headers: Record<string, string>,
	body: string,
	signal: AbortSignal,
): Promise<{ status: number; text: string }> {
	return new Promise((resolve, reject) => {
		const send = url.protocol === "https:" ? httpsRequest : httpRequest;
		const req = send(
			url,
			{ method: "POST", headers: { ...headers, "content-length": String(Buffer.byteLength(body)) }, signal },
			(res) => {
				const chunks: Buffer[] = [];
				let size = 0;
				res.on("data", (chunk: Buffer) => {
					size += chunk.length;
					if (size > MAX_ANSWER_BYTES) {
						req.destroy(new OversizedAnswer());
						return;
					}
					chunks.push(chunk);
				});
				res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
				res.on("error", reject);
			},
		);
		req.on("error", reject);
		req.end(body);
	});
}

/** POST one event to a subscription's webhook and wait for its answer. */
export async function deliver(
	subscription: Subscription,
	event: Record<string, unknown>,
	eventId: string,
	timeoutMs: number,
): Promise<DeliveryOutcome> {
	const body = JSON.stringify(event);
	const timestamp = Math.floor(runtime().now() / 1000);
	const signal = AbortSignal.timeout(timeoutMs);
	let answer: { status: number; text: string };
	try {
		answer = await post(
			new URL(subscription.url),
			{
				"content-type": "application/json",
				"user-agent": `agx-gateway/${AGX_CLI_VERSION}`,
				"x-agx-subscription": subscription.id,
				"x-agx-event": String(event.event),
				"x-agx-delivery": eventId,
				[TIMESTAMP_HEADER]: String(timestamp),
				[SIGNATURE_HEADER]: signDelivery(subscription.secret, timestamp, body),
			},
			body,
			signal,
		);
	} catch (error) {
		if (error instanceof OversizedAnswer) {
			return { kind: "oversized" };
		}
		// Aborted, before or after the answer began: the webhook is still busy.
		if (signal.aborted || isTimeout(error)) {
			return { kind: "timeout" };
		}
		const code = (error as { code?: unknown }).code;
		return {
			kind: "unreachable",
			error: error instanceof Error ? error.message : String(error),
			sent: typeof code === "string" && BROKE_OFF.has(code),
		};
	}
	let parsed: unknown = answer.text;
	if (answer.text) {
		try {
			parsed = JSON.parse(answer.text);
		} catch {
			// Not JSON: the text is the answer.
		}
	}
	return { kind: "response", status: answer.status, body: answer.text ? parsed : null };
}

/** Whether a failed delivery is worth trying again: nothing answered, or a
 * proxy in front of the webhook did. A webhook's own error is not retried —
 * the workflow may have run. */
function retryable(outcome: DeliveryOutcome): boolean {
	return (
		outcome.kind === "unreachable" ||
		(outcome.kind === "response" && [429, 502, 503, 504].includes(outcome.status))
	);
}

interface Queued {
	subscription: Subscription;
	event: Record<string, unknown>;
	eventId: string;
	attempt: number;
}

export interface DeliveryQueueOptions {
	/** Deliveries in flight at once, in all. */
	concurrency?: number;
	/** Deliveries in flight at once to one webhook. */
	perSubscription?: number;
	/** Waits before each retry, in ms; their count is the number of retries. */
	retryDelaysMs?: number[];
	/** Most deliveries waiting for one webhook; past it, its oldest is dropped. */
	maxQueuedPerSubscription?: number;
	timeoutMs?: number;
	onFailure?: (subscription: Subscription, eventId: string, detail: string) => void;
}

/**
 * Messages and receipts are delivered in the background: unlike a task, the
 * gateway does not need the webhook's answer, and waiting for it would hold up
 * the inbox while a workflow runs. They are already in the profile's message
 * store, so one that cannot be delivered is not lost from `agx inbox`.
 *
 * Each webhook has its own slots and its own share of the queue, so one that
 * is down or slow does not hold up the others.
 */
export class DeliveryQueue {
	private readonly waiting: Queued[] = [];
	private active = 0;
	private readonly activeBySubscription = new Map<string, number>();
	private readonly queuedBySubscription = new Map<string, number>();
	private readonly concurrency: number;
	private readonly perSubscription: number;
	private readonly retryDelaysMs: number[];
	private readonly maxQueuedPerSubscription: number;
	private readonly timeoutMs: number;
	private idleWaiters: (() => void)[] = [];
	/** Deliveries waiting out a retry delay, outside the in-flight slots. */
	private retrying = 0;

	constructor(private readonly options: DeliveryQueueOptions = {}) {
		this.concurrency = options.concurrency ?? 16;
		this.perSubscription = options.perSubscription ?? 2;
		this.retryDelaysMs = options.retryDelaysMs ?? [2_000, 10_000, 30_000];
		this.maxQueuedPerSubscription = options.maxQueuedPerSubscription ?? 500;
		// A message's webhook answers as soon as it has the event (n8n's
		// "onReceived"); it does not wait for the workflow.
		this.timeoutMs = options.timeoutMs ?? 30_000;
	}

	enqueue(subscription: Subscription, event: Record<string, unknown>, eventId: string): void {
		this.push({ subscription, event, eventId, attempt: 0 });
		this.drain();
	}

	/** Resolves once nothing is waiting or in flight (tests, shutdown). */
	idle(): Promise<void> {
		if (this.isIdle()) {
			return Promise.resolve();
		}
		return new Promise((resolve) => this.idleWaiters.push(resolve));
	}

	/** Deliveries not yet made: waiting, in flight, or waiting to retry. */
	pending(): number {
		return this.waiting.length + this.active + this.retrying;
	}

	private isIdle(): boolean {
		return this.pending() === 0;
	}

	private push(item: Queued): void {
		const id = item.subscription.id;
		const queued = this.queuedBySubscription.get(id) ?? 0;
		if (queued >= this.maxQueuedPerSubscription) {
			const oldest = this.waiting.findIndex((other) => other.subscription.id === id);
			if (oldest >= 0) {
				const [dropped] = this.waiting.splice(oldest, 1);
				this.options.onFailure?.(dropped.subscription, dropped.eventId, "dropped: too many deliveries waiting");
				this.queuedBySubscription.set(id, queued - 1);
			}
		}
		this.waiting.push(item);
		this.queuedBySubscription.set(id, (this.queuedBySubscription.get(id) ?? 0) + 1);
	}

	private drain(): void {
		for (let i = 0; i < this.waiting.length && this.active < this.concurrency; ) {
			const item = this.waiting[i];
			const id = item.subscription.id;
			const busy = this.activeBySubscription.get(id) ?? 0;
			if (busy >= this.perSubscription) {
				i += 1;
				continue;
			}
			this.waiting.splice(i, 1);
			this.queuedBySubscription.set(id, (this.queuedBySubscription.get(id) ?? 1) - 1);
			this.active += 1;
			this.activeBySubscription.set(id, busy + 1);
			void this.run(item).finally(() => {
				this.active -= 1;
				const left = (this.activeBySubscription.get(id) ?? 1) - 1;
				if (left > 0) {
					this.activeBySubscription.set(id, left);
				} else {
					this.activeBySubscription.delete(id);
				}
				if ((this.queuedBySubscription.get(id) ?? 0) <= 0) {
					this.queuedBySubscription.delete(id);
				}
				this.drain();
				this.settle();
			});
		}
	}

	private settle(): void {
		if (this.isIdle()) {
			for (const resolve of this.idleWaiters.splice(0)) {
				resolve();
			}
		}
	}

	private async run(item: Queued): Promise<void> {
		const outcome = await deliver(item.subscription, item.event, item.eventId, this.timeoutMs);
		if (outcome.kind === "response" && outcome.status >= 200 && outcome.status < 300) {
			return;
		}
		const detail =
			outcome.kind === "response"
				? `HTTP ${outcome.status}`
				: outcome.kind === "timeout"
					? "no answer in time"
					: outcome.kind === "oversized"
						? `an answer larger than ${MAX_ANSWER_BYTES} bytes`
						: outcome.error;
		const delay = this.retryDelaysMs[item.attempt];
		if (!retryable(outcome) || delay === undefined) {
			this.options.onFailure?.(item.subscription, item.eventId, detail);
			return;
		}
		item.attempt += 1;
		// Waited out of its slot: a webhook that is down holds up no other.
		this.retrying += 1;
		void runtime()
			.sleep(delay)
			.catch(() => undefined)
			.then(() => {
				this.retrying -= 1;
				this.push(item);
				this.drain();
				this.settle();
			});
	}
}
