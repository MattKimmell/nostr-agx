import { InMemorySeenStore, type SeenStore } from "@nostr-agx/core";
import { MAX_WRAP_BACKDATE_SEC } from "@nostr-agx/nostr";
import type { IDataObject } from "n8n-workflow";

/**
 * Replay state for the AGX Trigger.
 *
 * AGX re-delivers its whole poll window on every poll — the poll overlap plus
 * the two-day NIP-59 backdate lookback — and n8n restarts a trigger every time
 * its workflow is saved. Replay protection that lived only in memory would run
 * every task of the last two days again on each save, so the trigger keeps
 * durable state in its node's workflow static data.
 *
 * n8n saves static data when the trigger EMITS (and on activation), not when
 * it changes. So the trigger CLAIMS an event — records its id here — just
 * before emitting it: the save that goes with the emit carries the claim, and a
 * restarted trigger skips it. That gives at-most-once execution per task across
 * restarts; a crash mid-execution means no result, which the requester's
 * timeout covers, rather than the workflow running twice.
 *
 * Only claimed ids are kept durably. Everything else the client records — wraps
 * it could not open, events it handled without running the workflow (a denied
 * task, an ignored message) — stays in memory, so the static data, which n8n
 * writes in full on every save, grows only with executions.
 */

/** What is stored under the trigger node's static data. */
interface StoredState {
	v: 1;
	/** The identity this state belongs to; a credential with another key starts over. */
	pubkey: string;
	/** Events their sender says were sent before this (unix seconds) are not
	 * delivered: a trigger starts from the inbox as it was when it first ran. */
	since: number;
	/** The inbox cursor (unix seconds) after the last complete poll. */
	cursor: number;
	/** Rumor id -> unix seconds when it was handed to a workflow execution. */
	claimed: Record<string, number>;
}

const STATE_KEY = "agx";

/** How far before the trigger first ran a sender may date an event and still
 * have it delivered: clock skew, or a test message sent just before listening. */
export const START_GRACE_SEC = 300;

/** `AgxClient`'s default poll overlap. Kept equal to it: the trigger does not
 * override `pollOverlapSec`. */
const POLL_OVERLAP_SEC = 120;
/** `AgxClient` skips events dated further ahead than this. */
const MAX_FUTURE_SKEW_SEC = 300;
/** Memory and static-data guard. Pruning by the cursor (below) is the
 * retention policy; this only caps a pathological backlog. */
const MAX_CLAIMS = 50_000;

/** Claims made during manual test runs, which n8n does not save. Kept for the
 * process lifetime so a second test run does not deliver the first one's event
 * again. Keyed by identity. */
const manualRunClaims = new Map<string, Record<string, number>>();

function isStoredState(value: unknown, pubkey: string): value is StoredState {
	if (!value || typeof value !== "object") {
		return false;
	}
	const s = value as Partial<StoredState>;
	return (
		s.v === 1 &&
		s.pubkey === pubkey &&
		typeof s.since === "number" &&
		typeof s.cursor === "number" &&
		typeof s.claimed === "object" &&
		s.claimed !== null
	);
}

export class TriggerState {
	private constructor(
		private readonly stored: StoredState,
		/** Marks the static data changed, so n8n saves it with the next emit. */
		private readonly markChanged: () => void,
	) {}

	/** State kept in the trigger node's static data (an active workflow). */
	static forActiveWorkflow(
		nodeStaticData: IDataObject,
		pubkey: string,
		nowSec: number,
	): TriggerState {
		const existing = nodeStaticData[STATE_KEY];
		const stored: StoredState = isStoredState(existing, pubkey)
			? existing
			: {
					v: 1,
					pubkey,
					since: nowSec - START_GRACE_SEC,
					cursor: nowSec,
					claimed: {},
				};
		// Assigning the top-level key is what marks n8n's static data changed: it
		// only proxies objects that existed when it was loaded, so mutating a
		// nested object created since then would go unnoticed and unsaved.
		const markChanged = () => {
			nodeStaticData[STATE_KEY] = stored as unknown as IDataObject;
		};
		markChanged();
		return new TriggerState(stored, markChanged);
	}

	/** State for a manual test run: it starts from now, like listening for a
	 * test event should, and its claims live in process memory. */
	static forManualRun(pubkey: string, nowSec: number): TriggerState {
		let claimed = manualRunClaims.get(pubkey);
		if (!claimed) {
			claimed = {};
			manualRunClaims.set(pubkey, claimed);
		}
		return new TriggerState(
			{
				v: 1,
				pubkey,
				since: nowSec - START_GRACE_SEC,
				cursor: nowSec,
				claimed,
			},
			() => undefined,
		);
	}

	/** Events dated before this are not delivered. */
	get since(): number {
		return this.stored.since;
	}

	get cursor(): number {
		return this.stored.cursor;
	}

	/** Record the cursor after a complete poll. Not saved by itself: it goes out
	 * with the next claim, together with the claims it was pruned against. */
	setCursor(cursor: number): void {
		if (cursor > this.stored.cursor) {
			this.stored.cursor = cursor;
		}
	}

	isClaimed(id: string): boolean {
		return this.stored.claimed[id] !== undefined;
	}

	/** Record events as handed to a workflow execution. Call BEFORE emitting. */
	claim(ids: string[], nowSec: number): void {
		for (const id of ids) {
			this.stored.claimed[id] ??= nowSec;
		}
		this.prune();
		this.markChanged();
	}

	/**
	 * Drop the claims no future poll can reach. A poll reads from
	 * `cursor - overlap - backdate`, and an event claimed at time `t` was dated
	 * at most `t + MAX_FUTURE_SKEW_SEC`; once that is before the earliest poll
	 * start, the event cannot be delivered again. Measured against the cursor
	 * saved WITH these claims, not the wall clock: a trigger restarted after a
	 * quiet week resumes from the cursor it saved, and must still know every
	 * claim that cursor's window can reach.
	 */
	private prune(): void {
		const horizon =
			this.stored.cursor -
			POLL_OVERLAP_SEC -
			MAX_WRAP_BACKDATE_SEC -
			MAX_FUTURE_SKEW_SEC;
		const entries = Object.entries(this.stored.claimed);
		for (const [id, at] of entries) {
			if (at < horizon) {
				delete this.stored.claimed[id];
			}
		}
		const kept = Object.entries(this.stored.claimed);
		if (kept.length > MAX_CLAIMS) {
			kept.sort((a, b) => a[1] - b[1]);
			for (const [id] of kept.slice(0, kept.length - MAX_CLAIMS)) {
				delete this.stored.claimed[id];
			}
		}
	}

	/** The replay store to give `AgxClient`: claimed ids durably, the rest in
	 * memory for this run of the trigger. */
	seenStore(): SeenStore {
		const memory = new InMemorySeenStore();
		return {
			has: (id) => memory.has(id) || this.isClaimed(id),
			hasMany: (ids) => {
				const out = memory.hasMany(ids);
				for (const id of ids) {
					if (this.isClaimed(id)) {
						out.add(id);
					}
				}
				return out;
			},
			add: (id) => memory.add(id),
			addMany: (ids) => memory.addMany(ids),
			recordFailure: (id) => memory.recordFailure(id),
		};
	}
}

/** Test-only: forget manual-run claims between cases. */
export function __resetManualRunClaimsForTests(): void {
	manualRunClaims.clear();
}
