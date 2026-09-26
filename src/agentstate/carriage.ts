// Ported from Astera-org/sproot's internal/agentstate/carriage.go (ENG-1172) — a
// READING of a stored document against its schema, not a verdict on whether it's true.
// See that file for the full rationale.

import { type DocValue, isPlainDocObject } from "./json.js";
import { declaredKeys, type Schema, unmarshal } from "./schema.js";

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
export function carriesNothing(c: Carriage): boolean {
	return c.declared.length > 0 && c.carried.length === 0;
}

/** Reports whether a stored value says nothing: an empty (or whitespace-only) string,
 * an empty object, or an empty list. A zero number and `false` are values an agent
 * chose, not emptiness. */
export function isEmptyValue(v: DocValue): boolean {
	if (typeof v === "string") return v.trim() === "";
	if (Array.isArray(v)) return v.length === 0;
	if (isPlainDocObject(v)) return Object.keys(v).length === 0;
	return false;
}

/** Reads a stored document against a schema. `raw` is the document as the store holds
 * it (canonical JSON; an empty string is the empty document). It never fails on
 * content — the only error is a document that does not parse. */
export function readCarriage(raw: string, schema: Schema): Carriage {
	const doc = unmarshal(raw);
	const declared = declaredKeys(schema);
	const carried: string[] = [];
	const notCarried: string[] = [];
	const empty: string[] = [];
	for (const key of declared) {
		const value = doc[key];
		if (value === undefined || value === null) {
			notCarried.push(key);
			continue;
		}
		carried.push(key);
		if (isEmptyValue(value)) empty.push(key);
	}
	const undeclared = Object.keys(doc)
		.filter((key) => !(key in schema.keys))
		.sort();
	return { declared, carried, notCarried, empty, undeclared };
}
