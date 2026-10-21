import type { AgxIncomingMessage, AgxIncomingReceipt, Task } from "@nostr-agx/core";
import { toNpub } from "@nostr-agx/nostr";

/**
 * What a webhook receives: one JSON object per event, with the same fields the
 * AGX Trigger node outputs, so a workflow reads them the same way whichever
 * way it is connected.
 */

/** A sender-declared time (unix seconds) as ISO 8601; null when absent or not
 * a date at all (`toISOString` throws outside what a Date can hold). */
export function isoOrNull(sec: number | undefined): string | null {
	if (sec === undefined || !Number.isFinite(sec) || Math.abs(sec) > 8.64e12) {
		return null;
	}
	return new Date(sec * 1000).toISOString();
}

export function taskEvent(task: Task): Record<string, unknown> {
	return {
		event: "task",
		taskId: task.taskId,
		capability: task.capability,
		payload: task.payload,
		from: toNpub(task.from),
		fromPubkey: task.from,
		contextId: task.contextId,
		sentAt: isoOrNull(task.sentAt),
	};
}

export function messageEvent(msg: AgxIncomingMessage, allowed: boolean): Record<string, unknown> {
	const autoDepth = msg.autoDepth ?? 0;
	return {
		event: "message",
		from: toNpub(msg.from),
		fromPubkey: msg.from,
		allowed,
		text: msg.text,
		subject: msg.subject,
		contextId: msg.contextId,
		messageId: msg.messageId,
		eventId: msg.eventId,
		contentType: msg.contentType,
		autoDepth,
		// What an automated reply to this message declares.
		replyAutoDepth: autoDepth + 1,
		sentAt: isoOrNull(msg.sentAt),
	};
}

export function receiptEvent(receipt: AgxIncomingReceipt, allowed: boolean): Record<string, unknown> {
	return {
		event: "receipt",
		from: toNpub(receipt.from),
		fromPubkey: receipt.from,
		allowed,
		status: receipt.receipt.status,
		refEventId: receipt.receipt.refEventId,
		contextId: receipt.receipt.contextId,
		eventId: receipt.eventId,
		sentAt: isoOrNull(receipt.sentAt),
	};
}
