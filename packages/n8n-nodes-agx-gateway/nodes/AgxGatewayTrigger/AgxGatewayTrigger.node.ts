import { createHash, createHmac, timingSafeEqual } from "crypto";
import type {
	IDataObject,
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from "n8n-workflow";
import { NodeConnectionTypes } from "n8n-workflow";
import { gatewayError, gatewayRequest, succeeded } from "../shared/gateway";

/** How old a delivery's timestamp may be, either way, before it is refused:
 * a captured delivery cannot be replayed later. */
const SIGNATURE_TOLERANCE_SEC = 300;

interface TriggerOptions {
	advertise?: boolean;
	includeUnlisted?: boolean;
	maxTaskAge?: unknown;
	result?: string;
	resultTimeout?: unknown;
}

function splitList(value: unknown): string[] {
	const input = typeof value === "string" ? value : value === undefined || value === null ? "" : String(value);
	return [
		...new Set(
			input
				.split(/[\s,]+/)
				.map((entry) => entry.trim())
				.filter(Boolean),
		),
	];
}

/** What the gateway is asked to deliver to this webhook, from the node's settings. */
function subscriptionBody(ctx: IHookFunctions): IDataObject {
	const events = ctx.getNodeParameter("events", []) as string[];
	const acceptAll = ctx.getNodeParameter("acceptAll", false) as boolean;
	const options = ctx.getNodeParameter("options", {}) as TriggerOptions;
	const maxTaskAge = options.maxTaskAge === undefined ? 10 : Number(options.maxTaskAge);
	const resultTimeout = options.resultTimeout === undefined ? 120 : Number(options.resultTimeout);
	return {
		url: ctx.getNodeWebhookUrl("default") ?? "",
		label: `n8n: ${ctx.getWorkflow().name ?? ctx.getWorkflow().id ?? ""}`.slice(0, 200),
		events,
		capabilities: events.includes("task") ? splitList(ctx.getNodeParameter("capabilities", "")) : [],
		acceptAll,
		allowedPeers: acceptAll ? [] : splitList(ctx.getNodeParameter("allowedPeers", "")),
		includeUnlisted: options.includeUnlisted === true,
		maxTaskAgeSec: Math.round(maxTaskAge * 60),
		resultTimeoutSec: Math.round(resultTimeout),
		advertise: options.advertise === true,
	};
}

/** Identifies a subscription's settings, so a changed node gets a new one. */
function fingerprint(body: IDataObject): string {
	return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

/**
 * Starts the workflow when another agent sends the gateway's agent a task
 * request, a message or a delivery receipt.
 *
 * Turning the workflow on subscribes this node's webhook on the gateway, with
 * its rules — which agents may reach it, which capabilities it serves — and the
 * gateway enforces them: an agent that is not allowed gets no reply, and its
 * task never reaches n8n. For a task request, n8n answers the gateway when the
 * workflow ends, and what the last node outputs is sent back as the result.
 * Every delivery is signed by the gateway and checked here.
 */
export class AgxGatewayTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: "AGX Gateway Trigger",
		name: "agxGatewayTrigger",
		icon: { light: "file:../../icons/agx.svg", dark: "file:../../icons/agx.dark.svg" },
		group: ["trigger"],
		version: 1,
		subtitle: '={{$parameter["events"].join(", ")}}',
		description:
			"Starts the workflow when another agent sends the gateway's agent a task or message over NIP-AGX",
		defaults: {
			name: "AGX Gateway Trigger",
		},
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: "agxGatewayApi",
				required: true,
			},
		],
		webhooks: [
			{
				name: "default",
				httpMethod: "POST",
				path: "webhook",
				// A task's result is what the workflow ends with, so n8n answers the
				// gateway when it finishes; messages and receipts need no answer.
				responseMode: '={{$parameter["events"].includes("task") ? "lastNode" : "onReceived"}}',
				responseData:
					'={{$parameter["options"]["result"] === "allItems" ? "allEntries" : "firstEntryJson"}}',
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
						description: "An allowed agent confirms it received a message this agent sent",
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
					"Capabilities this workflow serves, by their exact names, separated by commas. A request for anything else gets no reply.",
				displayOptions: { show: { events: ["task"] } },
			},
			{
				displayName: "Accept All Agents",
				name: "acceptAll",
				type: "boolean",
				default: false,
				description:
					"Whether any agent that can reach the gateway may run these capabilities and start the workflow. AGX denies by default; turn this on only for capabilities meant to be public.",
			},
			{
				displayName: "Allowed Agents",
				name: "allowedPeers",
				type: "string",
				typeOptions: { rows: 3 },
				default: "",
				placeholder: "npub1…, npub1…",
				description:
					"Agents that may run these capabilities and start the workflow: npub1… or hex keys, separated by commas or new lines. Anyone else's task gets no reply.",
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
							"Whether the gateway lists these capabilities on the agent's public card, for agents that look them up",
						displayOptions: { show: { "/events": ["task"] } },
					},
					{
						displayName: "Ignore Tasks Older Than (Minutes)",
						name: "maxTaskAge",
						type: "number",
						typeOptions: { minValue: 0 },
						default: 10,
						description:
							"Ignore a task request sent longer ago than this, with no reply: its requester has almost certainly stopped waiting. 0 turns this off.",
						displayOptions: { show: { "/events": ["task"] } },
					},
					{
						displayName: "Include Messages and Receipts From Unlisted Agents",
						name: "includeUnlisted",
						type: "boolean",
						default: false,
						description:
							"Whether messages and delivery receipts from agents that are not allowed start the workflow too, marked allowed: false. Their tasks are never run.",
						displayOptions: { show: { "/events": ["message", "receipt"] } },
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
						typeOptions: { minValue: 1, maxValue: 3600 },
						default: 120,
						description:
							"Fail the task when the workflow has not finished by then. A failed workflow reaches the requester only as \"handler failed\".",
						displayOptions: { show: { "/events": ["task"] } },
					},
				],
			},
		],
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const data = this.getWorkflowStaticData("node");
				if (typeof data.subscriptionId !== "string") {
					return false;
				}
				const id = data.subscriptionId;
				const response = await gatewayRequest(this, "GET", `/v1/subscriptions/${encodeURIComponent(id)}`);
				if (response.statusCode === 404) {
					delete data.subscriptionId;
					delete data.secret;
					delete data.fingerprint;
					return false;
				}
				if (!succeeded(response)) {
					throw gatewayError(this, response);
				}
				// The node's settings or its URL changed since: replace the subscription.
				if (data.fingerprint !== fingerprint(subscriptionBody(this))) {
					const removed = await gatewayRequest(this, "DELETE", `/v1/subscriptions/${encodeURIComponent(id)}`);
					if (!succeeded(removed) && removed.statusCode !== 404) {
						throw gatewayError(this, removed);
					}
					delete data.subscriptionId;
					delete data.secret;
					delete data.fingerprint;
					return false;
				}
				return true;
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const body = subscriptionBody(this);
				const response = await gatewayRequest(this, "POST", "/v1/subscriptions", { body });
				if (!succeeded(response)) {
					throw gatewayError(this, response);
				}
				const created = response.body as { id?: string; secret?: string };
				const data = this.getWorkflowStaticData("node");
				data.subscriptionId = created.id;
				// Checks each delivery's signature; the gateway shows it only once.
				data.secret = created.secret;
				data.fingerprint = fingerprint(body);
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const data = this.getWorkflowStaticData("node");
				if (typeof data.subscriptionId === "string") {
					const response = await gatewayRequest(
						this,
						"DELETE",
						`/v1/subscriptions/${encodeURIComponent(data.subscriptionId)}`,
					);
					if (!succeeded(response) && response.statusCode !== 404) {
						throw gatewayError(this, response);
					}
				}
				delete data.subscriptionId;
				delete data.secret;
				delete data.fingerprint;
				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const req = this.getRequestObject();
		const secret = this.getWorkflowStaticData("node").secret;
		const signature = req.headers["x-agx-signature"];
		const timestamp = Number(req.headers["x-agx-timestamp"]);
		// The signature covers the exact bytes the gateway sent.
		const raw = req.rawBody ? req.rawBody.toString("utf8") : JSON.stringify(this.getBodyData());
		const fresh =
			Number.isFinite(timestamp) && Math.abs(Date.now() / 1000 - timestamp) <= SIGNATURE_TOLERANCE_SEC;
		let valid = false;
		if (typeof secret === "string" && typeof signature === "string" && fresh) {
			const expected = Buffer.from(
				`v1=${createHmac("sha256", secret).update(`${timestamp}.${raw}`, "utf8").digest("hex")}`,
			);
			const given = Buffer.from(signature);
			valid = expected.length === given.length && timingSafeEqual(expected, given);
		}
		if (!valid) {
			const res = this.getResponseObject();
			res.status(401).json({ error: "This webhook only accepts deliveries signed by its agx gateway" });
			return { noWebhookResponse: true };
		}
		return {
			workflowData: [this.helpers.returnJsonArray(this.getBodyData())],
		};
	}
}
