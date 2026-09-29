// Schema parsing, patch parsing, and canonical document serialization and sizing.
import { AgentStateSchemaError, MalformedPatchError } from "./errors.js";
import { byteLength, isPlainDocObject, JsonNumber, jsonTypeName, marshalValue, parseJsonDocument, quote, } from "./json.js";
/** Decodes a bare JSON number member. Callers that need a whole number (maxStateBytes)
 * check `Number.isInteger` themselves; autoMaxStateBytesPercent does not need to. */
function decodeNumberMember(value) {
    return value instanceof JsonNumber ? Number(value.raw) : Number.NaN;
}
/**
 * Fallback cap when no explicit or auto-sized cap is available: 4 KiB for a small
 * set of structured fields resent on every request.
 */
export const DEFAULT_MAX_STATE_BYTES = 4096;
/** The percent auto sizing uses when a schema declares neither maxStateBytes nor
 * `autoMaxStateBytesPercent`. */
export const DEFAULT_AUTO_MAX_STATE_BYTES_PERCENT = 10;
/** Upper bound, in bytes, on the default auto-sized cap. Not applied when the schema sets
 * `autoMaxStateBytesPercent`. */
export const DEFAULT_AUTO_MAX_STATE_BYTES_CEILING = 65536;
/** Approximate bytes of JSON text per token, used to convert a token-denominated context
 * window into a byte-denominated cap. Actual bytes-per-token varies with tokenizer and
 * content. */
export const DEFAULT_BYTES_PER_TOKEN = 4;
/**
 * Returns `floor(contextWindowTokens * bytesPerToken * percent / 100)`.
 * The caller sets Schema.maxStateBytes before cap enforcement and supplies
 * DEFAULT_AUTO_MAX_STATE_BYTES_PERCENT when the schema omits a percentage.
 * Throws unless percent is in (0, 100] and the other arguments are positive.
 */
export function resolveAutoMaxStateBytes(percent, contextWindowTokens, bytesPerToken = DEFAULT_BYTES_PER_TOKEN) {
    if (!(percent > 0 && percent <= 100)) {
        throw new Error(`resolveAutoMaxStateBytes: percent ${percent} is outside the 1-100 range`);
    }
    if (!(contextWindowTokens > 0)) {
        throw new Error(`resolveAutoMaxStateBytes: contextWindowTokens ${contextWindowTokens} must be positive`);
    }
    if (!(bytesPerToken > 0)) {
        throw new Error(`resolveAutoMaxStateBytes: bytesPerToken ${bytesPerToken} must be positive`);
    }
    return Math.floor(contextWindowTokens * bytesPerToken * (percent / 100));
}
/** Bounds one key's `desc`, in bytes. */
export const MAX_DESC_BYTES = 160;
/** The declared type of one top-level Sigma key. There is no unconstrained kind. */
export const Kind = {
    String: "string",
    Number: "number",
    Bool: "bool",
    /** A nested JSON object. Merging into it is deep (see merge.ts), and it may not
     * contain an array at any depth. */
    Object: "object",
    /** A JSON array, replaced wholesale on merge and bounded by maxItems. */
    List: "list",
};
/** The effective byte cap for the merged document: `maxStateBytes` when positive
 * (including a value substituted by a caller after resolving auto sizing), otherwise
 * DEFAULT_MAX_STATE_BYTES. Does not compute auto sizing itself. */
export function schemaCap(schema) {
    return schema.maxStateBytes && schema.maxStateBytes > 0 ? schema.maxStateBytes : DEFAULT_MAX_STATE_BYTES;
}
/** The declared key names, sorted. */
export function declaredKeys(schema) {
    return Object.keys(schema.keys).sort();
}
/** The kind, with a list's maxItems in brackets, e.g. `list[8]`. */
export function fieldSpec(field) {
    return field.type === Kind.List ? `${field.type}[${field.maxItems}]` : field.type;
}
/** Each declared key's type specification, keyed by name. */
export function declaredTypes(schema) {
    const out = {};
    for (const name of declaredKeys(schema))
        out[name] = fieldSpec(schema.keys[name]);
    return out;
}
/** The whole declared key set as sorted `name type` pairs — the form a refusal quotes back. */
export function declaredSummary(schema) {
    const names = declaredKeys(schema);
    if (names.length === 0)
        return "no keys at all";
    return names.map((name) => `${name} ${fieldSpec(schema.keys[name])}`).join(", ");
}
function schemaError(message) {
    return new AgentStateSchemaError(`${message}: invalid agent state schema`);
}
/** Throws AgentStateSchemaError unless the schema is well-formed: `maxStateBytes` not
 * negative, `autoMaxStateBytesPercent` within 1-100, non-empty key names, `desc` within
 * MAX_DESC_BYTES, a known type per key, and `maxItems` present on lists only. */
export function validateSchema(schema) {
    // maxStateBytes has no upper bound; only a negative value is refused.
    const maxStateBytes = schema.maxStateBytes ?? 0;
    if (maxStateBytes < 0) {
        throw schemaError(`maxStateBytes ${maxStateBytes} is negative`);
    }
    if (schema.autoMaxStateBytesPercent !== undefined) {
        const percent = schema.autoMaxStateBytesPercent;
        if (!(percent >= 1 && percent <= 100)) {
            throw schemaError(`autoMaxStateBytesPercent ${percent} is outside the 1-100 range`);
        }
    }
    for (const name of declaredKeys(schema)) {
        if (name.trim() === "") {
            throw schemaError("a declared key name is empty");
        }
        const field = schema.keys[name];
        const descBytes = byteLength(field.desc ?? "");
        if (descBytes > MAX_DESC_BYTES) {
            throw schemaError(`key ${quote(name)} describes itself in ${descBytes} bytes, over the ${MAX_DESC_BYTES}-byte ceiling — the prose ships in every request's tool schema, so it is a clause and not a second prompt`);
        }
        switch (field.type) {
            case Kind.String:
            case Kind.Number:
            case Kind.Bool:
            case Kind.Object:
                if (field.maxItems) {
                    throw schemaError(`key ${quote(name)} declares maxItems on a ${field.type}`);
                }
                break;
            case Kind.List:
                if (!field.maxItems || field.maxItems <= 0) {
                    throw schemaError(`key ${quote(name)} is a list with no maxItems — an unbounded list moves the prompt's growth into the state document`);
                }
                break;
            default:
                throw schemaError(`key ${quote(name)} declares unknown type ${quote(String(field.type))} (want one of string, number, bool, object, list)`);
        }
    }
}
function decodeField(name, value) {
    if (!isPlainDocObject(value)) {
        throw new Error(`declared key ${quote(name)} must be a JSON object`);
    }
    const allowed = new Set(["type", "maxItems", "desc"]);
    for (const member of Object.keys(value)) {
        if (!allowed.has(member)) {
            throw new Error(`declared key ${quote(name)} has an unknown field ${quote(member)}`);
        }
    }
    if (typeof value.type !== "string") {
        throw new Error(`declared key ${quote(name)}'s type must be a string`);
    }
    const field = { type: value.type };
    if ("maxItems" in value) {
        const n = decodeNumberMember(value.maxItems);
        if (!Number.isInteger(n)) {
            throw new Error(`declared key ${quote(name)}'s maxItems must be an integer`);
        }
        field.maxItems = n;
    }
    if ("desc" in value) {
        if (typeof value.desc !== "string") {
            throw new Error(`declared key ${quote(name)}'s desc must be a string`);
        }
        field.desc = value.desc;
    }
    return field;
}
function decodeSchema(value) {
    if (!isPlainDocObject(value)) {
        throw new Error("the state schema must be a JSON object");
    }
    const allowed = new Set(["keys", "maxStateBytes", "autoMaxStateBytesPercent"]);
    for (const member of Object.keys(value)) {
        if (!allowed.has(member)) {
            throw new Error(`the state schema has an unknown field ${quote(member)}`);
        }
    }
    const schema = { keys: {} };
    if ("maxStateBytes" in value) {
        const n = decodeNumberMember(value.maxStateBytes);
        if (!Number.isInteger(n)) {
            throw new Error("maxStateBytes must be an integer");
        }
        schema.maxStateBytes = n;
    }
    if ("autoMaxStateBytesPercent" in value) {
        const n = decodeNumberMember(value.autoMaxStateBytesPercent);
        if (!Number.isFinite(n)) {
            throw new Error("autoMaxStateBytesPercent must be a number");
        }
        schema.autoMaxStateBytesPercent = n;
    }
    if ("keys" in value) {
        const keysValue = value.keys;
        if (!isPlainDocObject(keysValue)) {
            throw new Error("keys must be a JSON object");
        }
        for (const name of Object.keys(keysValue)) {
            schema.keys[name] = decodeField(name, keysValue[name]);
        }
    }
    return schema;
}
/**
 * Parses and validates a schema, rejecting unknown JSON fields. Empty or whitespace-only
 * input declares no keys and refuses every non-empty patch.
 */
export function parseSchema(raw) {
    if (raw.trim() === "")
        return { keys: {} };
    const value = parseJsonDocument(raw);
    const schema = decodeSchema(value);
    validateSchema(schema);
    return schema;
}
/** Decodes a patch document into the map `merge` takes. Numbers are kept as their exact
 * source digits. */
export function parsePatch(raw) {
    if (raw.length === 0)
        return {};
    const value = parseJsonDocument(raw);
    if (!isPlainDocObject(value)) {
        throw new MalformedPatchError(`got ${jsonTypeName(value)}: state patch must be a JSON object`);
    }
    return value;
}
/** Reads a stored document back. Like parsePatch, numbers keep their exact source digits. */
export function unmarshal(raw) {
    if (raw.length === 0)
        return {};
    const value = parseJsonDocument(raw);
    if (!isPlainDocObject(value)) {
        throw new Error(`cannot read ${jsonTypeName(value)} as a state document`);
    }
    return value;
}
/** Renders a document as canonical JSON: compact, with object keys sorted at every
 * depth, so the same document always produces the same bytes. */
export function marshal(doc) {
    return marshalValue(doc ?? {});
}
/** The canonical JSON size in UTF-8 bytes, used for cap enforcement. */
export function size(doc) {
    return byteLength(marshal(doc));
}
/** Re-renders a stored document in the canonical form `marshal` produces. Normalizes
 * formatting only; number digits are unchanged. */
export function canonicalize(raw) {
    return marshal(unmarshal(raw));
}
//# sourceMappingURL=schema.js.map