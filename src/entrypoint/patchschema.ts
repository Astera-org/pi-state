// Adapts an agentstate `Schema` into the JSON Schema `state_commit` advertises for its
// `patch` argument — ported from sproot's `internal/mcp/agentstate.go`
// (`stateCommitPatchSchema`, `stateCommitInputSchema`): one property per declared key,
// each type unioned with `null` (a null value is how `merge` DELETES a key, so the union
// is not decoration — see merge.ts), a list also carrying `maxItems`, and
// `additionalProperties: false` for the closed key set.
//
// Dropped from the Go original: `action_summary`, sproot's operator-facing action-log
// line. There is no action log in a standalone extension, so this surface asks only for
// what the file backend's compare-and-set needs — `patch` and `version`.

import { declaredKeys, Kind, type Schema } from "../agentstate/index.js";

/** Every JSON type a list ITEM may take — the five minus "array": an array may only
 * appear at a declared list key, never nested inside one (agentstate's NestedListError). */
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
