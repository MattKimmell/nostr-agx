/**
 * At most `limit` holders per key at once; the rest wait their turn, in order.
 * The gateway gives each webhook its own slots, so a busy workflow neither
 * takes every task the gateway is running nor holds up the other webhooks.
 */
export class KeyedSlots {
	private readonly held = new Map<string, number>();
	private readonly queued = new Map<string, (() => void)[]>();
	private closed = false;

	constructor(private readonly limit: number) {}

	/** Wait for a slot for `key`; call what it resolves to, once, to free it. */
	async acquire(key: string): Promise<() => void> {
		if (this.closed || (this.held.get(key) ?? 0) < this.limit) {
			this.held.set(key, (this.held.get(key) ?? 0) + 1);
		} else {
			// Handed over by a release: the count stays as it is.
			await new Promise<void>((resolve) => {
				const queue = this.queued.get(key) ?? [];
				queue.push(resolve);
				this.queued.set(key, queue);
			});
		}
		let released = false;
		return () => {
			if (released) {
				return;
			}
			released = true;
			const queue = this.queued.get(key);
			const next = queue?.shift();
			if (queue?.length === 0) {
				this.queued.delete(key);
			}
			if (next) {
				next();
				return;
			}
			const left = (this.held.get(key) ?? 1) - 1;
			if (left > 0) {
				this.held.set(key, left);
			} else {
				this.held.delete(key);
			}
		};
	}

	/** Let every waiter go, and every later caller straight through: on
	 * shutdown, so they can see the gateway is stopping and say so. */
	close(): void {
		this.closed = true;
		for (const queue of this.queued.values()) {
			for (const next of queue.splice(0)) {
				next();
			}
		}
		this.queued.clear();
	}

	/** Slots held for `key` (tests). */
	inUse(key: string): number {
		return this.held.get(key) ?? 0;
	}
}
