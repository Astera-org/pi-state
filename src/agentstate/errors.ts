// Schema and patch refusal classes, distinguishable with `instanceof`.

/** An invalid schema. */
export class AgentStateSchemaError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AgentStateSchemaError";
	}
}

/** A patch that is not a JSON object. */
export class MalformedPatchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "MalformedPatchError";
	}
}

/** A patch key the schema does not declare. */
export class UnknownKeyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnknownKeyError";
	}
}

/** A value whose JSON type is not the key's declared type. */
export class TypeMismatchError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TypeMismatchError";
	}
}

/** A list longer than its declared maxItems. */
export class TooManyItemsError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TooManyItemsError";
	}
}

/** An array inside an object value, at any depth. */
export class NestedListError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NestedListError";
	}
}

/** The merged document is over the schema's byte cap. */
export class TooLargeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TooLargeError";
	}
}

/** A number whose expanded decimal form is longer than MAX_NUMBER_BYTES. */
export class NumberRangeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NumberRangeError";
	}
}

/** A document with a second JSON value after the first. */
export class TrailingContentError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TrailingContentError";
	}
}
