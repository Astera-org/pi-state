import { type DocObject } from "./json.js";
/** The cap applied when a schema declares none — and neither auto mode nor an explicit
 * maxStateBytes resolves one first. 4 KiB keeps Σ a small, bounded slice of every
 * request's prompt (it is resent in full on every turn) while still holding a real
 * handful of structured fields — the point of a default an operator never has to think
 * about is that it is generous enough not to need raising for an ordinary schema. */
export declare const DEFAULT_MAX_STATE_BYTES = 4096;
/** The percent auto mode uses when a schema turns it on (`autoMaxStateBytes: true`) but
 * does not say how much (`autoMaxStateBytesPercent` absent) — the middle of the
 * 50-80% range a caller sizing Σ against a context window should reasonably pick from. */
export declare const DEFAULT_AUTO_MAX_STATE_BYTES_PERCENT = 65;
/** ~4 bytes per token: the same rough JSON-text-to-token ratio used to size other
 * prompt-bound budgets in this codebase. Only an approximation — actual bytes-per-token
 * varies with tokenizer and content — but good enough to turn a token-denominated
 * context window into a byte-denominated Σ cap without another round trip to a
 * tokenizer. */
export declare const DEFAULT_BYTES_PER_TOKEN = 4;
/**
 * Resolves auto mode's percent-of-context-window sizing into a concrete byte count.
 * Pure math: `agentstate` has no I/O and no notion of "the current model", so it cannot
 * learn a context window itself — the caller (this repo's `src/entrypoint`, which talks
 * to `pi` and can learn the active model's context window) supplies it and is expected
 * to substitute the result into a Schema's `maxStateBytes` before merge or cap
 * enforcement ever sees it (see schemaCap, merge.ts).
 *
 * `percent` is not defaulted here — pass DEFAULT_AUTO_MAX_STATE_BYTES_PERCENT yourself
 * when a schema's own `autoMaxStateBytesPercent` is absent, so this function stays a
 * single unconditional formula: `floor(contextWindowTokens * bytesPerToken * percent / 100)`.
 */
export declare function resolveAutoMaxStateBytes(percent: number, contextWindowTokens: number, bytesPerToken?: number): number;
/** Bounds one key's `desc`, in bytes. */
export declare const MAX_DESC_BYTES = 160;
/** The declared type of one top-level Sigma key. There is deliberately no "anything"
 * kind: an undeclared shape is what lets growth in. */
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
    /** What this key holds, in the author's own words. Optional, and short by rule
     * (MAX_DESC_BYTES): it ships in the system prompt of every request of a bounded run. */
    desc?: string;
}
/** The closed top-level key set an agent's Sigma may use, plus the byte cap on the
 * merged document. A schema with no keys refuses every non-empty patch. */
export interface Schema {
    keys: Record<string, Field>;
    /** Caps the merged document's canonical JSON size. Absent/0 => DEFAULT_MAX_STATE_BYTES,
     * unless auto mode (autoMaxStateBytes) resolves one first — see schemaCap.
     * An explicit maxStateBytes here always wins over auto mode: auto is a
     * fallback/default a schema falls back to, never an override of an author's own
     * number. */
    maxStateBytes?: number;
    /** Turns on percent-of-context-window sizing for maxStateBytes: instead of (or as a
     * fallback default for) a fixed byte number, the cap becomes autoMaxStateBytesPercent
     * (or DEFAULT_AUTO_MAX_STATE_BYTES_PERCENT when that is absent too) percent of the
     * agent's actual model context window, in bytes.
     *
     * `agentstate` is pure logic with no I/O and cannot resolve this itself — it does
     * not know what model is running. A schema that sets this stays at
     * DEFAULT_MAX_STATE_BYTES (via schemaCap) until some caller that DOES know the
     * context window (this repo's src/entrypoint) resolves it into a concrete
     * maxStateBytes using resolveAutoMaxStateBytes, and substitutes that back onto this
     * schema before merge or cap enforcement runs. Ignored entirely when maxStateBytes
     * is already a positive number. */
    autoMaxStateBytes?: boolean;
    /** The percent (1-100) auto mode uses when autoMaxStateBytes is true. Optional;
     * defaults to DEFAULT_AUTO_MAX_STATE_BYTES_PERCENT (65) when autoMaxStateBytes is
     * true and this is absent. Meaningless without autoMaxStateBytes: true. */
    autoMaxStateBytesPercent?: number;
}
/** The effective byte cap for the merged document. */
export declare function schemaCap(schema: Schema): number;
/** The declared key names, sorted. */
export declare function declaredKeys(schema: Schema): string[];
/** One field's declared type in the compact spelling the state tool surface publishes:
 * the kind, with a list's maxItems in brackets — `list[8]`, not `{"type":"list",...}`. */
export declare function fieldSpec(field: Field): string;
/** Every declared key's spec, keyed by name — what an agent needs to write a patch that
 * validates on the first try (ENG-1116). */
export declare function declaredTypes(schema: Schema): Record<string, string>;
/** The whole declared key set as sorted `name type` pairs — the form a refusal quotes back. */
export declare function declaredSummary(schema: Schema): string;
/** Whether any declared key carries prose (ENG-1404). */
export declare function described(schema: Schema): boolean;
/** declaredSummary plus each key's prose: sorted `name (type) — what it holds`. */
export declare function declaredGuide(schema: Schema): string;
/** Reports whether the schema itself is well-formed. This is where a growth-shaped
 * declaration is refused: an unbounded list cannot be written down. */
export declare function validateSchema(schema: Schema): void;
/** Reads an operator-authored schema document. An unknown JSON field is an error rather
 * than an ignored typo. Empty (or whitespace-only) input parses to the zero schema, which
 * declares nothing and therefore refuses every non-empty patch. */
export declare function parseSchema(raw: string): Schema;
/** Decodes a patch document into the map `merge` takes. Numbers are kept as their exact
 * source digits so a value round-trips through Sigma exactly as the agent wrote it. */
export declare function parsePatch(raw: string): DocObject;
/** Reads a stored document back. Like parsePatch, numbers stay in their exact source
 * form, so a document that round-trips through storage is byte-identical. */
export declare function unmarshal(raw: string): DocObject;
/** Renders a document as the canonical JSON both back-ends would store: compact, with
 * object keys sorted at every depth, so the same document always produces the same bytes. */
export declare function marshal(doc: DocObject | null | undefined): string;
/** The canonical JSON size of a document — the number the byte cap is about. */
export declare function size(doc: DocObject): number;
/** Re-renders a stored document in the canonical form `marshal` produces, so two
 * back-ends with different JSON renderings answer with the same bytes. It normalizes
 * shape, never size: an expanded number stays expanded. */
export declare function canonicalize(raw: string): string;
//# sourceMappingURL=schema.d.ts.map