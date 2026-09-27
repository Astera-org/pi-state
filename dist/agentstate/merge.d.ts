import { type DocObject } from "./json.js";
import { type Schema } from "./schema.js";
/** Applies `patch` to `doc` under `schema` and returns the document that should replace
 * it. Neither `doc` nor `patch` is mutated: null deletes, objects merge deep, arrays
 * replace wholesale, and the byte cap is checked last, against the merged result. */
export declare function merge(doc: DocObject | null | undefined, patch: DocObject, schema: Schema): DocObject;
//# sourceMappingURL=merge.d.ts.map