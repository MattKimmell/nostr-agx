import {
	AgxEvidenceInvalidError,
	MAX_BODY,
	MAX_EVIDENCE_FIELDS,
	MAX_EVIDENCE_RECORDS,
	MAX_EVIDENCE_VALUE,
} from "@nostr-agx/core";
import { verifyEvent } from "nostr-tools";
import { describe, expect, it } from "vitest";
import {
	AgxPayloadTooLargeError,
	exchangeMessagePlaintextBytes,
	INTEROP_MAX_EVENT_BYTES,
	INTEROP_MAX_PLAINTEXT_BYTES,
	NIP44_MAX_PLAINTEXT_BYTES,
	nip44PaddedLen,
	signDeletionEvent,
	signMessageEvent,
	worstCaseEventBytes,
} from "./events";
import { unwrapRumor } from "./giftwrap";
import { generateKeypair } from "./keys";
import { CARD_KIND, DELETION_KIND } from "./kinds";
import { NostrTransport } from "./nostr-transport";
import { localSigner } from "./signer";

const sender = generateKeypair();
const recipient = generateKeypair();

describe("message size guard (NIP-44 plaintext cap)", () => {
	it("measures the SERIALIZED plaintext, not the raw body (JSON escaping counts)", async () => {
		// A body of pure quotes escapes to `\"` — ~2x — so its serialized size is far
		// larger than its char length. This is the double-escaping the old raw-length
		// guard missed.
		const raw = '"'.repeat(10_000);
		const bytes = exchangeMessagePlaintextBytes(raw);
		expect(bytes).toBeGreaterThan(raw.length * 1.5);
	});

	it("signMessageEvent throws a typed error instead of letting encrypt blow up", async () => {
		// 13k quotes: each escapes TWICE (into the payload JSON, then into the
		// rumor JSON) to ~4 bytes, so the rumor is ~53KB — under the 65535 cap on
		// its own — but the SEAL that carries it base64-inflates past the cap.
		// That is the layer a rumor-only guard would miss. Also UNDER MAX_BODY in
		// characters, so the character guard does not short-circuit it.
		//
		// Note this guard is unreachable through `publishMessage`, which rejects
		// at the tighter interop ceiling long before NIP-44's. It stays because
		// `signMessageEvent` is callable directly, and a typed throw beats
		// `nip44.encrypt` blowing up somewhere less legible.
		const oversized = '"'.repeat(13_000);
		expect(oversized.length).toBeLessThan(MAX_BODY);
		expect(exchangeMessagePlaintextBytes(oversized)).toBeLessThan(
			NIP44_MAX_PLAINTEXT_BYTES,
		);
		await expect(
			signMessageEvent({
				signer: localSigner(sender.secretKey),
				recipientPubkey: recipient.publicKey,
				text: oversized,
				nowSec: 1000,
			}),
		).rejects.toThrow(AgxPayloadTooLargeError);
	});

	it("a normal-sized body signs fine", async () => {
		const { event } = await signMessageEvent({
			signer: localSigner(sender.secretKey),
			recipientPubkey: recipient.publicKey,
			text: "hello there",
			nowSec: 1000,
		});
		expect(event.id).toMatch(/^[0-9a-f]{64}$/);
	});

	it("transport.canCarry reflects the serialized size, not the char count", async () => {
		const transport = await NostrTransport.create({
			signer: localSigner(sender.secretKey),
			relays: [],
		});
		// Same char count, opposite verdicts — which is the whole point.
		// Plain chars: ~1 byte each → an ~11KB rumor, a ~20KB wrap.
		expect(transport.canCarry("a".repeat(10_000))).toBe(true);
		// Escaped chars: ~4 bytes each (escaped twice) → a ~41KB rumor, past the
		// 28,672-byte interop ceiling.
		expect(transport.canCarry('"'.repeat(10_000))).toBe(false);
	});

	it("canCarry is bounded by RELAY interop, not by NIP-44's cap", async () => {
		const transport = await NostrTransport.create({
			signer: localSigner(sender.secretKey),
			relays: [],
		});
		// 8k QUOTE chars — each escapes twice, to ~4 bytes — make a ~33KB rumor
		// whose seal is ~50KB: both comfortably under NIP-44's 65535 plaintext
		// cap, so it encrypts and signs without complaint. It is still
		// undeliverable: the wrap around that seal is ~76KB, which a
		// default-configured peer relay refuses. Before the interop ceiling this
		// returned true and the message was silently lost at the recipient's
		// relay.
		//
		// Escaped rather than plain chars on purpose: the body must stay UNDER
		// MAX_BODY so the character guard does not short-circuit the check.
		const text = '"'.repeat(8_000);
		expect(exchangeMessagePlaintextBytes(text)).toBeLessThan(
			NIP44_MAX_PLAINTEXT_BYTES,
		);
		expect(transport.canCarry(text)).toBe(false);
	});

	it("models NIP-44 padding as the spec does, not as powers of two", async () => {
		// The spec's own test vector. A next-power-of-two model answers 131072
		// here, and this repo shipped one — described in prose as a "step
		// function" with nothing in between, which is how a 2x-pessimistic bound
		// became the justification for cutting MAX_BODY. Overhead above a power of
		// two is capped at 12.5%.
		expect(nip44PaddedLen(74_123)).toBe(81_920);
		// The boundary that claim got wrong: 32769 does not double to 87892.
		expect(nip44PaddedLen(32_769)).toBe(40_960);
	});

	it("derives an interop ceiling that is not a power of two", async () => {
		// 28672 (7 x 4096), a chunk multiple. A doubling search cannot express
		// it and would silently return 16384 even against a correct padding
		// function, which is exactly the class of error the first version of
		// this constant made. Two NIP-44 layers (seal inside wrap) are why it
		// sits well below the single-layer 40960 it used to be.
		expect(INTEROP_MAX_PLAINTEXT_BYTES).toBe(28_672);
		expect(
			worstCaseEventBytes(INTEROP_MAX_PLAINTEXT_BYTES),
		).toBeLessThanOrEqual(INTEROP_MAX_EVENT_BYTES);
		expect(
			worstCaseEventBytes(INTEROP_MAX_PLAINTEXT_BYTES + 32),
		).toBeGreaterThan(INTEROP_MAX_EVENT_BYTES);
	});

	it("publishMessage fails cleanly (ok:false) on oversize — never throws / 500s", async () => {
		const transport = await NostrTransport.create({
			signer: localSigner(sender.secretKey),
			relays: [],
		});
		// Under MAX_BODY in CHARACTERS (25k), over the interop ceiling in BYTES
		// (a ~101KB rumor). That combination is what routes this to the byte
		// guard; a body over MAX_BODY would trip the character guard first and
		// assert the wrong message.
		const res = await transport.publishMessage(recipient.publicKey, {
			text: '"'.repeat(25_000),
		});
		expect(res.ok).toBe(false);
		expect(res.accepted).toBe(0);
		// Rejected for being UNDELIVERABLE (the relay ceiling) rather than
		// unencryptable (NIP-44's) — the interop bound is the tighter of the two,
		// so it is the one a caller hits first and the one worth naming.
		expect(res.errors.join(" ")).toContain(String(INTEROP_MAX_EVENT_BYTES));
	});

	it("refuses an over-long body instead of sending it truncated", async () => {
		// THE SILENT-LOSS BUG. `buildExchangePayload` used to `.slice(0, MAX_BODY)`,
		// and `exchangeMessagePlaintextBytes` measures a payload built through that
		// same function — so an over-long body was measured AFTER being cut, passed
		// every byte check, and was published with its tail missing under a
		// reported `ok: true`. `agx send` calls this method directly, so nothing
		// upstream caught it.
		//
		// Both halves matter: canCarry must stop claiming it fits, and
		// publishMessage must refuse rather than silently shorten.
		const transport = await NostrTransport.create({
			signer: localSigner(sender.secretKey),
			relays: [],
		});
		const overLong = "a".repeat(MAX_BODY + 1);
		expect(transport.canCarry(overLong)).toBe(false);

		const res = await transport.publishMessage(recipient.publicKey, {
			text: overLong,
		});
		expect(res.ok).toBe(false);
		expect(res.accepted).toBe(0);
		// Names the CHARACTER limit, because that is the one the caller can act
		// on — telling them about a byte ceiling here would be unactionable.
		expect(res.errors.join(" ")).toContain(String(MAX_BODY));
	});

	it("still sends a body of exactly MAX_BODY", async () => {
		// The guard must not cost the last character. Asserted through canCarry
		// rather than a publish, since with no relays configured a publish cannot
		// distinguish "refused by the guard" from "nowhere to send it".
		const transport = await NostrTransport.create({
			signer: localSigner(sender.secretKey),
			relays: [],
		});
		expect(transport.canCarry("a".repeat(MAX_BODY))).toBe(true);
	});
});

describe("evidence in the size guard", () => {
	const record = {
		key: { field: "roNumber", value: "0057658556" },
		fields: { status: "Repair In Process", branch: "Eastside" },
		observedAt: "2026-10-20T14:03:11.000Z",
		source: "DMS",
	};
	function evidenceOf(records: number, valueChars = 20) {
		return {
			v: 1 as const,
			records: Array.from({ length: records }, () => ({
				...record,
				fields: Object.fromEntries(
					Array.from({ length: MAX_EVIDENCE_FIELDS }, (_, i) => [
						`field${i}`,
						"x".repeat(valueChars),
					]),
				),
			})),
		};
	}

	// The guard must measure the rumor that is signed. Measured without the
	// evidence it under-counts, and a message near the limit passes the guard
	// and is refused by the recipient's relay.
	it("measures the rumor that is actually signed, evidence included", async () => {
		const evidence = evidenceOf(5);
		const text = "hello there";
		const { event } = await signMessageEvent({
			signer: localSigner(sender.secretKey),
			recipientPubkey: recipient.publicKey,
			text,
			evidence,
			nowSec: 1000,
		});
		const unwrapped = await unwrapRumor({
			signer: localSigner(recipient.secretKey),
			event,
		});
		const signedBytes = new TextEncoder().encode(
			JSON.stringify(unwrapped?.rumor),
		).length;

		const measured = exchangeMessagePlaintextBytes(text, { evidence });
		const withoutEvidence = exchangeMessagePlaintextBytes(text);
		expect(measured).toBeGreaterThanOrEqual(signedBytes);
		expect(withoutEvidence).toBeLessThan(signedBytes);
		// Escaped twice (payload, then rumor), so it costs more than its JSON.
		expect(measured - withoutEvidence).toBeGreaterThan(
			JSON.stringify(evidence).length,
		);
	});

	it("publishMessage refuses a body that fits only without its evidence", async () => {
		const transport = await NostrTransport.create({
			signer: localSigner(sender.secretKey),
			relays: [],
		});
		const text = "a".repeat(20_000);
		expect(transport.canCarry(text)).toBe(true);

		const res = await transport.publishMessage(recipient.publicKey, {
			text,
			evidence: evidenceOf(10, 100),
		});
		expect(res.ok).toBe(false);
		expect(res.accepted).toBe(0);
		const error = res.errors.join(" ");
		expect(error).toContain(String(INTEROP_MAX_EVENT_BYTES));
		expect(error).toContain("cite fewer evidence records");
		// Still names a character target for the body, scaled to what the
		// evidence leaves rather than to the whole budget.
		const target = Number(/roughly (\d+) characters/.exec(error)?.[1]);
		expect(target).toBeGreaterThan(0);
		expect(target).toBeLessThan(text.length);
	});

	it("publishMessage says so when the evidence alone is over the budget", async () => {
		const transport = await NostrTransport.create({
			signer: localSigner(sender.secretKey),
			relays: [],
		});
		const res = await transport.publishMessage(recipient.publicKey, {
			text: "short",
			evidence: evidenceOf(MAX_EVIDENCE_RECORDS, MAX_EVIDENCE_VALUE),
		});
		expect(res.ok).toBe(false);
		expect(res.errors.join(" ")).toContain("The evidence alone takes");
	});

	it("publishMessage refuses evidence outside the schema instead of throwing", async () => {
		const transport = await NostrTransport.create({
			signer: localSigner(sender.secretKey),
			relays: [],
		});
		const res = await transport.publishMessage(recipient.publicKey, {
			text: "short",
			evidence: {
				v: 1,
				records: [{ ...record, observedAt: "last Tuesday" }],
			},
		});
		expect(res.ok).toBe(false);
		expect(res.accepted).toBe(0);
		expect(res.errors.join(" ")).toContain("records.0.observedAt");
	});

	it("signMessageEvent refuses evidence outside the schema", async () => {
		await expect(
			signMessageEvent({
				signer: localSigner(sender.secretKey),
				recipientPubkey: recipient.publicKey,
				text: "short",
				evidence: evidenceOf(MAX_EVIDENCE_RECORDS + 1),
				nowSec: 1000,
			}),
		).rejects.toThrow(AgxEvidenceInvalidError);
	});
});

describe("NIP-09 deletion (Agent Card retraction)", () => {
	it("signs a valid kind-5 event tagging every id to retract", async () => {
		const event = await signDeletionEvent({
			signer: localSigner(sender.secretKey),
			eventIds: ["card-event-1", "card-event-2"],
			nowSec: 1000,
		});

		expect(event.kind).toBe(DELETION_KIND);
		expect(event.pubkey).toBe(sender.publicKey);
		expect(verifyEvent(event)).toBe(true);
		expect(event.tags.filter((t) => t[0] === "e").map((t) => t[1])).toEqual(
			["card-event-1", "card-event-2"],
		);
	});

	it("names the Agent Card kind so relays can retract the REPLACEABLE event too", async () => {
		// A kind-11337 card is replaceable: without a `k` tag a relay has no reason
		// to apply the deletion to the addressable form, and the card would linger.
		const event = await signDeletionEvent({
			signer: localSigner(sender.secretKey),
			eventIds: ["card-event-1"],
			nowSec: 1000,
		});
		expect(event.tags).toContainEqual(["k", String(CARD_KIND)]);
	});

	it("is UNENCRYPTED and carries the reason verbatim in content", async () => {
		// Relays must be able to read the tags to act on it, so there is nothing to
		// encrypt — and the card it retracts was already public.
		const event = await signDeletionEvent({
			signer: localSigner(sender.secretKey),
			eventIds: ["card-event-1"],
			reason: "de-listed from the agent index",
			nowSec: 1000,
		});
		expect(event.content).toBe("de-listed from the agent index");
	});

	it("defaults content to an empty string when no reason is given", async () => {
		const event = await signDeletionEvent({
			signer: localSigner(sender.secretKey),
			eventIds: ["card-event-1"],
			nowSec: 1000,
		});
		expect(event.content).toBe("");
		expect(verifyEvent(event)).toBe(true);
	});
});
