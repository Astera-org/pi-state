// A READING of a stored document against its schema, not a verdict on
// whether it's true.
import { isPlainDocObject } from "./json.js";
import { declaredKeys, unmarshal } from "./schema.js";
/** Reports an empty carriage: the schema asked for keys and the document holds
 * none of them. False for a schema that declares no keys — that makes "carried none of
 * them" vacuously true, a legitimate authored choice rather than a finding. */
export function carriesNothing(c) {
    return c.declared.length > 0 && c.carried.length === 0;
}
/** Reports whether a stored value says nothing: an empty (or whitespace-only) string,
 * an empty object, or an empty list. A zero number and `false` are values an agent
 * chose, not emptiness. */
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