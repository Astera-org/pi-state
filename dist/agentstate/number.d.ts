import { JsonNumber } from "./json.js";
/** Bounds the canonical (expanded) form of one number, in bytes. */
export declare const MAX_NUMBER_BYTES = 64;
/** Renders a patch number in the expanded decimal form the document is stored as, and
 * refuses one whose canonical form is too long. */
export declare function canonicalNumber(v: JsonNumber): JsonNumber;
//# sourceMappingURL=number.d.ts.map