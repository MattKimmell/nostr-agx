import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sandbox } from "../test/helpers.js";
import { FileSeenStore, updateState } from "./state.js";

const DAY = 24 * 60 * 60;

let box: ReturnType<typeof sandbox>;
beforeEach(() => {
	box = sandbox();
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
});
afterEach(() => {
	vi.useRealTimers();
	box.restore();
});

describe("FileSeenStore", () => {
	it("forgets an id once the retention window has passed", () => {
		const seen = new FileSeenStore("default");
		seen.holdFor(Date.now() / 1000);
		seen.add("event-1");
		vi.setSystemTime(Date.now() + 4 * DAY * 1000);
		seen.holdFor(Date.now() / 1000);
		expect(seen.has("event-1")).toBe(false);
	});

	it("keeps ids the poll can still return while the cursor is held back", () => {
		const start = Date.now() / 1000;
		const seen = new FileSeenStore("default");
		seen.holdFor(start);
		seen.add("event-1");
		// A relay has not answered for four days: the cursor stayed at `start`,
		// so polls still reach back to it and return event-1 again.
		vi.setSystemTime(Date.now() + 4 * DAY * 1000);
		seen.add("event-2");
		expect(seen.has("event-1")).toBe(true);
		// Every relay answers again and the cursor moves on: it is let go.
		seen.holdFor(Date.now() / 1000);
		seen.add("event-3");
		expect(seen.has("event-1")).toBe(false);
	});

	it("starts from the cursor the profile saved, and survives a restart", () => {
		const start = Date.now() / 1000;
		updateState("default", { cursor: start });
		const first = new FileSeenStore("default");
		first.add("event-1");
		first.flush();
		vi.setSystemTime(Date.now() + 4 * DAY * 1000);
		expect(new FileSeenStore("default").has("event-1")).toBe(true);
	});

	it("drops a failure count once the event is recorded", () => {
		const seen = new FileSeenStore("default");
		expect(seen.recordFailure("event-1")).toBe(1);
		seen.add("event-1");
		expect(seen.recordFailure("event-1")).toBe(1);
	});
});
