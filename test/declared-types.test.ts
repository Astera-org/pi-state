// Each declared key's type is published alongside its name (declaredTypes, fieldSpec),
// and refusals list declared keys with their types.

import { describe, expect, test } from "vitest";
import {
	declaredKeys,
	declaredTypes,
	type Field,
	fieldSpec,
	merge,
	parseSchema,
	type Schema,
	UnknownKeyError,
	validateSchema,
} from "../src/agentstate/index.js";
import { patch } from "./helpers.js";

// One key of every kind; names do not indicate type (`decided` is a string, `shelf_ids` is a
// list).
function declaredTypesSchema(): Schema {
	return parseSchema(
		`{"maxStateBytes":1024,"keys":{` +
			`"decided":{"type":"string"},` +
			`"shelf_ids":{"type":"list","maxItems":4},` +
			`"score":{"type":"number"},` +
			`"blocked":{"type":"bool"},` +
			`"findings":{"type":"object"}}}`,
	);
}

// Builds one JSON value of the type a published spec names. A list is filled to exactly
// its bracketed maxItems.
function valueForPublishedSpec(spec: string): string {
	switch (spec) {
		case "string":
			return `"x"`;
		case "number":
			return "7";
		case "bool":
			return "true";
		case "object":
			return `{"a":1}`;
	}
	const match = /^list\[(\d+)\]$/.exec(spec);
	if (!match) throw new Error(`spec ${JSON.stringify(spec)} names no type this reader knows`);
	const max = Number(match[1]);
	const items = Array.from({ length: max }, (_, i) => JSON.stringify(`id-${i}`));
	return `[${items.join(",")}]`;
}

// For every declared key, a value built from the published spec is accepted by merge.
test("declared types are enough to write an accepted patch", () => {
	const schema = declaredTypesSchema();
	const types = declaredTypes(schema);

	expect(Object.keys(types)).toHaveLength(Object.keys(schema.keys).length);
	for (const name of declaredKeys(schema)) {
		expect(types).toHaveProperty(name);
	}

	const fields = declaredKeys(schema).map((name) => `${JSON.stringify(name)}:${valueForPublishedSpec(types[name])}`);
	const raw = `{${fields.join(",")}}`;
	const got = merge(undefined, patch(raw), schema);
	expect(Object.keys(got)).toHaveLength(Object.keys(schema.keys).length);
});

// A list spec carries its maxItems in brackets; other kinds carry no bound.
test("field spec names the kind and a list's bound", () => {
	const cases: Array<[Field, string]> = [
		[{ type: "string" }, "string"],
		[{ type: "number" }, "number"],
		[{ type: "bool" }, "bool"],
		[{ type: "object" }, "object"],
		[{ type: "list", maxItems: 1 }, "list[1]"],
		[{ type: "list", maxItems: 64 }, "list[64]"],
	];
	for (const [field, want] of cases) {
		expect(fieldSpec(field)).toBe(want);
	}
	// declaredTypes orders its keys sorted, so its serialization is deterministic.
	const want = `{"blocked":"bool","decided":"string","findings":"object","score":"number","shelf_ids":"list[4]"}`;
	expect(JSON.stringify(declaredTypes(declaredTypesSchema()))).toBe(want);
});

// validateSchema refuses a key whose kind has no spec spelling.
test("only a spellable kind can be declared", () => {
	for (const kind of ["string", "number", "bool", "object", "list"] as const) {
		const field: Field = kind === "list" ? { type: kind, maxItems: 2 } : { type: kind };
		const s: Schema = { keys: { k: field } };
		expect(() => validateSchema(s)).not.toThrow();
		expect(() => valueForPublishedSpec(fieldSpec(field))).not.toThrow();
	}
	const unspellable: Schema = { keys: { k: { type: "timestamp" as Field["type"] } } };
	expect(() => validateSchema(unspellable)).toThrow();
});

// A refusal names the offending key and lists every declared key with its type.
describe("refusals name what was declared and what arrived", () => {
	test("an unknown key", () => {
		const schema = declaredTypesSchema();
		let error: unknown;
		try {
			merge(undefined, patch(`{"shelves":["a"]}`), schema);
		} catch (err) {
			error = err;
		}
		expect(error).toBeInstanceOf(UnknownKeyError);
		for (const want of [
			`"shelves"`,
			"decided string",
			"shelf_ids list[4]",
			"findings object",
			"score number",
			"blocked bool",
		]) {
			expect((error as Error).message).toContain(want);
		}
	});

	test.each([
		[
			"a list key guessed as an object names the bound too",
			`{"shelf_ids":{"a":1}}`,
			`key "shelf_ids" is declared list[4] but the patch has object`,
		],
		["a string key guessed as a bool", `{"decided":true}`, `key "decided" is declared string but the patch has bool`],
		[
			"an object key guessed as an array",
			`{"findings":["a"]}`,
			`key "findings" is declared object but the patch has array`,
		],
		["a number key guessed as a string", `{"score":"7"}`, `key "score" is declared number but the patch has string`],
		[
			"a bool key guessed as a string",
			`{"blocked":"yes"}`,
			`key "blocked" is declared bool but the patch has string`,
		],
	])("%s", (_name, raw, want) => {
		const schema = declaredTypesSchema();
		let error: unknown;
		try {
			merge(undefined, patch(raw), schema);
		} catch (err) {
			error = err;
		}
		expect((error as Error).message).toContain(want);
	});

	// The refusal reports an empty declared key set.
	test("the zero schema says it declares no keys", () => {
		let error: unknown;
		try {
			merge(undefined, patch(`{"decided":"x"}`), { keys: {} });
		} catch (err) {
			error = err;
		}
		expect(error).toBeInstanceOf(UnknownKeyError);
		expect((error as Error).message).toContain("no keys at all");
	});
});
