// Adapts an agentstate `Schema` into the JSON Schema `state_commit` advertises: a `patch`
// argument with one property per declared key, each type unioned with `null` (null
// deletes a key; see merge.ts), a list also carrying `maxItems`, and
// `additionalProperties: false` for the closed key set; plus the `version` argument, the
// file backend's compare-and-set token.

import { declaredKeys, Kind, type Schema } from "../agentstate/index.js";

/** The JSON types a list item may take: every kind except array, since an array may
 * appear only at a declared list key (agentstate's NestedListError). */
const LIST_ITEM_TYPES = ["string", "number", "boolean", "object", "null"];

function jsonSchemaType(kind: Schema["keys"][string]["type"]): string {
	switch (kind) {
		case Kind.Bool:
			return "boolean";
		case Kind.List:
			return "array";
		default:
			return kind;
	}
}

/** One declared key's JSON Schema property. */
function patchProperty(field: Schema["keys"][string]): Record<string, unknown> {
	const prop: Record<string, unknown> = { type: [jsonSchemaType(field.type), "null"] };
	const desc = (field.desc ?? "").trim();
	if (desc !== "") prop.description = desc;
	if (field.type === Kind.List) {
		prop.maxItems = field.maxItems;
		prop.items = { type: LIST_ITEM_TYPES };
	}
	return prop;
}

/** The `patch` argument's own schema: the declared key set, closed. */
export function patchSchema(schema: Schema): Record<string, unknown> {
	const properties: Record<string, unknown> = {};
	for (const name of declaredKeys(schema)) properties[name] = patchProperty(schema.keys[name]);
	return {
		type: "object",
		description:
			"the keys to set. A null value DELETES its key. The property set here is CLOSED — a key not listed is refused.",
		properties,
		additionalProperties: false,
	};
}

/** `state_commit`'s whole input schema: `patch` (schema-derived) plus the CAS `version`. */
export function stateCommitInputSchema(schema: Schema): Record<string, unknown> {
	return {
		type: "object",
		properties: {
			patch: patchSchema(schema),
			version: {
				type: "integer",
				description:
					"the version you read with state_get (0 if you have no state yet). REQUIRED: it is the compare-and-set token, so a commit decided against an older version is refused instead of overwriting a newer one.",
			},
		},
		required: ["patch", "version"],
		additionalProperties: false,
	};
}
