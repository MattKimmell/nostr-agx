import {
	AgxClient,
	type AgxIncomingMessage,
	type AgxIncomingReceipt,
	type Task,
	TASK_CONTENT_TYPE,
} from "@nostr-agx/core";
import { toNpub } from "@nostr-agx/nostr";
import {
	type IDataObject,
	type INodeType,
	type INodeTypeDescription,
	type IRun,
	type ITriggerFunctions,
	type ITriggerResponse,
	NodeConnectionTypes,
	NodeOperationError,
} from "n8n-workflow";
import { testAgxCredential } from "../shared/credential-test";
import {
	agxLogger,
	createTransport,
	identityFromCredentials,
} from "../shared/identity";
import { watchInbox } from "../shared/inbox-watch";
import { parseCapabilities, parsePeerList } from "../shared/peers";
import {
	awaitTaskOutput,
	expiredTaskError,
	type ResultMode,
} from "../shared/run-result";
import { TriggerState } from "../shared/trigger-state";

interface TriggerOptions {
	advertise?: boolean;
	forwardErrors?: boolean;
	includeUnlisted?: boolean;
	maxTaskAge?: number;
	pollInterval?: number;
	result?: ResultMode;
	resultTimeout?: number;
}

/** The done-promise `emit` takes: settled with the finished execution. */
type DonePromise = Parameters<ITriggerFunctions["emit"]>[2];

function nowSec(): number {
	return Math.floor(Date.now() / 1000);
}

function isoOrNull(sec: number | undefined): string | null {
	return sec === undefined ? null : new Date(sec * 1000).toISOString();
}

/**
 * Makes a workflow an AGX agent. Allowed agents' task requests start the
 * workflow, and what its last node outputs goes back as the task result;
 * messages and delivery receipts can start it too.
 *
 * The AGX rules are `AgxClient`'s: authorization is default-deny and a denied
 * request gets no reply; results go only to the requester; each event is
 * handled at most once; a failed execution reaches the requester as `handler
 * failed` unless the node is set to forward errors. What this node adds is the
 * n8n side — running the workflow, waiting for it, and keeping replay state
 * across the restarts n8n puts a trigger through (see `TriggerState`).
 */
export class AgxTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: "AGX Trigger",
		name: "agxTrigger",
		icon: { light: "file:../../icons/agx.svg", dark: "file:../../icons/agx.dark.svg" },
		group: ["trigger"],
		version: 1,
		subtitle: '={{$parameter["events"].join(", ")}}',
		description:
			"Starts the workflow when another agent sends this one a task or message over Nostr (NIP-AGX)",
		defaults: {
			name: "AGX Trigger",
		},
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: "agxApi",
				required: true,
				testedBy: "agxApiTest",
			},
		],
		properties: [
			{
				displayName: "Events",
				name: "events",
				type: "multiOptions",
				required: true,
				options: [
					{
						name: "Delivery Receipt",
						value: "receipt",
						description: "An agent confirms it received a message this agent sent",
					},
					{
						name: "Message",
						value: "message",
						description: "A plain message (not a task request) from an allowed agent",
					},
					{
						name: "Task Request",
						value: "task",
						description:
							"An allowed agent asks this agent to run one of its capabilities. What the workflow outputs is sent back as the result.",
					},
				],
				default: ["task"],
			},
			{
				displayName: "Capabilities",
				name: "capabilities",
				type: "string",
				required: true,
				default: "",
				placeholder: "invoice.review, invoice.approve",
				description:
					"Capabilities this workflow serves, separated by commas. A request for anything else gets no reply.",
				displayOptions: { show: { events: ["task"] } },
			},
			{
				displayName: "Accept All Agents",
				name: "acceptAll",
				type: "boolean",
				default: false,
				description:
					"Whether any agent that can reach this one may run its capabilities and start the workflow. AGX denies by default; turn this on only for capabilities meant to be public.",
			},
			{
				displayName: "Allowed Agents",
				name: "allowedPeers",
				type: "string",
				typeOptions: { rows: 3 },
				default: "",
				placeholder: "npub1…, npub1…",
				description:
					"Agents that may run this agent's capabilities and start the workflow: npub1… or hex keys, separated by commas or new lines. Anyone else's task gets no reply.",
				displayOptions: { show: { acceptAll: [false] } },
			},
			{
				displayName: "Options",
				name: "options",
				type: "collection",
				placeholder: "Add Option",
				default: {},
				options: [
					{
						displayName: "Advertise Agent Card",
						name: "advertise",
						type: "boolean",
						default: false,
						description:
							"Whether to publish this agent's card — its capabilities, organization and relays — when the workflow starts. Cards are public. Agents on other relays find this agent's relays through it.",
						displayOptions: { show: { "/events": ["task"] } },
					},
					{
						displayName: "Ignore Tasks Older Than (Minutes)",
						name: "maxTaskAge",
						type: "number",
						typeOptions: { minValue: 0 },
						default: 10,
						description:
							"Answer a task request sent longer ago than this with a failure instead of running it: its requester has almost certainly stopped waiting. 0 turns this off.",
						displayOptions: { show: { "/events": ["task"] } },
					},
					{
						displayName: "Include Messages From Unlisted Agents",
						name: "includeUnlisted",
						type: "boolean",
						default: false,
						description:
							"Whether messages from agents that are not allowed start the workflow too, marked allowed: false. Their tasks are never run.",
						displayOptions: { show: { "/events": ["message"] } },
					},
					{
						displayName: "Poll Interval (Seconds)",
						name: "pollInterval",
						type: "number",
						typeOptions: { minValue: 1 },
						default: 3,
						description: "How often to check this agent's inbox on its relays",
					},
					{
						displayName: "Result",
						name: "result",
						type: "options",
						options: [
							{
								name: "All Items",
								value: "allItems",
								description: "The JSON of every item the last node outputs, as an array",
							},
							{
								name: "First Item",
								value: "firstItem",
								description: "The JSON of the first item the last node outputs",
							},
						],
						default: "firstItem",
						description: "What of the workflow's output is sent back as the task result",
						displayOptions: { show: { "/events": ["task"] } },
					},
					{
						displayName: "Result Timeout (Seconds)",
						name: "resultTimeout",
						type: "number",
						typeOptions: { minValue: 1 },
						default: 120,
						description:
							"Fail the task when the workflow has not finished by then. Tasks are answered one at a time, so a slow workflow holds up the next one.",
						displayOptions: { show: { "/events": ["task"] } },
					},
					{
						displayName: "Send Error Messages",
						name: "forwardErrors",
						type: "boolean",
						default: false,
						description:
							"Whether a failed execution's error message goes to the requesting agent. Off, it receives only \"handler failed\", so URLs, hostnames and other details in n8n errors stay on this side.",
						displayOptions: { show: { "/events": ["task"] } },
					},
				],
			},
		],
	};

	methods = {
		credentialTest: {
			agxApiTest: testAgxCredential,
		},
	};

	async trigger(this: ITriggerFunctions): Promise<ITriggerResponse> {
		const node = this.getNode();
		let identity: ReturnType<typeof identityFromCredentials>;
		let capabilities: string[];
		let allowed: Set<string>;
		const events = new Set(this.getNodeParameter("events", []) as string[]);
		const acceptAll = this.getNodeParameter("acceptAll", false) as boolean;
		const options = this.getNodeParameter("options", {}) as TriggerOptions;
		const serveTasks = events.has("task");
		try {
			identity = identityFromCredentials(
				await this.getCredentials("agxApi"),
			);
			capabilities = serveTasks
				? parseCapabilities(this.getNodeParameter("capabilities", "") as string)
				: [];
			allowed = acceptAll
				? new Set()
				: new Set(parsePeerList(this.getNodeParameter("allowedPeers", "") as string));
		} catch (error) {
			throw new NodeOperationError(node, error as Error);
		}
		if (events.size === 0) {
			throw new NodeOperationError(node, "Choose at least one event to listen for");
		}
		if (serveTasks && capabilities.length === 0) {
			throw new NodeOperationError(
				node,
				"Add the capabilities this workflow serves, such as invoice.review",
			);
		}
		const includeUnlisted = options.includeUnlisted === true;
		if (
			!acceptAll &&
			allowed.size === 0 &&
			(serveTasks || (events.has("message") && !includeUnlisted))
		) {
			throw new NodeOperationError(node, "No agent is allowed to reach this workflow", {
				description:
					"AGX denies everyone by default, so as configured nothing could start it. Add agents under Allowed Agents, or turn on Accept All Agents.",
			});
		}

		const manual = this.getMode() === "manual";
		const logger = agxLogger(this.logger);
		const state = manual
			? TriggerState.forManualRun(identity.publicKey, nowSec())
			: TriggerState.forActiveWorkflow(
					this.getWorkflowStaticData("node"),
					identity.publicKey,
					nowSec(),
				);
		const transport = await createTransport(identity, logger);
		const inbox = watchInbox(transport, state.since);

		const resultOptions = {
			mode: options.result ?? "firstItem",
			forwardErrors: options.forwardErrors === true,
		};
		const resultTimeoutMs = (options.resultTimeout ?? 120) * 1000;
		const maxTaskAgeSec = (options.maxTaskAge ?? 10) * 60;
		const pollIntervalMs = (options.pollInterval ?? 3) * 1000;
		const isAllowed = (from: string) => acceptAll || allowed.has(from);

		// A manual test run handles ONE event: n8n runs the test with the first
		// emit and drops any later one — which, claimed as it was emitted, would
		// then never be delivered again. A task rarely gets that far, since its
		// handler waits for the execution and n8n closes the trigger first, but a
		// message's or receipt's emit returns at once, so a batch of them would
		// all go out. The slot keeps every event after the first out, unclaimed,
		// for the next test run. Once closed, an active trigger takes nothing new
		// either: the trigger n8n starts in its place (on a save) delivers
		// whatever this one leaves unclaimed.
		let closed = false;
		let slotTaken = false;
		const takeSlot = (): boolean => {
			if (closed || (manual && slotTaken)) {
				return false;
			}
			slotTaken = true;
			return true;
		};

		const emit = (json: IDataObject, claim: string[], done?: DonePromise) => {
			// Claim first: n8n saves the static data as part of this emit.
			state.claim(claim, nowSec());
			this.emit([[{ json }]], undefined, done);
		};

		const runTask = async (task: Task): Promise<unknown> => {
			const request = inbox.taskRequest(task.from, task.taskId);
			const sentAt = request?.sentAt;
			if (maxTaskAgeSec > 0 && sentAt !== undefined && nowSec() - sentAt > maxTaskAgeSec) {
				// Nothing is emitted, so a manual run's slot goes to the next event.
				slotTaken = false;
				state.claim(request?.eventIds ?? [], nowSec());
				logger.info?.("AGX Trigger: task request too old to run; answering with a failure", {
					from: toNpub(task.from),
					capability: task.capability,
					sentAt: isoOrNull(sentAt),
				});
				throw expiredTaskError();
			}
			const done = this.helpers.createDeferredPromise<IRun>();
			emit(
				{
					event: "task",
					taskId: task.taskId,
					capability: task.capability,
					payload: task.payload as IDataObject,
					from: toNpub(task.from),
					fromPubkey: task.from,
					contextId: task.contextId,
					sentAt: isoOrNull(sentAt),
				},
				request?.eventIds ?? [],
				done,
			);
			return awaitTaskOutput(done.promise, {
				...resultOptions,
				timeoutMs: resultTimeoutMs,
			});
		};

		const client = new AgxClient({
			transport,
			seen: state.seenStore(),
			logger,
			identity: { org: identity.org ?? undefined, nip05: identity.nip05 },
			startCursor: state.cursor,
			// A function rather than the "accept-all" sentinel even when every agent
			// is accepted, because the manual-run slot gates it too. The explicit
			// opt-in the SPEC asks for is the node's Accept All Agents switch.
			authorize: ({ from }) => isAllowed(from) && takeSlot(),
			onMessage: async (msg: AgxIncomingMessage) => {
				// Task traffic `AgxClient` did not consume lands here too: a request
				// for a capability this trigger does not serve, a denied request, or a
				// result for a request this identity made elsewhere (the AGX node's
				// Request operation). None of it is a message for this workflow — the
				// task may well be another workflow's on the same identity — so it is
				// dropped here, still with no reply, as the SPEC requires.
				if (msg.contentType === TASK_CONTENT_TYPE) {
					return;
				}
				const allowedSender = isAllowed(msg.from);
				if (!events.has("message") || (!allowedSender && !includeUnlisted)) {
					return;
				}
				if (!takeSlot()) {
					return;
				}
				const autoDepth = msg.autoDepth ?? 0;
				emit(
					{
						event: "message",
						from: toNpub(msg.from),
						fromPubkey: msg.from,
						allowed: allowedSender,
						text: msg.text,
						subject: msg.subject,
						contextId: msg.contextId,
						messageId: msg.messageId,
						eventId: msg.eventId,
						contentType: msg.contentType,
						autoDepth,
						// What an automated reply to this message declares, for the AGX
						// node's Automated Reply Depth option.
						replyAutoDepth: autoDepth + 1,
						sentAt: isoOrNull(msg.sentAt),
					},
					[msg.eventId],
				);
			},
			onReceipt: async (receipt: AgxIncomingReceipt) => {
				if (!events.has("receipt") || !takeSlot()) {
					return;
				}
				emit(
					{
						event: "receipt",
						from: toNpub(receipt.from),
						fromPubkey: receipt.from,
						allowed: isAllowed(receipt.from),
						status: receipt.receipt.status,
						refEventId: receipt.receipt.refEventId,
						contextId: receipt.receipt.contextId,
						eventId: receipt.eventId,
						sentAt: isoOrNull(receipt.sentAt),
					},
					[receipt.eventId],
				);
			},
		});
		for (const capability of capabilities) {
			client.handle(capability, runTask);
		}

		let timer: ReturnType<typeof setTimeout> | undefined;
		const pumpLoop = async (): Promise<void> => {
			timer = undefined;
			if (closed) {
				return;
			}
			try {
				const { cursor, complete } = await client.pump();
				if (complete) {
					state.setCursor(cursor);
				}
			} catch (error) {
				logger.warn?.("AGX Trigger: inbox poll failed; will retry", {
					error: error instanceof Error ? error.message : String(error),
				});
			}
			if (!closed) {
				timer = setTimeout(() => void pumpLoop(), pollIntervalMs);
			}
		};
		const start = async (): Promise<void> => {
			// Only advertises (the interval is ours, so the cursor can be saved). A
			// failed advertise is logged and does not stop the trigger.
			await client
				.start({
					pollIntervalMs: 0,
					advertise: serveTasks && options.advertise === true,
				})
				.catch((error) =>
					logger.warn?.("AGX Trigger: could not start advertising", {
						error: error instanceof Error ? error.message : String(error),
					}),
				);
			void pumpLoop();
		};

		const closeFunction = async (): Promise<void> => {
			closed = true;
			if (timer) {
				clearTimeout(timer);
			}
			// An in-flight task is NOT awaited. In a manual run n8n awaits this
			// before the execution's end hook, and that hook is what settles the
			// task's done-promise: waiting here would hang until the result timeout.
			// The transport keeps no connection between polls, so the task still
			// publishes its result after this returns.
			await client.stop();
		};

		if (manual) {
			return {
				closeFunction,
				manualTriggerFunction: async () => {
					await start();
				},
			};
		}
		void start();
		return { closeFunction };
	}
}
