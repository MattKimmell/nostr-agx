import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgxClient } from "@nostr-agx/core";
import { generateKeypair, localSigner, NostrTransport, toNpub } from "@nostr-agx/nostr";
import type {
	ICredentialDataDecryptedObject,
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestOptions,
	INode,
	INodeExecutionData,
	IWebhookFunctions,
	IWebhookResponseData,
} from "n8n-workflow";
import WebSocket from "ws";
// The CLI's gateway and in-process relay, from source.
import { updateProfile } from "../../cli/src/lib/config";
import { type RunningGateway, startGateway } from "../../cli/src/lib/gateway/gateway";
import { createGatewayKey } from "../../cli/src/lib/gateway/keys";
import { createIdentity, saveIdentity } from "../../cli/src/lib/identity";
import { type RunningRelay, startRelay } from "../../cli/src/relay/server";
import { AgxGatewayTrigger } from "../nodes/AgxGatewayTrigger/AgxGatewayTrigger.node";

export type { RunningGateway, RunningRelay };

/**
 * A gateway on a throwaway AGX_HOME, on its own relay, with one API key: what
 * a person sets up with `agx identity new`, `agx config set relays` and
 * `agx gateway key new` before `agx gateway`.
 */
export async function startTestGateway() {
	const savedHome = process.env.AGX_HOME;
	const home = mkdtempSync(join(tmpdir(), "agx-n8n-gateway-test-"));
	process.env.AGX_HOME = home;
	const relay = await startRelay({ port: 0 });
	const profile = "default";
	saveIdentity(profile, createIdentity());
	updateProfile(profile, { relays: [`ws://127.0.0.1:${relay.port}`] });
	const key = createGatewayKey(profile, "n8n test").key;
	const gateway = await startGateway({ profile, port: 0, pollIntervalMs: 200, deliveryRetryDelaysMs: [100] });
	return {
		relay,
		gateway,
		key,
		credentials: { url: gateway.url, apiKey: key } as ICredentialDataDecryptedObject,
		async close() {
			await gateway.close();
			await relay.close();
			if (savedHome === undefined) {
				delete process.env.AGX_HOME;
			} else {
				process.env.AGX_HOME = savedHome;
			}
			rmSync(home, { recursive: true, force: true });
		},
	};
}

/** Another AGX agent on the relay: the other side of a test. */
export async function peer(
	relay: RunningRelay,
	options: Partial<ConstructorParameters<typeof AgxClient>[0]> = {},
) {
	const { secretKey, publicKey } = generateKeypair();
	const transport = await NostrTransport.create({
		signer: localSigner(secretKey),
		relays: [`ws://127.0.0.1:${relay.port}`],
		ws: WebSocket,
	});
	const client = new AgxClient({ transport, startCursor: Math.floor(Date.now() / 1000) - 60, ...options });
	return { client, transport, publicKey, npub: toNpub(publicKey) };
}

/** Pump `client` until `promise` settles. */
export async function pumping<T>(promise: Promise<T>, client: AgxClient): Promise<T> {
	let settled = false;
	const watched = promise.finally(() => {
		settled = true;
	});
	watched.catch(() => undefined);
	while (!settled) {
		await client.pump();
		await new Promise((r) => setTimeout(r, 150));
	}
	return watched;
}

export async function waitFor<T>(check: () => T | undefined | false, timeoutMs = 20_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = check();
		if (value) {
			return value;
		}
		if (Date.now() > deadline) {
			throw new Error("waitFor: condition not met in time");
		}
		await new Promise((r) => setTimeout(r, 100));
	}
}

/**
 * n8n's `httpRequestWithAuthentication` for this package's one credential:
 * the credential's `authenticate` block (a Bearer header) on a JSON request.
 */
function authenticatedRequest(credentials: ICredentialDataDecryptedObject) {
	return async (_type: string, request: IHttpRequestOptions) => {
		const url = new URL(request.url);
		for (const [name, value] of Object.entries(request.qs ?? {})) {
			url.searchParams.set(name, String(value));
		}
		const res = await fetch(url, {
			method: request.method,
			headers: {
				authorization: `Bearer ${String(credentials.apiKey)}`,
				...(request.body ? { "content-type": "application/json" } : {}),
			},
			body: request.body ? JSON.stringify(request.body) : undefined,
			signal: AbortSignal.timeout(request.timeout ?? 300_000),
		});
		const text = await res.text();
		const body: unknown = text ? JSON.parse(text) : "";
		if (!request.ignoreHttpStatusErrors && res.status >= 400) {
			throw new Error(`Request failed with status code ${res.status}`);
		}
		return request.returnFullResponse ? { statusCode: res.status, headers: {}, body } : body;
	};
}

function node(type: string, name: string): INode {
	return {
		id: `${name}-node`,
		name,
		type: `@nostr-agx/n8n-nodes-agx-gateway.${type}`,
		typeVersion: 1,
		position: [0, 0],
		parameters: {},
	};
}

/** The slice of n8n's `IExecuteFunctions` the AGX Gateway node uses. `params`
 * gives each item's parameters. */
export function executeContext(opts: {
	credentials: ICredentialDataDecryptedObject;
	params: (itemIndex: number) => IDataObject;
	items?: number;
	continueOnFail?: boolean;
}): IExecuteFunctions {
	const items: INodeExecutionData[] = Array.from({ length: opts.items ?? 1 }, () => ({ json: {} }));
	const ctx = {
		getInputData: () => items,
		getNodeParameter: (name: string, itemIndex: number, fallback?: unknown) => opts.params(itemIndex)[name] ?? fallback,
		getCredentials: async () => opts.credentials,
		getNode: () => node("agxGateway", "AGX Gateway"),
		continueOnFail: () => opts.continueOnFail ?? false,
		helpers: { httpRequestWithAuthentication: authenticatedRequest(opts.credentials) },
	};
	return ctx as unknown as IExecuteFunctions;
}

export interface Received {
	headers: IncomingHttpHeaders;
	json: IDataObject;
}

/** What a workflow does with the trigger's items: their output, or a throw. */
export type Workflow = (items: INodeExecutionData[]) => INodeExecutionData[] | Promise<INodeExecutionData[]>;

/**
 * An n8n instance with one AGX Gateway Trigger in one workflow, as far as the
 * trigger can tell: the webhook lifecycle (`checkExists`, `create`, `delete`)
 * with the node's static data, and a production webhook URL whose requests go
 * through the node's `webhook()` and then `workflow`, answered the way n8n
 * answers them (`lastNode` for a task, `onReceived` otherwise).
 */
export async function n8nHost(opts: {
	credentials: ICredentialDataDecryptedObject;
	params: IDataObject;
	workflow?: Workflow;
}) {
	const trigger = new AgxGatewayTrigger();
	const staticData: IDataObject = {};
	let params = opts.params;
	let workflow: Workflow = opts.workflow ?? ((items) => items);
	/** Requests the webhook let through to the workflow. */
	const runs: Received[] = [];
	/** Every request the webhook URL got, and what it answered. */
	const requests: { status: number; body: unknown }[] = [];

	const server: Server = createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			void (async () => {
				const rawBody = Buffer.concat(chunks);
				const body = (rawBody.length ? JSON.parse(rawBody.toString("utf8")) : {}) as IDataObject;
				const answer = (status: number, out: unknown) => {
					requests.push({ status, body: out });
					res.writeHead(status, { "content-type": "application/json" });
					res.end(JSON.stringify(out));
				};
				let answered = false;
				const response = {
					status(code: number) {
						return {
							json(out: unknown) {
								answered = true;
								answer(code, out);
							},
						};
					},
				};
				const ctx = {
					getRequestObject: () => ({ headers: req.headers, rawBody, body }),
					getBodyData: () => body,
					getResponseObject: () => response,
					getWorkflowStaticData: () => staticData,
					getNodeParameter: (name: string, fallback?: unknown) => params[name] ?? fallback,
					getNode: () => node("agxGatewayTrigger", "AGX Gateway Trigger"),
					helpers: {
						returnJsonArray: (data: IDataObject | IDataObject[]) =>
							(Array.isArray(data) ? data : [data]).map((json) => ({ json })),
					},
				} as unknown as IWebhookFunctions;
				let result: IWebhookResponseData;
				try {
					result = await trigger.webhook.call(ctx);
				} catch (error) {
					answer(500, { message: (error as Error).message });
					return;
				}
				if (result.noWebhookResponse) {
					if (!answered) {
						answer(500, { message: "noWebhookResponse without an answer" });
					}
					return;
				}
				const items = result.workflowData?.[0] ?? [];
				runs.push({ headers: req.headers, json: items[0]?.json ?? {} });
				const events = (params.events as string[] | undefined) ?? ["task"];
				const options = (params.options as IDataObject | undefined) ?? {};
				if (!events.includes("task")) {
					answer(200, { message: "Workflow was started" });
					void Promise.resolve(workflow(items)).catch(() => undefined);
					return;
				}
				try {
					const output = await workflow(items);
					answer(200, options.result === "allItems" ? output.map((item) => item.json) : (output[0]?.json ?? {}));
				} catch {
					answer(500, { message: "Error in workflow" });
				}
			})();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/webhook/test-webhook-id/webhook`;

	const hookContext = () =>
		({
			getNodeParameter: (name: string, fallback?: unknown) => params[name] ?? fallback,
			getNodeWebhookUrl: () => url,
			getWorkflowStaticData: () => staticData,
			getWorkflow: () => ({ id: "wf-1", name: "Invoice review", active: true }),
			getCredentials: async () => opts.credentials,
			getNode: () => node("agxGatewayTrigger", "AGX Gateway Trigger"),
			helpers: { httpRequestWithAuthentication: authenticatedRequest(opts.credentials) },
		}) as unknown as IHookFunctions;
	const methods = trigger.webhookMethods.default;

	return {
		url,
		staticData,
		runs,
		requests,
		setParams(next: IDataObject) {
			params = next;
		},
		setWorkflow(next: Workflow) {
			workflow = next;
		},
		checkExists: () => methods.checkExists.call(hookContext()),
		create: () => methods.create.call(hookContext()),
		delete: () => methods.delete.call(hookContext()),
		/** What n8n does when the workflow is turned on. */
		async activate() {
			if (!(await methods.checkExists.call(hookContext()))) {
				await methods.create.call(hookContext());
			}
		},
		async close() {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
		},
	};
}
