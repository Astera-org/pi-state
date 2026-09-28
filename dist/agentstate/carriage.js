// Reads a stored document against its schema: which declared keys the document carries,
// which of those are empty, and which document keys the schema does not declare.
import { isPlainDocObject } from "./json.js";
import { declaredKeys, unmarshal } from "./schema.js";
/** True when the schema declares keys and the document carries none. False for an empty schema. */
export function carriesNothing(c) {
    return c.declared.length > 0 && c.carried.length === 0;
}
/** True for whitespace-only strings, empty objects, and empty lists. Zero and false are non-empty. */
export function isEmptyValue(v) {
    if (typeof v === "string")
        return v.trim() === "";
    if (Array.isArray(v))
        return v.length === 0;
    if (isPlainDocObject(v))
        return Object.keys(v).length === 0;
    return false;
}
/** Reads a stored document against a schema. `raw` is the document as the store holds
 * it (canonical JSON; an empty string is the empty document). It never fails on
 * content — the only error is a document that does not parse. */
export function readCarriage(raw, schema) {
    const doc = unmarshal(raw);
    const declared = declaredKeys(schema);
    const carried = [];
    const notCarried = [];
    const empty = [];
    for (const key of declared) {
        const value = doc[key];
        if (value === undefined || value === null) {
            notCarried.push(key);
            continue;
        }
        carried.push(key);
        if (isEmptyValue(value))
            empty.push(key);
    }
    const undeclared = Object.keys(doc)
        .filter((key) => !(key in schema.keys))
        .sort();
    return { declared, carried, notCarried, empty, undeclared };
}
//# sourceMappingURL=carriage.js.map