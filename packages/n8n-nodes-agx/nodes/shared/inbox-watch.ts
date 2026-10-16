import {
	type AgxPollResult,
	type AgxTransport,
	parseTaskEnvelope,
	TASK_CONTENT_TYPE,
} from "@nostr-agx/core";

/** The event behind a task request, which `AgxClient` does not pass to the
 * handler: it hands over the task, not the message it arrived in. */
export interface TaskRequestEvent {
	/** Rumor ids carrying this `taskId` from this sender (normally one). */
	eventIds: string[];
	/** When the sender says it sent the request (unix seconds). */
	sentAt?: number;
}

/**
 * Wrap a transport's `poll` for the AGX Trigger:
 *
 * - Events their sender dated before `since` are dropped and reported as
 *   discarded, so a trigger starts from the inbox as it was when it first ran
 *   instead of replaying the last two days of it. `sentAt` is the sender's own
 *   clock, the one date a NIP-59 wrap does not randomize.
 * - Task requests are indexed by sender and `taskId`, so the handler can claim
 *   the request's event before it runs the workflow (see `TriggerState`) and
 *   tell how long ago it was sent.
 *
 * The wrapper is installed on the instance, so `AgxClient` keeps every other
 * part of the transport as it is. The index covers the latest poll only, which
 * is enough: `AgxClient` dispatches a poll's events before it polls again.
 */
export function watchInbox(
	transport: AgxTransport,
	since: number,
): { taskRequest(from: string, taskId: string): TaskRequestEvent | undefined } {
	const requests = new Map<string, TaskRequestEvent>();
	const poll = transport.poll.bind(transport);
	transport.poll = async (opts): Promise<AgxPollResult> => {
		const res = await poll(opts);
		requests.clear();
		const discarded = [...(res.discarded ?? [])];
		const current = <
			T extends {
				eventId: string;
				transportId?: string;
				createdAt: number;
				sentAt?: number;
			},
		>(
			events: T[],
		): T[] =>
			events.filter((event) => {
				if ((event.sentAt ?? event.createdAt) >= since) {
					return true;
				}
				discarded.push(event.transportId ?? event.eventId);
				return false;
			});
		const messages = current(res.messages);
		const receipts = current(res.receipts);
		for (const msg of messages) {
			if (msg.contentType !== TASK_CONTENT_TYPE) {
				continue;
			}
			const env = parseTaskEnvelope(msg.text);
			if (env?.t !== "req") {
				continue;
			}
			const key = `${msg.from}:${env.taskId}`;
			const entry = requests.get(key) ?? { eventIds: [] };
			entry.eventIds.push(msg.eventId);
			entry.sentAt ??= msg.sentAt;
			requests.set(key, entry);
		}
		return { ...res, messages, receipts, discarded };
	};
	return {
		taskRequest: (from, taskId) => requests.get(`${from}:${taskId}`),
	};
}
