import { describe, expect, it } from "vitest";
import { AgxBodyTooLongError, AgxEvidenceInvalidError } from "./errors";
import {
	buildExchangePayload,
	buildReceiptPayload,
	DEFAULT_CONTENT_TYPE,
	exchangeEvidenceProblem,
	MAX_BODY,
	MAX_EVIDENCE_FIELDS,
	MAX_EVIDENCE_NAME,
	MAX_EVIDENCE_RECORDS,
	MAX_EVIDENCE_VALUE,
	MAX_INBOUND_BODY,
	MAX_SUBJECT,
	isUnknownStatusReceipt,
	parseExchangePayload,
	parseReceiptPayload,
	registerContentType,
} from "./wire";

describe("exchange message payload", () => {
	it("round-trips build → parse with the default content type", () => {
		const payload = buildExchangePayload({
			text: "hello",
			contextId: "ctx1",
			messageId: "m1",
			subject: "Re: Q3",
		});
		expect(payload.contentType).toBe(DEFAULT_CONTENT_TYPE);
		expect(parseExchangePayload(payload)).toEqual({
			text: "hello",
			contextId: "ctx1",
			messageId: "m1",
			subject: "Re: Q3",
			// Not an automated reply, so the builder omits the field and the parser
			// reports it as unknown — which every reader must treat as zero.
			autoDepth: null,
			contentType: DEFAULT_CONTENT_TYPE,
		});
	});

	// The one field on this payload that exists to terminate a loop, so its
	// back-compat story has to be airtight in both directions.
	describe("automated-reply depth", () => {
		const base = { text: "hello", contextId: "ctx1", messageId: "m1" };

		it("round-trips a declared depth", () => {
			const payload = buildExchangePayload({ ...base, autoDepth: 3 });
			expect(payload.autoDepth).toBe(3);
			expect(parseExchangePayload(payload)?.autoDepth).toBe(3);
		});

		// Omitted rather than written as 0, so a message from a peer that has never
		// heard of the field is byte-identical to one from a peer that has.
		it("omits the field entirely at depth zero", () => {
			expect(buildExchangePayload(base)).not.toHaveProperty("autoDepth");
			expect(
				buildExchangePayload({ ...base, autoDepth: 0 }),
			).not.toHaveProperty("autoDepth");
		});

		// Old sender → new receiver. Absent means unknown, which means zero; it
		// must never be an error, or adding the field would break the network.
		it("reads a payload with no depth as unknown, not as invalid", () => {
			const legacy = buildExchangePayload(base);
			const parsed = parseExchangePayload(legacy);
			expect(parsed).not.toBeNull();
			expect(parsed?.autoDepth).toBeNull();
		});

		// New sender → old receiver. The schema is non-strict, so a parser that
		// predates the field strips it and carries on.
		it("survives a peer that does not know the field", () => {
			const payload = buildExchangePayload({ ...base, autoDepth: 5 });
			const { autoDepth: _ignored, ...withoutIt } = payload;
			expect(parseExchangePayload(withoutIt)?.autoDepth).toBeNull();
		});

		// THE RULE: this field bounds REPLIES, never DELIVERY. An unusable value is
		// "unknown", exactly like an absent one — because the alternative is that a
		// peer whose counter does not saturate at 255, or that ships a float, fails
		// the whole payload and becomes SILENTLY UNREACHABLE, with its operator
		// seeing a decrypt failure for what is really a range violation.
		it("treats an unusable depth as unknown, and still delivers the message", () => {
			const payload = buildExchangePayload(base);
			for (const bad of [
				-1,
				1.5,
				256,
				99_999,
				Number.NaN,
				"seven",
				null,
			]) {
				const parsed = parseExchangePayload({
					...payload,
					autoDepth: bad,
				});
				expect(parsed, `autoDepth: ${String(bad)}`).not.toBeNull();
				expect(parsed?.text, `autoDepth: ${String(bad)}`).toBe("hello");
				expect(
					parsed?.autoDepth,
					`autoDepth: ${String(bad)}`,
				).toBeNull();
			}
		});

		// A caller bug must not be able to produce mail the far end cannot receive,
		// so the builder coerces rather than emitting something out of range.
		it("sanitizes a caller's depth instead of emitting it", () => {
			expect(
				buildExchangePayload({ ...base, autoDepth: 99_999 }).autoDepth,
			).toBe(255);
			expect(
				buildExchangePayload({ ...base, autoDepth: 3.7 }).autoDepth,
			).toBe(3);
			// Anything that cannot be a positive depth is simply omitted.
			for (const bad of [
				-1,
				0,
				0.4,
				Number.NaN,
				Number.POSITIVE_INFINITY,
			]) {
				expect(
					buildExchangePayload({ ...base, autoDepth: bad }),
					`autoDepth: ${String(bad)}`,
				).not.toHaveProperty("autoDepth");
			}
		});
	});

	describe("evidence", () => {
		const base = { text: "hello", contextId: "ctx1", messageId: "m1" };
		const record = {
			key: { field: "roNumber", value: "0057658556" },
			fields: { status: "Repair In Process", branch: "Eastside", bays: 2 },
			observedAt: "2026-10-20T14:03:11.000Z",
			source: "DMS",
		};
		const evidence = { v: 1 as const, records: [record] };

		function withFields(count: number): Record<string, string> {
			return Object.fromEntries(
				Array.from({ length: count }, (_, i) => [`f${i}`, "x"]),
			);
		}

		it("round-trips through the wire as sent", () => {
			const payload = buildExchangePayload({ ...base, evidence });
			const parsed = parseExchangePayload(
				JSON.parse(JSON.stringify(payload)),
			);
			expect(parsed?.evidence).toEqual(evidence);
			expect(parsed?.text).toBe("hello");
		});

		// Absent, not `evidence: undefined` or `null`, so a sender without evidence
		// signs exactly the bytes it signed before this member existed.
		it("leaves a payload without evidence byte-identical", () => {
			const payload = buildExchangePayload(base);
			expect(payload).not.toHaveProperty("evidence");
			expect(JSON.stringify(payload)).toBe(
				JSON.stringify({
					v: 1,
					kind: "message",
					contentType: DEFAULT_CONTENT_TYPE,
					role: "user",
					messageId: "m1",
					contextId: "ctx1",
					parts: [{ text: "hello" }],
					subject: null,
				}),
			);
		});

		it("parses a payload without evidence as before", () => {
			const parsed = parseExchangePayload(buildExchangePayload(base));
			expect(parsed).toStrictEqual({
				text: "hello",
				contextId: "ctx1",
				messageId: "m1",
				subject: null,
				autoDepth: null,
				contentType: DEFAULT_CONTENT_TYPE,
			});
		});

		// The `autoDepth` rule again: evidence never affects delivery. It is
		// dropped WHOLE, never down to the records that happened to parse.
		it("drops unreadable evidence whole and still delivers the message", () => {
			const payload = buildExchangePayload(base);
			const cases: [string, unknown][] = [
				["a string", "verified"],
				["null", null],
				["an unknown version", { ...evidence, v: 2 }],
				["no records", { v: 1, records: [] }],
				["records not an array", { v: 1, records: record }],
				[
					"too many records",
					{ v: 1, records: Array(MAX_EVIDENCE_RECORDS + 1).fill(record) },
				],
				["no fields", { v: 1, records: [{ ...record, fields: {} }] }],
				[
					"too many fields",
					{
						v: 1,
						records: [
							{ ...record, fields: withFields(MAX_EVIDENCE_FIELDS + 1) },
						],
					},
				],
				[
					"an over-long value",
					{
						v: 1,
						records: [
							{
								...record,
								fields: { status: "x".repeat(MAX_EVIDENCE_VALUE + 1) },
							},
						],
					},
				],
				[
					"an over-long field name",
					{
						v: 1,
						records: [
							{
								...record,
								fields: { ["x".repeat(MAX_EVIDENCE_NAME + 1)]: "ok" },
							},
						],
					},
				],
				[
					"a nested field value",
					{ v: 1, records: [{ ...record, fields: { status: { a: 1 } } }] },
				],
				[
					"a boolean key value",
					{
						v: 1,
						records: [{ ...record, key: { field: "id", value: true } }],
					},
				],
				[
					"a non-ISO observedAt",
					{ v: 1, records: [{ ...record, observedAt: "yesterday" }] },
				],
				[
					"one bad record among good ones",
					{ v: 1, records: [record, { ...record, observedAt: 7 }] },
				],
			];
			for (const [label, bad] of cases) {
				const parsed = parseExchangePayload({ ...payload, evidence: bad });
				expect(parsed, label).not.toBeNull();
				expect(parsed?.text, label).toBe("hello");
				expect(parsed?.evidence, label).toBeUndefined();
				expect(parsed, label).not.toHaveProperty("evidence");
			}
		});

		it("accepts evidence exactly at its caps", () => {
			const atCaps = {
				v: 1 as const,
				records: Array.from({ length: MAX_EVIDENCE_RECORDS }, () => ({
					key: {
						field: "k".repeat(MAX_EVIDENCE_NAME),
						value: "v".repeat(MAX_EVIDENCE_VALUE),
					},
					fields: Object.fromEntries(
						Array.from({ length: MAX_EVIDENCE_FIELDS }, (_, i) => [
							`${i}`.padEnd(MAX_EVIDENCE_NAME, "n"),
							"v".repeat(MAX_EVIDENCE_VALUE),
						]),
					),
					observedAt: "2026-10-20T10:03:11-04:00",
					source: "s".repeat(MAX_EVIDENCE_NAME),
				})),
			};
			expect(exchangeEvidenceProblem(atCaps)).toBeNull();
			const payload = buildExchangePayload({ ...base, evidence: atCaps });
			expect(parseExchangePayload(payload)?.evidence).toEqual(atCaps);
		});

		// A sender must not sign evidence the receiver will drop: the caller
		// would believe it delivered records nobody can see.
		it("refuses evidence past its caps at the sender", () => {
			const tooMany = {
				v: 1 as const,
				records: Array(MAX_EVIDENCE_RECORDS + 1).fill(record),
			};
			expect(exchangeEvidenceProblem(tooMany)).toContain("records");
			expect(() =>
				buildExchangePayload({ ...base, evidence: tooMany }),
			).toThrow(AgxEvidenceInvalidError);

			const tooLong = {
				v: 1 as const,
				records: [
					{ ...record, fields: { note: "x".repeat(MAX_EVIDENCE_VALUE + 1) } },
				],
			};
			expect(exchangeEvidenceProblem(tooLong)).toContain(
				"records.0.fields.note",
			);
			expect(() =>
				buildExchangePayload({ ...base, evidence: tooLong }),
			).toThrow(AgxEvidenceInvalidError);

			expect(exchangeEvidenceProblem(undefined)).toBeNull();
			expect(exchangeEvidenceProblem(evidence)).toBeNull();
		});

		// What ships is the parsed copy, so a caller's internal bookkeeping
		// cannot leak to another organization by riding along on a record.
		it("signs only the members the schema names", () => {
			const withExtras = {
				v: 1 as const,
				records: [{ ...record, toolCallId: "call_123" }],
				internal: true,
			};
			const payload = buildExchangePayload({ ...base, evidence: withExtras });
			expect(JSON.stringify(payload)).not.toContain("call_123");
			expect(payload.evidence).toEqual(evidence);
		});
	});

	it("rejects an unknown content type (payload-agnostic dispatch)", () => {
		const payload = {
			...buildExchangePayload({
				text: "x",
				contextId: "c",
				messageId: "m",
			}),
			contentType: "application/x-evil",
		};
		expect(parseExchangePayload(payload)).toBeNull();
	});

	it("accepts a content type once registered", () => {
		registerContentType("application/x-paperclip");
		const payload = {
			...buildExchangePayload({
				text: "x",
				contextId: "c",
				messageId: "m",
			}),
			contentType: "application/x-paperclip",
		};
		expect(parseExchangePayload(payload)?.contentType).toBe(
			"application/x-paperclip",
		);
	});

	it("rejects a malformed payload and an empty-text payload", () => {
		expect(parseExchangePayload({ nope: true })).toBeNull();
		const empty = buildExchangePayload({
			text: "",
			contextId: "c",
			messageId: "m",
		});
		expect(parseExchangePayload(empty)).toBeNull();
	});

	it("pins MAX_BODY's VALUE, not just its relationships", () => {
		// Everything else about this constant is pinned relatively —
		// MAX_BODY_BYTES === INTEROP_MAX_PLAINTEXT_BYTES, MAX_INBOUND_BODY >
		// MAX_BODY — so all of it follows MAX_BODY wherever it goes. Meanwhile
		// nostr-transport.test.ts builds its boundary case from a HARDCODED
		// "a".repeat(27_400), calibrated to straddle a NIP-44 chunk boundary
		// once the real subject is counted. Change MAX_BODY and nothing fails:
		// that test quietly starts exercising a different guard than the one it
		// names. This is the assertion that makes the change visible.
		expect(MAX_BODY).toBe(27_400);
	});

	it("REJECTS a body over MAX_BODY instead of silently shortening it", () => {
		// This used to assert `parsed?.text.length === MAX_BODY` — i.e. it pinned
		// the truncation as intended behaviour. It was not: because
		// `exchangeMessagePlaintextBytes` measures a payload built through this
		// same function, an over-long body was measured AFTER being cut, passed
		// every size guard, and went out on the wire missing its tail while the
		// sender was told it succeeded. `agx send` dropped 20,000 characters
		// without a word.
		//
		// The property being guarded is unchanged — nothing over-long reaches the
		// wire. Only the mechanism changed, from quietly shortening to refusing.
		const long = "a".repeat(MAX_BODY + 500);
		expect(() =>
			buildExchangePayload({
				text: long,
				contextId: "c",
				messageId: "m",
			}),
		).toThrow(AgxBodyTooLongError);
	});

	it("does NOT truncate an inbound body at our own send cap", () => {
		// THE RECEIVE-SIDE HALF. MAX_BODY is what WE send; a peer is bound by
		// NIP-44, not by our interop choice, and a recipient can raise its own inbox
		// relay's maxEventSize to receive all of it. (The send cap is lower because a
		// PEER's relay is likely on strfry's 65536 default.) While these were
		// one constant, lowering the send cap 50_000 -> 40_000 also moved where
		// `parseExchangePayload` quietly dropped the tail of an INBOUND body — so
		// a protocol-valid 45_000-character message from a peer (including a peer
		// running the previous version of this code) was accepted, decrypted,
		// signature-verified, stored 5_000 characters short, and acknowledged as
		// delivered.
		const fromPeer = "b".repeat(45_000);
		const parsed = parseExchangePayload({
			v: 1,
			kind: "message",
			contentType: DEFAULT_CONTENT_TYPE,
			role: "user",
			messageId: "m",
			contextId: "c",
			parts: [{ text: fromPeer }],
			subject: null,
		});
		expect(parsed?.text).toHaveLength(45_000);
		expect(parsed?.text).toBe(fromPeer);
	});

	it("does not drop a whole message over an over-long SUBJECT", () => {
		// The harsher half of "what a peer may send is not what we send". The
		// schema bounded `subject` by MAX_SUBJECT — our OUTBOUND cap — so a
		// 201-character subject failed safeParse, parseExchangePayload returned
		// null, and the transport discarded the event as malformed. The whole
		// message lost over an advisory header, with nothing naming why.
		const longSubject = "s".repeat(MAX_SUBJECT + 50);
		const parsed = parseExchangePayload({
			v: 1,
			kind: "message",
			contentType: DEFAULT_CONTENT_TYPE,
			role: "user",
			messageId: "m",
			contextId: "c",
			parts: [{ text: "the body survives" }],
			subject: longSubject,
		});
		// The message arrives...
		expect(parsed).not.toBeNull();
		expect(parsed?.text).toBe("the body survives");
		// ...and the subject is shortened rather than fatal. This also proves
		// the `.slice(0, MAX_SUBJECT)` is live again — it was dead code while
		// the schema rejected anything longer.
		expect(parsed?.subject).toHaveLength(MAX_SUBJECT);
	});

	it("still bounds a NON-conforming inbound body at MAX_INBOUND_BODY", () => {
		// No conforming peer can reach this — a UTF-8 character is at least one
		// byte, so a body cannot carry more characters than NIP-44 carries bytes.
		// It is a memory/storage guard against a peer that is not conforming, and
		// it must stay.
		const absurd = "c".repeat(MAX_INBOUND_BODY + 1_000);
		const parsed = parseExchangePayload({
			v: 1,
			kind: "message",
			contentType: DEFAULT_CONTENT_TYPE,
			role: "user",
			messageId: "m",
			contextId: "c",
			parts: [{ text: absurd }],
			subject: null,
		});
		expect(parsed?.text).toHaveLength(MAX_INBOUND_BODY);
	});

	it("still accepts a body of exactly MAX_BODY, whole", () => {
		// The boundary, asserted in both directions so the guard cannot quietly
		// become off-by-one and cost a caller the last character.
		const exact = "a".repeat(MAX_BODY);
		const parsed = parseExchangePayload(
			buildExchangePayload({
				text: exact,
				contextId: "c",
				messageId: "m",
			}),
		);
		expect(parsed?.text.length).toBe(MAX_BODY);
	});
});

describe("receipt payload", () => {
	it("round-trips build → parse", () => {
		const r = buildReceiptPayload({
			refEventId: "e1",
			contextId: "c1",
			status: "delivered",
		});
		expect(parseReceiptPayload(r)).toEqual(r);
	});

	it("rejects a malformed / bad-status receipt", () => {
		expect(parseReceiptPayload({ v: 1, kind: "receipt" })).toBeNull();
		expect(
			parseReceiptPayload({
				v: 1,
				kind: "receipt",
				refEventId: "e",
				contextId: "c",
				status: "exploded",
			}),
		).toBeNull();
	});

	it("round-trips a read receipt with when it was read", () => {
		const r = buildReceiptPayload({
			refEventId: "e1",
			contextId: "c1",
			status: "read",
			readAt: "2026-10-20T15:36:12.000Z",
		});
		expect(r.readAt).toBe("2026-10-20T15:36:12.000Z");
		expect(parseReceiptPayload(r)).toEqual(r);
	});

	it("carries readAt only on a read receipt", () => {
		const r = buildReceiptPayload({
			refEventId: "e1",
			contextId: "c1",
			status: "delivered",
			readAt: "2026-10-20T15:36:12.000Z",
		});
		expect("readAt" in r).toBe(false);
	});

	it("still parses a receipt shaped by 0.4.0 (no readAt)", () => {
		const r = parseReceiptPayload({
			v: 1,
			kind: "receipt",
			refEventId: "e1",
			contextId: "c1",
			status: "quarantined",
		});
		expect(r).toEqual({
			v: 1,
			kind: "receipt",
			refEventId: "e1",
			contextId: "c1",
			status: "quarantined",
		});
	});

	it("drops an unusable readAt, never the receipt", () => {
		const r = parseReceiptPayload({
			v: 1,
			kind: "receipt",
			refEventId: "e1",
			contextId: "c1",
			status: "read",
			readAt: "yesterday",
		});
		expect(r?.status).toBe("read");
		expect(r?.readAt).toBeUndefined();
	});
});

describe("isUnknownStatusReceipt", () => {
	const envelope = { v: 1, kind: "receipt", refEventId: "e", contextId: "c" };

	it("is true for a well-formed receipt with a status this build does not know", () => {
		expect(isUnknownStatusReceipt({ ...envelope, status: "replied" })).toBe(
			true,
		);
	});

	it("is false for every status this build knows", () => {
		for (const status of ["delivered", "quarantined", "read"]) {
			expect(isUnknownStatusReceipt({ ...envelope, status })).toBe(false);
		}
	});

	it("is false for a malformed receipt, which stays malformed", () => {
		expect(isUnknownStatusReceipt({ v: 1, kind: "receipt" })).toBe(false);
		expect(
			isUnknownStatusReceipt({ ...envelope, refEventId: "", status: "x" }),
		).toBe(false);
		expect(isUnknownStatusReceipt({ ...envelope, status: "" })).toBe(false);
		expect(isUnknownStatusReceipt("not an object")).toBe(false);
	});
});
