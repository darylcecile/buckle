/** Configuration for a shared, in-memory session context. */
export interface SessionContextOptions {
	/** Human-readable purpose of the context. */
	description?: string;
}

/**
 * Shared session data with per-reference write expectations. Nothing is persisted.
 * A write expectation is configuration metadata, not an access-control boundary.
 */
export class SessionContext {
	#store = { id: Symbol("SessionContext"), data: new Map<string, unknown>() };
	#writeExpected = false;

	/** Description captured at construction; independent of the shared data. */
	readonly options: Readonly<SessionContextOptions>;

	/** Creates an empty context without reading files or starting any work. */
	constructor(options: SessionContextOptions = {}) {
		this.options = Object.freeze({ ...options });
	}

	/** Stable identity shared by this context and all its write references. */
	get id(): symbol {
		return this.#store.id;
	}

	/** Mutable session data shared by every reference to this context. */
	get data(): Map<string, unknown> {
		return this.#store.data;
	}

	/** Whether this particular reference expects its stage to write to the context. */
	get writeExpected(): boolean {
		return this.#writeExpected;
	}

	/**
	 * Returns a new reference sharing identity and data, leaving existing references
	 * unchanged. Subclasses retain their type through {@link createReference}.
	 */
	expectWrite(): this {
		const reference = this.createReference();
		reference.#store = this.#store;
		reference.#writeExpected = true;
		return reference;
	}

	/**
	 * Constructs a reference with valid private fields. Subclasses must override
	 * this method, construct their own instance, and share any subclass session state.
	 * Do not use Object.create or a shallow clone of a class with private fields.
	 */
	protected createReference(): this {
		if (this.constructor !== SessionContext) {
			throw new TypeError("SessionContext subclasses must implement createReference()");
		}
		return new SessionContext(this.options) as this;
	}
}