import { describe, expect, it } from "vitest";
import { KeyedSlots } from "./slots.js";

describe("KeyedSlots", () => {
	it("lets `limit` holders in per key, and the next in line when one leaves", async () => {
		const slots = new KeyedSlots(2);
		const first = await slots.acquire("a");
		const second = await slots.acquire("a");
		let third: (() => void) | null = null;
		const waiting = slots.acquire("a").then((release) => {
			third = release;
		});
		// Another key is not held up.
		const other = await slots.acquire("b");
		await new Promise((r) => setTimeout(r, 5));
		expect(third).toBeNull();
		expect(slots.inUse("a")).toBe(2);

		first();
		first(); // a second call frees nothing more
		await waiting;
		expect(third).not.toBeNull();
		expect(slots.inUse("a")).toBe(2);
		second();
		(third as unknown as () => void)();
		other();
		expect(slots.inUse("a")).toBe(0);
		expect(slots.inUse("b")).toBe(0);
	});
});
