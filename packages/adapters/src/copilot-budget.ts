/** Invocation-local work deadline; only an actual human question pauses it. */
export class CopilotBudget {
	#remaining: number;
	#startedAt?: number;
	#timer?: ReturnType<typeof setTimeout>;
	#disposed = false;

	constructor(milliseconds: number, private readonly signal: AbortSignal, private readonly expire: () => void) {
		this.#remaining = milliseconds;
		signal.addEventListener("abort", this.dispose, { once: true });
		this.resume();
	}

	pause(): void {
		if (this.#startedAt === undefined) return;
		this.#remaining -= performance.now() - this.#startedAt;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#startedAt = undefined;
		if (this.#remaining <= 0) this.timeout();
	}

	resume(): void {
		if (this.#disposed || this.signal.aborted || this.#startedAt !== undefined) return;
		if (this.#remaining <= 0) { this.timeout(); return; }
		this.#startedAt = performance.now();
		this.#timer = setTimeout(() => this.timeout(), this.#remaining);
	}

	dispose = (): void => {
		this.#disposed = true;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#startedAt = undefined;
		this.signal.removeEventListener("abort", this.dispose);
	};

	private timeout(): void {
		if (this.#disposed || this.signal.aborted) return;
		this.dispose();
		this.expire();
	}
}
