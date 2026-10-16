import {
	AgxClient,
	DEFAULT_CONTENT_TYPE,
	matchesCapability,
} from "@nostr-agx/core";
import {
	type NostrTransport,
	resolveNip05,
	resolvePeerCardWithStatus,
	resolvePeerRelays,
	toNpub,
} from "@nostr-agx/nostr";
import {
	type IDataObject,
	type IExecuteFunctions,
	type INodeExecutionData,
	NodeOperationError,
} from "n8n-workflow";
import {
	autoReplyGuard,
	DEFAULT_AUTO_REPLY_LIMITS,
} from "../shared/auto-reply-guard";
import { type AgxIdentity, agxLogger } from "../shared/identity";
import { parsePeer } from "../shared/peers";

/** How often a pending request polls this agent's inbox for its result. */
const RESULT_POLL_MS = 1_000;

function nowSec(): number {
	return Math.floor(Date.now() / 1000);
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Run `work` for every item, keeping n8n's continue-on-fail contract: a
 * failing item becomes `{ error }` in the output instead of failing the node. */
async function perItem(
	ctx: IExecuteFunctions,
	items: INodeExecutionData[],
	work: (itemIndex: number) => Promise<IDataObject>,
): Promise<INodeExecutionData[]> {
	const out: INodeExecutionData[] = [];
	for (let i = 0; i < items.length; i++) {
		try {
			out.push({ json: await work(i), pairedItem: { item: i } });
		} catch (error) {
			if (ctx.continueOnFail()) {
				out.push({ json: { error: messageOf(error) }, pairedItem: { item: i } });
				continue;
			}
			throw error instanceof NodeOperationError
				? error
				: new NodeOperationError(ctx.getNode(), error as Error, {
						itemIndex: i,
					});
		}
	}
	return out;
}

function parsePayload(
	ctx: IExecuteFunctions,
	value: unknown,
	itemIndex: number,
): unknown {
	if (typeof value !== "string") {
		return value ?? {};
	}
	if (!value.trim()) {
		return {};
	}
	try {
		return JSON.parse(value);
	} catch (error) {
		throw new NodeOperationError(
			ctx.getNode(),
			`Payload is not valid JSON: ${messageOf(error)}`,
			{ itemIndex },
		);
	}
}

/** Agent → Get Own Identity. Local: no relay is contacted. */
export function getIdentity(
	items: INodeExecutionData[],
	identity: AgxIdentity,
): INodeExecutionData[] {
	return items.map((_, i) => ({
		json: {
			npub: identity.npub,
			pubkey: identity.publicKey,
			relays: identity.relays,
			org: identity.org,
			nip05: identity.nip05,
		},
		pairedItem: { item: i },
	}));
}

/**
 * Task → Request. Every item's request goes out at once through one client,
 * which then polls this agent's inbox until each has its result or times out:
 * n items cost one wait, not n.
 */
export async function requestTasks(
	ctx: IExecuteFunctions,
	items: INodeExecutionData[],
	transport: NostrTransport,
): Promise<INodeExecutionData[]> {
	// Start the cursor at now: the poll still reaches back the full NIP-59
	// backdate (two days), which is all a result sent from now on can be dated,
	// instead of reading the whole retained inbox from zero.
	const client = new AgxClient({
		transport,
		logger: agxLogger(ctx.logger),
		startCursor: nowSec(),
	});
	await client.start({ pollIntervalMs: 0, advertise: false });

	const request = async (i: number): Promise<IDataObject> => {
		const peer = parsePeer(ctx.getNodeParameter("peer", i) as string);
		const npub = toNpub(peer);
		const capability = (ctx.getNodeParameter("capability", i) as string).trim();
		if (!capability) {
			throw new NodeOperationError(ctx.getNode(), "Capability is empty", {
				itemIndex: i,
			});
		}
		const payload = parsePayload(ctx, ctx.getNodeParameter("payload", i, "{}"), i);
		const options = ctx.getNodeParameter("options", i, {}) as {
			checkCard?: boolean;
			timeout?: number;
		};
		const timeoutSec = options.timeout ?? 30;

		if (options.checkCard) {
			const { card } = await transport.resolvePeer(peer);
			if (!card) {
				throw new NodeOperationError(
					ctx.getNode(),
					`No Agent Card found for ${npub}`,
					{
						itemIndex: i,
						description:
							"Not every agent advertises one. Turn off Check Agent Card First to send the request anyway.",
					},
				);
			}
			if (!matchesCapability(card.capabilities, capability)) {
				throw new NodeOperationError(
					ctx.getNode(),
					`${card.displayName ?? npub} does not advertise "${capability}"`,
					{
						itemIndex: i,
						description: `Its card lists: ${card.capabilities.join(", ") || "no capabilities"}.`,
					},
				);
			}
		}

		let output: unknown;
		try {
			output = await client.request(peer, capability, payload, {
				timeoutMs: timeoutSec * 1000,
			});
		} catch (error) {
			const message = messageOf(error);
			if (message.startsWith("AGX request timed out")) {
				throw new NodeOperationError(
					ctx.getNode(),
					`No result from ${npub} within ${timeoutSec} seconds`,
					{
						itemIndex: i,
						description: `AGX denies by default and a denied request gets no reply, so first check that the agent has allowed this one (${toNpub(transport.whoami())}). Then check that it is running, serves "${capability}", and shares a relay with this agent or advertises its relays.`,
					},
				);
			}
			if (message.startsWith("AGX request:")) {
				throw new NodeOperationError(ctx.getNode(), message, { itemIndex: i });
			}
			// Anything else is the peer's own failure report: an `AgxPublicError`
			// message, or `handler failed` for an error it kept to itself.
			throw new NodeOperationError(
				ctx.getNode(),
				`${npub} reported that the task failed: ${message}`,
				{ itemIndex: i },
			);
		}
		return { peer: npub, capability, status: "completed", output: output as IDataObject };
	};

	// Settled results, so one item failing does not leave the others' requests
	// unanswered behind a thrown error.
	const outcomes = items.map((_, i) =>
		request(i).then(
			(json) => ({ ok: true as const, json }),
			(error: unknown) => ({ ok: false as const, error }),
		),
	);
	let settled = false;
	const all = Promise.all(outcomes).finally(() => {
		settled = true;
	});
	try {
		while (!settled) {
			await client.pump().catch((error) =>
				ctx.logger.warn("AGX: inbox poll failed; retrying", {
					error: messageOf(error),
				}),
			);
			await Promise.race([
				all,
				new Promise((resolve) => setTimeout(resolve, RESULT_POLL_MS)),
			]);
		}
	} finally {
		await client.stop();
	}

	const out: INodeExecutionData[] = [];
	for (const [i, outcome] of (await all).entries()) {
		if (outcome.ok) {
			out.push({ json: outcome.json, pairedItem: { item: i } });
		} else if (ctx.continueOnFail()) {
			out.push({
				json: { error: messageOf(outcome.error) },
				pairedItem: { item: i },
			});
		} else {
			throw outcome.error instanceof NodeOperationError
				? outcome.error
				: new NodeOperationError(ctx.getNode(), outcome.error as Error, {
						itemIndex: i,
					});
		}
	}
	return out;
}

/**
 * Message → Send. `AgxClient` has no plain-message send — the task lifecycle is
 * its surface — so this publishes through the transport, as `agx send` does.
 */
export async function sendMessages(
	ctx: IExecuteFunctions,
	items: INodeExecutionData[],
	transport: NostrTransport,
	identity: AgxIdentity,
): Promise<INodeExecutionData[]> {
	return perItem(ctx, items, async (i) => {
		const to = parsePeer(ctx.getNodeParameter("peer", i) as string);
		const text = ctx.getNodeParameter("text", i) as string;
		const options = ctx.getNodeParameter("options", i, {}) as {
			autoDepth?: number;
			contextId?: string;
			maxAutoDepth?: number;
			maxPerConversation?: number;
			maxPerHour?: number;
			subject?: string;
		};
		const depth = Math.max(0, Math.trunc(Number(options.autoDepth ?? 0)) || 0);
		const contextId = options.contextId?.trim() || null;

		const refusal = autoReplyGuard.admit(
			{ from: identity.publicKey, to, contextId: contextId ?? "", depth },
			{
				maxDepth: options.maxAutoDepth ?? DEFAULT_AUTO_REPLY_LIMITS.maxDepth,
				perConversation:
					options.maxPerConversation ??
					DEFAULT_AUTO_REPLY_LIMITS.perConversation,
				perPeerPerHour:
					options.maxPerHour ?? DEFAULT_AUTO_REPLY_LIMITS.perPeerPerHour,
			},
		);
		if (refusal) {
			throw new NodeOperationError(
				ctx.getNode(),
				"Automated reply not sent (loop protection)",
				{ itemIndex: i, description: `Not sent because ${refusal}` },
			);
		}

		const res = await transport.publishMessage(to, {
			text,
			subject: options.subject?.trim() || null,
			contextId,
			contentType: DEFAULT_CONTENT_TYPE,
			// Declared only on an automated reply; 0 is the same as absent.
			autoDepth: depth > 0 ? depth : undefined,
		});
		if (!res.ok) {
			const detail =
				res.rejected.length > 0
					? res.rejected.map((r) => `${r.relay} (${r.error})`).join("; ")
					: res.errors.join("; ") || "unknown error";
			// The same three cases `agx send` tells apart: refused before any
			// relay was contacted (too large), refused by every relay the
			// recipient reads, or not accepted by any relay at all.
			const message =
				res.total === 0
					? detail
					: res.accepted > 0 && res.deliveredToPeer === false
						? `Every relay ${toNpub(to)} reads from refused the message, so they will not see it: ${detail}`
						: `No relay accepted the message: ${detail}`;
			throw new NodeOperationError(ctx.getNode(), message, { itemIndex: i });
		}
		return {
			to: toNpub(to),
			eventId: res.eventId,
			contextId: res.contextId,
			autoDepth: depth,
			relaysAccepted: res.accepted,
			relaysTotal: res.total,
			// null: the recipient advertises no relays we could resolve, so
			// whether it reached a relay they read is unknown.
			deliveredToPeer: res.deliveredToPeer ?? null,
			rejected: res.rejected,
		};
	});
}

/** Agent → Get Card. */
export async function getCards(
	ctx: IExecuteFunctions,
	items: INodeExecutionData[],
	identity: AgxIdentity,
): Promise<INodeExecutionData[]> {
	return perItem(ctx, items, async (i) => {
		const peer = parsePeer(ctx.getNodeParameter("peer", i) as string);
		const options = ctx.getNodeParameter("options", i, {}) as {
			capability?: string;
			verifyNip05?: boolean;
		};
		const [{ card, reachable }, relays] = await Promise.all([
			resolvePeerCardWithStatus(peer, identity.relays, identity.signer),
			resolvePeerRelays(peer, identity.relays, identity.signer).catch(
				() => [] as string[],
			),
		]);
		if (!reachable) {
			throw new NodeOperationError(
				ctx.getNode(),
				`No relay answered (${identity.relays.join(", ")})`,
				{
					itemIndex: i,
					description:
						"Whether the agent has a card is unknown until a relay can be read.",
				},
			);
		}
		const verified =
			card?.nip05 && options.verifyNip05 !== false
				? await resolveNip05({
						pubkey: peer,
						relays: identity.relays,
						signer: identity.signer,
					}).catch(() => null)
				: null;
		const capability = options.capability?.trim();
		return {
			npub: toNpub(peer),
			pubkey: peer,
			found: card !== null,
			org: card?.displayName ?? null,
			capabilities: card?.capabilities ?? [],
			nip05: card?.nip05 ?? null,
			// null when there was nothing to verify or verification was off.
			nip05Verified:
				card?.nip05 && options.verifyNip05 !== false ? verified !== null : null,
			relays,
			...(capability
				? {
						capability,
						supportsCapability: matchesCapability(
							card?.capabilities ?? [],
							capability,
						),
					}
				: {}),
		};
	});
}
