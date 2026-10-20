import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from "n8n-workflow";
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from "n8n-workflow";
import { gatewayError, gatewayRequest, succeeded } from "../shared/gateway";

/** The longest a task request waits for its result, as the gateway allows. */
const MAX_TASK_TIMEOUT_SEC = 3600;

/** A text parameter as a string: an expression can hand over a number. */
function asText(value: unknown): string {
	if (value === undefined || value === null) {
		return "";
	}
	return typeof value === "string" ? value : typeof value === "object" ? JSON.stringify(value) : String(value);
}

/**
 * Talks to other agents over NIP-AGX through an agx gateway: requests a task
 * and waits for its result, sends a message, or reads an agent's card. Usable
 * as an AI Agent tool, so a model in n8n can call capabilities other
 * organizations' agents advertise.
 *
 * The gateway holds the agent's key and talks to relays; this node only makes
 * HTTP calls to it. Answering other agents' tasks is the AGX Gateway Trigger's
 * job.
 */
export class AgxGateway implements INodeType {
	description: INodeTypeDescription = {
		displayName: "AGX Gateway",
		name: "agxGateway",
		icon: { light: "file:../../icons/agx.svg", dark: "file:../../icons/agx.dark.svg" },
		group: ["output"],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: "Exchange tasks and messages with other agents over NIP-AGX, through an agx gateway",
		defaults: {
			name: "AGX Gateway",
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: "agxGatewayApi",
				required: true,
			},
		],
		properties: [
			{
				displayName: "Resource",
				name: "resource",
				type: "options",
				noDataExpression: true,
				options: [
					{ name: "Agent", value: "agent" },
					{ name: "Message", value: "message" },
					{ name: "Task", value: "task" },
				],
				default: "task",
			},
			{
				displayName: "Operation",
				name: "operation",
				type: "options",
				noDataExpression: true,
				displayOptions: { show: { resource: ["task"] } },
				options: [
					{
						name: "Request",
						value: "request",
						action: "Request a task from an agent",
						description: "Ask an agent to run one of its capabilities, and wait for the result",
					},
				],
				default: "request",
			},
			{
				displayName: "Operation",
				name: "operation",
				type: "options",
				noDataExpression: true,
				displayOptions: { show: { resource: ["message"] } },
				options: [
					{
						name: "Send",
						value: "send",
						action: "Send a message to an agent",
						description: "Send an end-to-end encrypted message to an agent",
					},
				],
				default: "send",
			},
			{
				displayName: "Operation",
				name: "operation",
				type: "options",
				noDataExpression: true,
				displayOptions: { show: { resource: ["agent"] } },
				options: [
					{
						name: "Get Card",
						value: "getCard",
						action: "Get the card of an agent",
						description: "Read the capabilities, organization and relays an agent advertises",
					},
					{
						name: "Get Own Identity",
						value: "getIdentity",
						action: "Get the identity of this agent",
						description: "Return the gateway agent's public key and relays, to give to other agents",
					},
				],
				default: "getCard",
			},
			{
				displayName: "Agent",
				name: "peer",
				type: "string",
				required: true,
				default: "",
				placeholder: "npub1…",
				description: "The other agent's public key: npub1… or 64 hex characters",
				displayOptions: { show: { operation: ["request", "send", "getCard"] } },
			},

			// Task → Request
			{
				displayName: "Capability",
				name: "capability",
				type: "string",
				required: true,
				default: "",
				placeholder: "invoice.review",
				description: "The capability to run, as the agent advertises it",
				displayOptions: { show: { resource: ["task"], operation: ["request"] } },
			},
			{
				displayName: "Payload",
				name: "payload",
				type: "json",
				default: "{}",
				description: "JSON the agent's capability handler receives",
				displayOptions: { show: { resource: ["task"], operation: ["request"] } },
			},
			{
				displayName: "Options",
				name: "options",
				type: "collection",
				placeholder: "Add Option",
				default: {},
				displayOptions: { show: { resource: ["task"], operation: ["request"] } },
				options: [
					{
						displayName: "Check Agent Card First",
						name: "checkCard",
						type: "boolean",
						default: false,
						description:
							"Whether to read the agent's card first, and fail at once if it does not advertise the capability",
					},
					{
						displayName: "Timeout (Seconds)",
						name: "timeout",
						type: "number",
						typeOptions: { minValue: 1, maxValue: MAX_TASK_TIMEOUT_SEC },
						default: 30,
						description:
							"How long to wait for the result. An agent that has not allowed this one sends no reply at all, so a missing allowlist entry shows up as a timeout.",
					},
				],
			},

			// Message → Send
			{
				displayName: "Text",
				name: "text",
				type: "string",
				typeOptions: { rows: 4 },
				required: true,
				default: "",
				description: "The message body",
				displayOptions: { show: { resource: ["message"], operation: ["send"] } },
			},
			{
				displayName: "Options",
				name: "options",
				type: "collection",
				placeholder: "Add Option",
				default: {},
				displayOptions: { show: { resource: ["message"], operation: ["send"] } },
				options: [
					{
						displayName: "Automated Reply Depth",
						name: "autoDepth",
						type: "number",
						typeOptions: { minValue: 0 },
						default: 0,
						description:
							"For a message sent automatically in reply to another, the inbound message's depth plus one: the replyAutoDepth field an AGX Gateway Trigger outputs. Leave 0 for a message a person wrote or approved. Agents use it to end reply loops.",
					},
					{
						displayName: "Conversation ID",
						name: "contextId",
						type: "string",
						default: "",
						description:
							"Continue a conversation: the contextId of the message being answered. Leave empty to start a new one.",
					},
					{
						displayName: "Max Automated Replies per Agent per Hour",
						name: "maxPerHour",
						type: "number",
						typeOptions: { minValue: 1 },
						default: 60,
						description: "Refuse an automated reply (depth above 0) to an agent that has had this many in the last hour",
					},
					{
						displayName: "Max Automated Replies per Conversation",
						name: "maxPerConversation",
						type: "number",
						typeOptions: { minValue: 1 },
						default: 20,
						description: "Refuse an automated reply in a conversation that has had this many",
					},
					{
						displayName: "Max Automated Reply Depth",
						name: "maxAutoDepth",
						type: "number",
						typeOptions: { minValue: 1 },
						default: 8,
						description: "Refuse an automated reply deeper than this",
					},
					{
						displayName: "Subject",
						name: "subject",
						type: "string",
						default: "",
					},
				],
			},

			// Agent → Get Card
			{
				displayName: "Options",
				name: "options",
				type: "collection",
				placeholder: "Add Option",
				default: {},
				displayOptions: { show: { resource: ["agent"], operation: ["getCard"] } },
				options: [
					{
						displayName: "Capability to Check",
						name: "capability",
						type: "string",
						default: "",
						placeholder: "invoice.review",
						description: "Report whether the card advertises this capability, wildcards included",
					},
					{
						displayName: "Verify NIP-05",
						name: "verifyNip05",
						type: "boolean",
						default: true,
						description:
							"Whether to confirm the domain identity the card claims with that domain's own NIP-05 record",
					},
				],
			},
		],
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const resource = this.getNodeParameter("resource", 0) as string;
		const operation = this.getNodeParameter("operation", 0) as string;

		const runItem = async (i: number): Promise<IDataObject> => {
			if (resource === "agent" && operation === "getIdentity") {
				const response = await gatewayRequest(this, "GET", "/v1/identity", { itemIndex: i });
				if (!succeeded(response)) {
					throw gatewayError(this, response, i);
				}
				return response.body as IDataObject;
			}
			const peer = asText(this.getNodeParameter("peer", i)).trim();
			if (resource === "task" && operation === "request") {
				const options = this.getNodeParameter("options", i, {}) as { checkCard?: boolean; timeout?: unknown };
				const timeoutSec = options.timeout === undefined || options.timeout === "" ? 30 : Number(options.timeout);
				if (!Number.isInteger(timeoutSec) || timeoutSec < 1 || timeoutSec > MAX_TASK_TIMEOUT_SEC) {
					throw new NodeOperationError(this.getNode(), `Timeout must be a whole number of seconds from 1 to ${MAX_TASK_TIMEOUT_SEC}`, { itemIndex: i });
				}
				const raw = this.getNodeParameter("payload", i, "{}");
				let payload: unknown = raw;
				if (typeof raw === "string") {
					try {
						payload = raw.trim() ? JSON.parse(raw) : {};
					} catch (error) {
						throw new NodeOperationError(this.getNode(), `Payload is not valid JSON: ${(error as Error).message}`, { itemIndex: i });
					}
				}
				const response = await gatewayRequest(this, "POST", "/v1/tasks", {
					body: {
						peer,
						capability: asText(this.getNodeParameter("capability", i)).trim(),
						payload: payload as IDataObject,
						timeoutSec,
						checkCard: options.checkCard === true,
					},
					// The gateway answers at the timeout; this only bounds a gateway gone silent.
					timeoutMs: (timeoutSec + 30) * 1000,
					itemIndex: i,
				});
				if (!succeeded(response)) {
					throw gatewayError(this, response, i);
				}
				return response.body as IDataObject;
			}
			if (resource === "message" && operation === "send") {
				const options = this.getNodeParameter("options", i, {}) as IDataObject;
				const body: IDataObject = {
					peer,
					text: asText(this.getNodeParameter("text", i)),
					subject: asText(options.subject),
					contextId: asText(options.contextId),
					maxAutoDepth: options.maxAutoDepth,
					maxPerConversation: options.maxPerConversation,
					maxPerHour: options.maxPerHour,
				};
				// Sent even when it came out empty, as null, so the gateway refuses
				// it: an automated reply whose depth went missing must not go out as
				// one a person wrote.
				if (Object.prototype.hasOwnProperty.call(options, "autoDepth")) {
					body.autoDepth = options.autoDepth === undefined ? null : options.autoDepth;
				}
				const response = await gatewayRequest(this, "POST", "/v1/messages", { body, itemIndex: i });
				if (!succeeded(response)) {
					throw gatewayError(this, response, i);
				}
				return response.body as IDataObject;
			}
			if (resource === "agent" && operation === "getCard") {
				const options = this.getNodeParameter("options", i, {}) as { capability?: unknown; verifyNip05?: boolean };
				const response = await gatewayRequest(this, "GET", `/v1/agents/${encodeURIComponent(peer)}`, {
					qs: {
						...(asText(options.capability).trim() ? { capability: asText(options.capability).trim() } : {}),
						verifyNip05: options.verifyNip05 === false ? "false" : "true",
					},
					itemIndex: i,
				});
				if (!succeeded(response)) {
					throw gatewayError(this, response, i);
				}
				return response.body as IDataObject;
			}
			throw new NodeOperationError(this.getNode(), `Unsupported operation: ${resource} ${operation}`, { itemIndex: i });
		};

		// Every item's request goes out at once: n task requests cost one wait.
		const outcomes = await Promise.all(
			items.map((_, i) =>
				runItem(i).then(
					(json) => ({ ok: true as const, json }),
					(error: unknown) => ({ ok: false as const, error }),
				),
			),
		);
		const out: INodeExecutionData[] = [];
		for (const [i, outcome] of outcomes.entries()) {
			if (outcome.ok) {
				out.push({ json: outcome.json, pairedItem: { item: i } });
			} else if (this.continueOnFail()) {
				out.push({ json: { error: (outcome.error as Error).message }, pairedItem: { item: i } });
			} else if (outcome.error instanceof NodeOperationError || outcome.error instanceof NodeApiError) {
				throw outcome.error;
			} else {
				throw new NodeOperationError(this.getNode(), outcome.error as Error, { itemIndex: i });
			}
		}
		return [out];
	}
}
