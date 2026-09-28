// The Schema model, parseSchema, parsePatch, and the canonical
// marshal/unmarshal/canonicalize/size primitives that define an agent's durable working
// state (Sigma).
//
// Naming: functions are `camelCase` (`parseSchema`, `merge`, ...); types are `PascalCase`
// (`Schema`, `Field`, `Kind`).

import { AgentStateSchemaError, MalformedPatchError } from "./errors.js";
import {
	byteLength,
	type DocObject,
	type DocValue,
	isPlainDocObject,
	JsonNumber,
	jsonTypeName,
	marshalValue,
	parseJsonDocument,
	quote,
} from "./json.js";

/** Decodes a bare JSON number member. Callers that need a whole number (maxStateBytes)
 * check `Number.isInteger` themselves; autoMaxStateBytesPercent does not need to. */
function decodeNumberMember(value: DocValue): number {
	return value instanceof JsonNumber ? Number(value.raw) : Number.NaN;
}

/** The cap applied when a schema declares no maxStateBytes and auto sizing has not
 * resolved one. */
export const DEFAULT_MAX_STATE_BYTES = 4096;

/** The percent auto sizing uses when a schema declares neither maxStateBytes nor
 * `autoMaxStateBytesPercent`. */
export const DEFAULT_AUTO_MAX_STATE_BYTES_PERCENT = 65;

/** Approximate bytes of JSON text per token, used to convert a token-denominated context
 * window into a byte-denominated cap. Actual bytes-per-token varies with tokenizer and
 * content. */
export const DEFAULT_BYTES_PER_TOKEN = 4;

/**
 * Resolves percent-of-context-window sizing into a byte count:
 * `floor(contextWindowTokens * bytesPerToken * percent / 100)`.
 *
 * `agentstate` has no knowledge of the running model, so the caller (`src/entrypoint`)
 * supplies the context window and substitutes the result into a Schema's `maxStateBytes`
 * before merge or cap enforcement (see schemaCap, merge.ts). `percent` has no default
 * here; pass DEFAULT_AUTO_MAX_STATE_BYTES_PERCENT when the schema's
 * `autoMaxStateBytesPercent` is absent. Throws unless `percent` is in (0, 100] and
 * `contextWindowTokens` and `bytesPerToken` are positive.
 */
export function resolveAutoMaxStateBytes(
	percent: number,
	contextWindowTokens: number,
	bytesPerToken = DEFAULT_BYTES_PER_TOKEN,
): number {
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
} as const;
export type Kind = (typeof Kind)[keyof typeof Kind];

/** One declared top-level key. */
export interface Field {
	type: Kind;
	/** Required (> 0) for a list field, and rejected on every other kind. */
	maxItems?: number;
	/** What this key holds. Optional; at most MAX_DESC_BYTES bytes, because it is included
	 * in the system prompt of every request. */
	desc?: string;
}

/** The closed top-level key set an agent's Sigma may use, plus the byte cap on the
 * merged document. A schema with no keys refuses every non-empty patch. */
export interface Schema {
	keys: Record<string, Field>;
	/** Caps the merged document's canonical JSON size. An explicit positive value
	 * overrides auto sizing. Absent (or 0) means the cap is sized automatically from the
	 * context window; see autoMaxStateBytesPercent, resolveAutoMaxStateBytes, and
	 * schemaCap. */
	maxStateBytes?: number;
	/** The percent (1-100) of the context window auto sizing uses when maxStateBytes is
	 * absent. Defaults to DEFAULT_AUTO_MAX_STATE_BYTES_PERCENT (65).
	 *
	 * `agentstate` cannot resolve auto sizing itself. Until a caller that knows the
	 * context window (`src/entrypoint`) resolves this percent with
	 * resolveAutoMaxStateBytes and sets `maxStateBytes` on the schema, schemaCap returns
	 * DEFAULT_MAX_STATE_BYTES. */
	autoMaxStateBytesPercent?: number;
}

/** The effective byte cap for the merged document: `maxStateBytes` when positive
 * (including a value substituted by a caller after resolving auto sizing), otherwise
 * DEFAULT_MAX_STATE_BYTES. Does not compute auto sizing itself. */
export function schemaCap(schema: Schema): number {
	return schema.maxStateBytes && schema.maxStateBytes > 0 ? schema.maxStateBytes : DEFAULT_MAX_STATE_BYTES;
}

/** The declared key names, sorted. */
export function declaredKeys(schema: Schema): string[] {
	return Object.keys(schema.keys).sort();
}

/** One field's declared type in the compact spelling the state tool surface publishes:
 * the kind, with a list's maxItems in brackets — `list[8]`, not `{"type":"list",...}`. */
export function fieldSpec(field: Field): string {
	return field.type === Kind.List ? `${field.type}[${field.maxItems}]` : field.type;
}

/** Every declared key's spec, keyed by name — what an agent needs to write a patch that
 * validates on the first try. */
export function declaredTypes(schema: Schema): Record<string, string> {
	const out: Record<string, string> = {};
	for (const name of declaredKeys(schema)) out[name] = fieldSpec(schema.keys[name]);
	return out;
}

/** The whole declared key set as sorted `name type` pairs — the form a refusal quotes back. */
export function declaredSummary(schema: Schema): string {
	const names = declaredKeys(schema);
	if (names.length === 0) return "no keys at all";
	return names.map((name) => `${name} ${fieldSpec(schema.keys[name])}`).join(", ");
}

/** Whether any declared key carries prose. */
export function described(schema: Schema): boolean {
	return Object.values(schema.keys).some((f) => (f.desc ?? "").trim() !== "");
}

/** declaredSummary plus each key's prose: sorted `name (type) — what it holds`. */
export function declaredGuide(schema: Schema): string {
	const names = declaredKeys(schema);
	if (names.length === 0) return "no keys at all";
	return names
		.map((name) => {
			const f = schema.keys[name];
			const desc = (f.desc ?? "").trim();
			return desc === "" ? `${name} (${fieldSpec(f)})` : `${name} (${fieldSpec(f)}) — ${desc}`;
		})
		.join("; ");
}

function schemaError(message: string): AgentStateSchemaError {
	return new AgentStateSchemaError(`${message}: invalid agent state schema`);
}

/** Throws AgentStateSchemaError unless the schema is well-formed: `maxStateBytes` not
 * negative, `autoMaxStateBytesPercent` within 1-100, non-empty key names, `desc` within
 * MAX_DESC_BYTES, a known type per key, and `maxItems` present on lists only. */
export function validateSchema(schema: Schema): void {
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
			throw schemaError(
				`key ${quote(name)} describes itself in ${descBytes} bytes, over the ${MAX_DESC_BYTES}-byte ceiling — the prose ships in the system prompt of every request, so it is a clause and not a second prompt`,
			);
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
					throw schemaError(
						`key ${quote(name)} is a list with no maxItems — an unbounded list moves the prompt's growth into the state document`,
					);
				}
				break;
			default:
				throw schemaError(
					`key ${quote(name)} declares unknown type ${quote(String(field.type))} (want one of string, number, bool, object, list)`,
				);
		}
	}
}

function decodeField(name: string, value: DocValue): Field {
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
	const field: Field = { type: value.type as Kind };
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

function decodeSchema(value: DocValue): Schema {
	if (!isPlainDocObject(value)) {
		throw new Error("the state schema must be a JSON object");
	}
	const allowed = new Set(["keys", "maxStateBytes", "autoMaxStateBytesPercent"]);
	for (const member of Object.keys(value)) {
		if (!allowed.has(member)) {
			throw new Error(`the state schema has an unknown field ${quote(member)}`);
		}
	}
	const schema: Schema = { keys: {} };
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

/** Reads an operator-authored schema document. An unknown JSON field is an error rather
 * than an ignored typo. Empty (or whitespace-only) input parses to the zero schema, which
 * declares nothing and therefore refuses every non-empty patch. */
export function parseSchema(raw: string): Schema {
	if (raw.trim() === "") return { keys: {} };
	const value = parseJsonDocument(raw);
	const schema = decodeSchema(value);
	validateSchema(schema);
	return schema;
}

/** Decodes a patch document into the map `merge` takes. Numbers are kept as their exact
 * source digits. */
export function parsePatch(raw: string): DocObject {
	if (raw.length === 0) return {};
	const value = parseJsonDocument(raw);
	if (!isPlainDocObject(value)) {
		throw new MalformedPatchError(`got ${jsonTypeName(value)}: state patch must be a JSON object`);
	}
	return value;
}

/** Reads a stored document back. Like parsePatch, numbers keep their exact source digits. */
export function unmarshal(raw: string): DocObject {
	if (raw.length === 0) return {};
	const value = parseJsonDocument(raw);
	if (!isPlainDocObject(value)) {
		throw new Error(`cannot read ${jsonTypeName(value)} as a state document`);
	}
	return value;
}

/** Renders a document as canonical JSON: compact, with object keys sorted at every
 * depth, so the same document always produces the same bytes. */
export function marshal(doc: DocObject | null | undefined): string {
	return marshalValue(doc ?? {});
}

/** The canonical JSON size of a document — the number the byte cap is about. */
export function size(doc: DocObject): number {
	return byteLength(marshal(doc));
}

/** Re-renders a stored document in the canonical form `marshal` produces. Normalizes
 * formatting only; number digits are unchanged. */
export function canonicalize(raw: string): string {
	return marshal(unmarshal(raw));
}
