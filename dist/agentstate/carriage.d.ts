import { type DocValue } from "./json.js";
import { type Schema } from "./schema.js";
export interface Carriage {
    /** The schema's own key set. */
    declared: string[];
    /** declared and notCarried partition Declared. */
    carried: string[];
    notCarried: string[];
    /** A subset of carried: the carried keys whose value says nothing. */
    empty: string[];
    /** A key the document holds that the schema does not declare. */
    undeclared: string[];
}
/** Reports the ENG-1172 signature: the schema asked for keys and the document holds
 * none of them. False for a schema that declares no keys — that makes "carried none of
 * them" vacuously true, a legitimate authored choice rather than a finding. */
export declare function carriesNothing(c: Carriage): boolean;
/** Reports whether a stored value says nothing: an empty (or whitespace-only) string,
 * an empty object, or an empty list. A zero number and `false` are values an agent
 * chose, not emptiness. */
export declare function isEmptyValue(v: DocValue): boolean;
/** Reads a stored document against a schema. `raw` is the document as the store holds
 * it (canonical JSON; an empty string is the empty document). It never fails on
 * content — the only error is a document that does not parse. */
export declare function readCarriage(raw: string, schema: Schema): Carriage;
//# sourceMappingURL=carriage.d.ts.map