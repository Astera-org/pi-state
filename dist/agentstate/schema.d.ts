import { type DocObject } from "./json.js";
/** The cap applied when a schema declares none. 4 KiB keeps Σ a small, bounded slice of
 * every request's prompt (it is resent in full on every turn) while still holding a
 * real handful of structured fields — the point of a default an operator never has to
 * think about is that it is generous enough not to need raising for an ordinary schema. */
export declare const DEFAULT_MAX_STATE_BYTES = 4096;
/** The largest cap a schema may declare. */
export declare const MAX_STATE_BYTES_CEILING: number;
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
    /** Caps the merged document's canonical JSON size. Absent/0 => DEFAULT_MAX_STATE_BYTES. */
    maxStateBytes?: number;
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