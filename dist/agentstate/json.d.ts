/** A JSON number, held as the source digits rather than a lossy JS `number`. */
export declare class JsonNumber {
    readonly raw: string;
    constructor(raw: string);
    toString(): string;
}
export interface DocObject {
    [key: string]: DocValue;
}
export type DocValue = null | boolean | string | JsonNumber | DocValue[] | DocObject;
export declare function isPlainDocObject(v: DocValue): v is DocObject;
/** The JSON type name a refusal quotes back — `agentstate.go`'s `jsonTypeName`. */
export declare function jsonTypeName(v: DocValue): string;
export declare function quote(s: string): string;
/** Bounds a fragment quoted back in an error — `agentstate.go`'s `truncate`. */
export declare function truncate(s: string, max: number): string;
/** The UTF-8 byte length of `s` — what Go's `len(string)` measures. */
export declare function byteLength(s: string): number;
/** Parses exactly one JSON value and refuses any content — other than whitespace — after it. */
export declare function parseJsonDocument(text: string): DocValue;
/** Compact canonical JSON, with object keys sorted at every depth — what Go's
 * `encoding/json` does for a `map[string]any`, and what the byte cap is measured on. */
export declare function marshalValue(v: DocValue): string;
//# sourceMappingURL=json.d.ts.map