import { AutoReplyGuard } from "@nostr-agx/core";

export {
	type Admission,
	AutoReplyGuard,
	type AutoReplyLimits,
	DEFAULT_AUTO_REPLY_LIMITS,
} from "@nostr-agx/core";

/**
 * One guard per n8n process, shared by every AGX node in it.
 *
 * Kept in process memory, like `agx serve`'s per-conversation count, rather than
 * in workflow static data: n8n saves static data as one blob per workflow, so a
 * node that writes it during an execution overwrites the AGX Trigger's replay
 * state in the same workflow with the stale copy the execution started from.
 */
export const autoReplyGuard = new AutoReplyGuard();
