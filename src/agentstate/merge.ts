// Ported from Astera-org/sproot's internal/agentstate/merge.go. See that file for the
// full rationale behind each rule (null deletes, objects merge deep, arrays replace).

import {
	NestedListError,
	NumberRangeError,
	TooLargeError,
	TooManyItemsError,
	TypeMismatchError,
	UnknownKeyError,
} from "./errors.js";
import { type DocObject, type DocValue, isPlainDocObject, JsonNumber, jsonTypeName, quote } from "./json.js";
import { canonicalNumber } from "./number.js";
import {
	declaredSummary,
	type Field,
	fieldSpec,
	type Schema,
	schemaCap,
	size as sizeOf,
	validateSchema,
} from "./schema.js";

function sortedKeys(m: DocObject): string[] {
	return Object.keys(m).sort();
}

function copyValue(v: DocValue): DocValue {
	if (Array.isArray(v)) return v.map(copyValue);
	if (isPlainDocObject(v)) return copyObject(v);
	return v;
}

function copyObject(m: DocObject | null | undefined): DocObject {
	const out: DocObject = {};
	if (!m) return out;
	for (const k of Object.keys(m)) out[k] = copyValue(m[k]);
	return out;
}

function typeMismatch(key: string, want: Field, got: DocValue): TypeMismatchError {
	return new TypeMismatchError(
		`key ${quote(key)} is declared ${fieldSpec(want)} but the patch has ${jsonTypeName(got)}: value does not match the declared type`,
	);
}

/** Walks a patch's structured value and returns the version that may be stored: an
 * array is rejected wherever it appears inside an object value, and a number is
 * canonicalized. */
function sanitizeValue(path: string, v: DocValue): DocValue {
	if (isPlainDocObject(v)) return sanitizeObject(path, v);
	if (v instanceof JsonNumber) {
		try {
			return canonicalNumber(v);
		} catch (err) {
			if (err instanceof NumberRangeError) throw new NumberRangeError(`${path}: ${err.message}`);
			throw err;
		}
	}
	// A string, a bool, or a null (null inside an object value is a deletion, applied by
	// mergeObject) — nothing to normalize and nothing that can grow.
	return v;
}

function sanitizeObject(path: string, obj: DocObject): DocObject {
	const out: DocObject = {};
	for (const key of sortedKeys(obj)) {
		const child = `${path}.${key}`;
		if (Array.isArray(obj[key])) {
			throw new NestedListError(
				`${child} is an array: an array may only appear at a declared list key, not nested inside an object value`,
			);
		}
		out[key] = sanitizeValue(child, obj[key]);
	}
	return out;
}

/** The deep half of the merge: key-by-key, with null deleting and a nested object recursing. */
function mergeObject(current: DocObject | null | undefined, patch: DocObject): DocObject {
	const out = copyObject(current);
	for (const key of sortedKeys(patch)) {
		const value = patch[key];
		if (value === null) {
			delete out[key];
			continue;
		}
		if (isPlainDocObject(value)) {
			const cur = isPlainDocObject(out[key]) ? (out[key] as DocObject) : undefined;
			out[key] = mergeObject(cur, value);
			continue;
		}
		out[key] = copyValue(value);
	}
	return out;
}

/** Applies one declared key's patch value onto its current value. */
function mergeValue(key: string, current: DocValue, value: DocValue, field: Field): DocValue {
	switch (field.type) {
		case "string":
			if (typeof value !== "string") throw typeMismatch(key, field, value);
			return value;
		case "number": {
			if (!(value instanceof JsonNumber)) throw typeMismatch(key, field, value);
			try {
				return canonicalNumber(value);
			} catch (err) {
				if (err instanceof NumberRangeError) throw new NumberRangeError(`key ${quote(key)}: ${err.message}`);
				throw err;
			}
		}
		case "bool":
			if (typeof value !== "boolean") throw typeMismatch(key, field, value);
			return value;
		case "list": {
			if (!Array.isArray(value)) throw typeMismatch(key, field, value);
			const maxItems = field.maxItems ?? 0;
			if (value.length > maxItems) {
				throw new TooManyItemsError(
					`key ${quote(key)} has ${value.length} items and allows at most ${maxItems}: list is longer than the schema allows`,
				);
			}
			return value.map((item, i) => {
				if (Array.isArray(item)) {
					throw new NestedListError(
						`key ${quote(key)} item ${i} is an array: an array may only appear at a declared list key, not nested inside an object value`,
					);
				}
				return sanitizeValue(`${key}[${i}]`, item);
			});
		}
		case "object": {
			if (!isPlainDocObject(value)) throw typeMismatch(key, field, value);
			const sanitized = sanitizeObject(key, value);
			const cur = isPlainDocObject(current) ? current : undefined;
			return mergeObject(cur, sanitized);
		}
		default:
			// Unreachable: validateSchema ran first. Kept so a kind added without a case
			// here refuses rather than silently storing an unvalidated value.
			throw new Error(`key ${quote(key)} declares unknown type ${quote(String(field.type))}`);
	}
}

/** Applies `patch` to `doc` under `schema` and returns the document that should replace
 * it. Neither `doc` nor `patch` is mutated. See merge.go for the full semantics: null
 * deletes, objects merge deep, arrays replace wholesale, and the byte cap is applied
 * last, to the merged result. */
export function merge(doc: DocObject | null | undefined, patch: DocObject, schema: Schema): DocObject {
	validateSchema(schema);
	const out = copyObject(doc);
	for (const key of sortedKeys(patch)) {
		const field = schema.keys[key];
		if (!field) {
			// Names the offending key AND what is on offer with its types (ENG-1116).
			throw new UnknownKeyError(
				`key ${quote(key)} (the schema declares ${declaredSummary(schema)}): this key is not declared by the role's state schema`,
			);
		}
		const value = patch[key];
		if (value === null) {
			delete out[key];
			continue;
		}
		out[key] = mergeValue(key, out[key], value, field);
	}
	const bytes = sizeOf(out);
	const limit = schemaCap(schema);
	if (bytes > limit) {
		throw new TooLargeError(
			`the merged document is ${bytes} bytes and the cap is ${limit} bytes: merged agent state is over the schema's byte cap`,
		);
	}
	return out;
}
