import { type DocValue } from "./json.js";
import { type Schema } from "./schema.js";
export interface Carriage {
    /** The schema's own key set. */
    declared: string[];
    /** `carried` and `notCarried` partition `declared`. */
    carried: string[];
    notCarried: string[];
    /** Carried keys with empty values. */
    empty: string[];
    /** A key the document holds that the schema does not declare. */
    undeclared: string[];
}
/** True when the schema declares keys and the document carries none. False for an empty schema. */
export declare function carriesNothing(c: Carriage): boolean;
/** True for whitespace-only strings, empty objects, and empty lists. Zero and false are non-empty. */
export declare function isEmptyValue(v: DocValue): boolean;
/** Reads a stored document against a schema. `raw` is the document as the store holds
 * it (canonical JSON; an empty string is the empty document). It never fails on
 * content — the only error is a document that does not parse. */
export declare function readCarriage(raw: string, schema: Schema): Carriage;
//# sourceMappingURL=carriage.d.ts.map