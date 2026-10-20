import { createHmac } from "node:crypto";
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
	| { kind: "unreachable"; error: string };

/** POST one event to a subscription's webhook and wait for its answer. */
export async function deliver(
	subscription: Subscription,
	event: Record<string, unknown>,
	eventId: string,
	timeoutMs: number,
): Promise<DeliveryOutcome> {
	const body = JSON.stringify(event);
	const timestamp = Math.floor(runtime().now() / 1000);
	let response: Response;
	try {
		response = await runtime().fetch(subscription.url, {
			method: "POST",
			redirect: "manual",
			headers: {
				"content-type": "application/json",
				"user-agent": `agx-gateway/${AGX_CLI_VERSION}`,
				"x-agx-subscription": subscription.id,
				"x-agx-event": String(event.event),
				"x-agx-delivery": eventId,
				[TIMESTAMP_HEADER]: String(timestamp),
				[SIGNATURE_HEADER]: signDelivery(subscription.secret, timestamp, body),
			},
			body,
			signal: AbortSignal.timeout(timeoutMs),
		});
	} catch (error) {
		if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
			return { kind: "timeout" };
		}
		const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : "";
		return { kind: "unreachable", error: `${error instanceof Error ? error.message : String(error)}${cause}` };
	}
	let text: string;
	try {
		text = await response.text();
	} catch (error) {
		return { kind: "unreachable", error: error instanceof Error ? error.message : String(error) };
	}
	let parsed: unknown = text;
	if (text) {
		try {
			parsed = JSON.parse(text);
		} catch {
			// Not JSON: the text is the answer.
		}
	}
	return { kind: "response", status: response.status, body: text ? parsed : null };
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
	/** Deliveries in flight at once. */
	concurrency?: number;
	/** Waits before each retry, in ms; their count is the number of retries. */
	retryDelaysMs?: number[];
	/** Most deliveries waiting; past it the oldest is dropped. */
	maxQueued?: number;
	timeoutMs?: number;
	onFailure?: (subscription: Subscription, eventId: string, detail: string) => void;
}

/**
 * Messages and receipts are delivered in the background: unlike a task, the
 * gateway does not need the webhook's answer, and waiting for it would hold up
 * the inbox while a workflow runs. They are already in the profile's message
 * store, so one that cannot be delivered is not lost from `agx inbox`.
 */
export class DeliveryQueue {
	private readonly waiting: Queued[] = [];
	private active = 0;
	private readonly concurrency: number;
	private readonly retryDelaysMs: number[];
	private readonly maxQueued: number;
	private readonly timeoutMs: number;
	private idleWaiters: (() => void)[] = [];

	constructor(private readonly options: DeliveryQueueOptions = {}) {
		this.concurrency = options.concurrency ?? 4;
		this.retryDelaysMs = options.retryDelaysMs ?? [2_000, 10_000, 30_000];
		this.maxQueued = options.maxQueued ?? 1_000;
		this.timeoutMs = options.timeoutMs ?? 120_000;
	}

	enqueue(subscription: Subscription, event: Record<string, unknown>, eventId: string): void {
		if (this.waiting.length >= this.maxQueued) {
			const dropped = this.waiting.shift();
			if (dropped) {
				this.options.onFailure?.(dropped.subscription, dropped.eventId, "dropped: too many deliveries waiting");
			}
		}
		this.waiting.push({ subscription, event, eventId, attempt: 0 });
		this.drain();
	}

	/** Resolves once nothing is waiting or in flight (tests, shutdown). */
	idle(): Promise<void> {
		if (this.active === 0 && this.waiting.length === 0) {
			return Promise.resolve();
		}
		return new Promise((resolve) => this.idleWaiters.push(resolve));
	}

	private drain(): void {
		while (this.active < this.concurrency && this.waiting.length > 0) {
			const next = this.waiting.shift();
			if (next) {
				this.active += 1;
				void this.run(next).finally(() => {
					this.active -= 1;
					this.drain();
					if (this.active === 0 && this.waiting.length === 0) {
						for (const resolve of this.idleWaiters.splice(0)) {
							resolve();
						}
					}
				});
			}
		}
	}

	private async run(item: Queued): Promise<void> {
		for (;;) {
			const outcome = await deliver(item.subscription, item.event, item.eventId, this.timeoutMs);
			if (outcome.kind === "response" && outcome.status >= 200 && outcome.status < 300) {
				return;
			}
			const detail =
				outcome.kind === "response"
					? `HTTP ${outcome.status}`
					: outcome.kind === "timeout"
						? "no answer in time"
						: outcome.error;
			const delay = this.retryDelaysMs[item.attempt];
			if (!retryable(outcome) || delay === undefined) {
				this.options.onFailure?.(item.subscription, item.eventId, detail);
				return;
			}
			item.attempt += 1;
			await runtime().sleep(delay);
		}
	}
}
