import { type DocObject } from "./json.js";
/**
 * Fallback cap when no explicit or auto-sized cap is available: 4 KiB for a small
 * set of structured fields resent on every request.
 */
export declare const DEFAULT_MAX_STATE_BYTES = 4096;
/** The percent auto sizing uses when a schema declares neither maxStateBytes nor
 * `autoMaxStateBytesPercent`. */
export declare const DEFAULT_AUTO_MAX_STATE_BYTES_PERCENT = 10;
/** Upper bound, in bytes, on the default auto-sized cap. Not applied when the schema sets
 * `autoMaxStateBytesPercent`. */
export declare const DEFAULT_AUTO_MAX_STATE_BYTES_CEILING = 65536;
/** Approximate bytes of JSON text per token, used to convert a token-denominated context
 * window into a byte-denominated cap. Actual bytes-per-token varies with tokenizer and
 * content. */
export declare const DEFAULT_BYTES_PER_TOKEN = 4;
/**
 * Returns `floor(contextWindowTokens * bytesPerToken * percent / 100)`.
 * The caller sets Schema.maxStateBytes before cap enforcement and supplies
 * DEFAULT_AUTO_MAX_STATE_BYTES_PERCENT when the schema omits a percentage.
 * Throws unless percent is in (0, 100] and the other arguments are positive.
 */
export declare function resolveAutoMaxStateBytes(percent: number, contextWindowTokens: number, bytesPerToken?: number): number;
/** Bounds one key's `desc`, in bytes. */
export declare const MAX_DESC_BYTES = 160;
/** The declared type of one top-level Sigma key. There is no unconstrained kind. */
export declare const Kind: {
    readonly String: "string";
    readonly Number: "number";
    readonly Bool: "bool";
    /** A nested JSON object. Merging into it is deep (see merge.ts), and it may not
     * contain an array at any depth. */
    readonly Object: "object";
    /** A JSON array, replaced wholesale on merge and bounded by maxItems. */
    readonly List: "list";
};
export type Kind = (typeof Kind)[keyof typeof Kind];
/** One declared top-level key. */
export interface Field {
    type: Kind;
    /** Required (> 0) for a list field, and rejected on every other kind. */
    maxItems?: number;
    /** What this key holds. Optional; at most MAX_DESC_BYTES bytes, because it is included
     * in every request's `state_commit` schema. */
    desc?: string;
}
/** The closed top-level key set an agent's Sigma may use, plus the byte cap on the
 * merged document. A schema with no keys refuses every non-empty patch. */
export interface Schema {
    keys: Record<string, Field>;
    /** Caps the merged document's canonical JSON size. An explicit positive value
     * overrides auto sizing. Absent (or 0) means the cap is sized automatically from the
     * context window; see autoMaxStateBytesPercent, resolveAutoMaxStateBytes, and
     * schemaCap. */
    maxStateBytes?: number;
    /** The percent (1-100) of the context window auto sizing uses when maxStateBytes is
     * absent. Defaults to DEFAULT_AUTO_MAX_STATE_BYTES_PERCENT (10), capped at
     * DEFAULT_AUTO_MAX_STATE_BYTES_CEILING; an explicit value is not capped.
     *
     * `agentstate` cannot resolve auto sizing itself. Until a caller that knows the
     * context window (`src/entrypoint`) resolves this percent with
     * resolveAutoMaxStateBytes and sets `maxStateBytes` on the schema, schemaCap returns
     * DEFAULT_MAX_STATE_BYTES. */
    autoMaxStateBytesPercent?: number;
}
/** The effective byte cap for the merged document: `maxStateBytes` when positive
 * (including a value substituted by a caller after resolving auto sizing), otherwise
 * DEFAULT_MAX_STATE_BYTES. Does not compute auto sizing itself. */
export declare function schemaCap(schema: Schema): number;
/** The declared key names, sorted. */
export declare function declaredKeys(schema: Schema): string[];
/** The kind, with a list's maxItems in brackets, e.g. `list[8]`. */
export declare function fieldSpec(field: Field): string;
/** Each declared key's type specification, keyed by name. */
export declare function declaredTypes(schema: Schema): Record<string, string>;
/** The whole declared key set as sorted `name type` pairs — the form a refusal quotes back. */
export declare function declaredSummary(schema: Schema): string;
/** Whether any declared key carries prose. */
export declare function described(schema: Schema): boolean;
/** Throws AgentStateSchemaError unless the schema is well-formed: `maxStateBytes` not
 * negative, `autoMaxStateBytesPercent` within 1-100, non-empty key names, `desc` within
 * MAX_DESC_BYTES, a known type per key, and `maxItems` present on lists only. */
export declare function validateSchema(schema: Schema): void;
/**
 * Parses and validates a schema, rejecting unknown JSON fields. Empty or whitespace-only
 * input declares no keys and refuses every non-empty patch.
 */
export declare function parseSchema(raw: string): Schema;
/** Decodes a patch document into the map `merge` takes. Numbers are kept as their exact
 * source digits. */
export declare function parsePatch(raw: string): DocObject;
/** Reads a stored document back. Like parsePatch, numbers keep their exact source digits. */
export declare function unmarshal(raw: string): DocObject;
/** Renders a document as canonical JSON: compact, with object keys sorted at every
 * depth, so the same document always produces the same bytes. */
export declare function marshal(doc: DocObject | null | undefined): string;
/** The canonical JSON size in UTF-8 bytes, used for cap enforcement. */
export declare function size(doc: DocObject): number;
/** Re-renders a stored document in the canonical form `marshal` produces. Normalizes
 * formatting only; number digits are unchanged. */
export declare function canonicalize(raw: string): string;
//# sourceMappingURL=schema.d.ts.map