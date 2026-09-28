/** An invalid schema. */
export declare class AgentStateSchemaError extends Error {
    constructor(message: string);
}
/** A patch that is not a JSON object. */
export declare class MalformedPatchError extends Error {
    constructor(message: string);
}
/** A patch key the schema does not declare. */
export declare class UnknownKeyError extends Error {
    constructor(message: string);
}
/** A value whose JSON type is not the key's declared type. */
export declare class TypeMismatchError extends Error {
    constructor(message: string);
}
/** A list longer than its declared maxItems. */
export declare class TooManyItemsError extends Error {
    constructor(message: string);
}
/** An array inside an object value, at any depth. */
export declare class NestedListError extends Error {
    constructor(message: string);
}
/** The merged document is over the schema's byte cap. */
export declare class TooLargeError extends Error {
    constructor(message: string);
}
/** A number whose expanded decimal form is longer than MAX_NUMBER_BYTES. */
export declare class NumberRangeError extends Error {
    constructor(message: string);
}
/** A document with a second JSON value after the first. */
export declare class TrailingContentError extends Error {
    constructor(message: string);
}
//# sourceMappingURL=errors.d.ts.map