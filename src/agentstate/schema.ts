// Ported from Astera-org/sproot's internal/agentstate/agentstate.go — the Schema model,
// ParseSchema, ParsePatch, and the canonical Marshal/Unmarshal/Canonicalize/Size
// primitives. See that file for the full rationale behind each rule; the short version
// is in this repo's README.
//
// Naming: Go's exported `PascalCase` functions (`ParseSchema`, `Merge`, ...) are ported
// as `camelCase` (`parseSchema`, `merge`, ...) per TypeScript convention; types stay
// `PascalCase` (`Schema`, `Field`, `Kind`). Same words, different case, so a reader can
// still find the Go source a given export was ported from.

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

function decodeIntegerMember(value: DocValue): number {
	return value instanceof JsonNumber ? Number(value.raw) : Number.NaN;
}

/** The cap applied when a schema declares none. See agentstate.go for the 4 KiB rationale. */
export const DEFAULT_MAX_STATE_BYTES = 4096;

/** The largest cap a schema may declare. */
export const MAX_STATE_BYTES_CEILING = 64 * 1024;

/** Bounds one key's `desc`, in bytes. */
export const MAX_DESC_BYTES = 160;

/** The declared type of one top-level Sigma key. There is deliberately no "anything"
 * kind: an undeclared shape is what lets growth in. */
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
 * validates on the first try (ENG-1116). */
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

/** Whether any declared key carries prose (ENG-1404). */
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

/** Reports whether the schema itself is well-formed. This is where a growth-shaped
 * declaration is refused: an unbounded list cannot be written down. */
export function validateSchema(schema: Schema): void {
	const maxStateBytes = schema.maxStateBytes ?? 0;
	if (maxStateBytes < 0) {
		throw schemaError(`maxStateBytes ${maxStateBytes} is negative`);
	}
	if (maxStateBytes > MAX_STATE_BYTES_CEILING) {
		throw schemaError(`maxStateBytes ${maxStateBytes} is above the ${MAX_STATE_BYTES_CEILING}-byte ceiling`);
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
		const n = decodeIntegerMember(value.maxItems);
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
	const allowed = new Set(["keys", "maxStateBytes"]);
	for (const member of Object.keys(value)) {
		if (!allowed.has(member)) {
			throw new Error(`the state schema has an unknown field ${quote(member)}`);
		}
	}
	const schema: Schema = { keys: {} };
	if ("maxStateBytes" in value) {
		const n = decodeIntegerMember(value.maxStateBytes);
		if (!Number.isInteger(n)) {
			throw new Error("maxStateBytes must be an integer");
		}
		schema.maxStateBytes = n;
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
 * source digits so a value round-trips through Sigma exactly as the agent wrote it. */
export function parsePatch(raw: string): DocObject {
	if (raw.length === 0) return {};
	const value = parseJsonDocument(raw);
	if (!isPlainDocObject(value)) {
		throw new MalformedPatchError(`got ${jsonTypeName(value)}: state patch must be a JSON object`);
	}
	return value;
}

/** Reads a stored document back. Like parsePatch, numbers stay in their exact source
 * form, so a document that round-trips through storage is byte-identical. */
export function unmarshal(raw: string): DocObject {
	if (raw.length === 0) return {};
	const value = parseJsonDocument(raw);
	if (!isPlainDocObject(value)) {
		throw new Error(`cannot read ${jsonTypeName(value)} as a state document`);
	}
	return value;
}

/** Renders a document as the canonical JSON both back-ends would store: compact, with
 * object keys sorted at every depth, so the same document always produces the same bytes. */
export function marshal(doc: DocObject | null | undefined): string {
	return marshalValue(doc ?? {});
}

/** The canonical JSON size of a document — the number the byte cap is about. */
export function size(doc: DocObject): number {
	return byteLength(marshal(doc));
}

/** Re-renders a stored document in the canonical form `marshal` produces, so two
 * back-ends with different JSON renderings answer with the same bytes. It normalizes
 * shape, never size: an expanded number stays expanded. */
export function canonicalize(raw: string): string {
	return marshal(unmarshal(raw));
}
