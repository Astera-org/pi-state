// Tests for agentstate's schema parsing and merge behavior.

import { describe, expect, test } from "vitest";
import {
	AgentStateSchemaError,
	DEFAULT_AUTO_MAX_STATE_BYTES_PERCENT,
	DEFAULT_MAX_STATE_BYTES,
	declaredKeys,
	JsonNumber,
	MalformedPatchError,
	marshal,
	merge,
	parsePatch,
	parseSchema,
	resolveAutoMaxStateBytes,
	schemaCap,
	TooLargeError,
	TypeMismatchError,
	UnknownKeyError,
	unmarshal,
} from "../src/agentstate/index.js";
import { patch, render, schema } from "./helpers.js";

test("merge sets and replaces", () => {
	const doc = patch(`{"objective":"old","step":1}`);
	const got = merge(doc, patch(`{"objective":"new","done":true,"files":["a.go"]}`), schema());
	expect(render(got)).toBe(`{"done":true,"files":["a.go"],"objective":"new","step":1}`);
	// merge does not mutate its inputs.
	expect(render(doc)).toBe(`{"objective":"old","step":1}`);
});

// A JSON null deletes its key.
test("merge: null deletes a key", () => {
	const doc = patch(`{"objective":"x","done":false,"files":["a"]}`);
	const got = merge(doc, patch(`{"done":null,"files":null}`), schema());
	expect(render(got)).toBe(`{"objective":"x"}`);
	expect("done" in got).toBe(false);
});

test("merge: null on an absent key is a no-op", () => {
	const got = merge(undefined, patch(`{"done":null}`), schema());
	expect(render(got)).toBe(`{}`);
});

// Objects merge deeply; null deletes at any depth.
test("merge: objects are deep", () => {
	const doc = patch(`{"findings":{"a":1,"b":{"c":2,"d":3}}}`);
	const got = merge(doc, patch(`{"findings":{"b":{"c":9,"d":null},"e":"new"}}`), schema());
	expect(render(got)).toBe(`{"findings":{"a":1,"b":{"c":9},"e":"new"}}`);
});

// An object patched onto a non-object value replaces it.
test("merge: object onto scalar replaces", () => {
	const doc = { findings: "not an object" };
	const got = merge(doc, patch(`{"findings":{"a":1}}`), schema());
	expect(render(got)).toBe(`{"findings":{"a":1}}`);
});

// Arrays replace; they are not appended.
test("merge: lists replace rather than append", () => {
	const doc = patch(`{"files":["a","b"]}`);
	const got = merge(doc, patch(`{"files":["c"]}`), schema());
	expect(render(got)).toBe(`{"files":["c"]}`);
});

test("merge: an empty patch is a no-op", () => {
	const doc = patch(`{"objective":"x","findings":{"a":1}}`);
	const got = merge(doc, {}, schema());
	expect(render(got)).toBe(render(doc));
});

// An undeclared key is refused, and the error names it.
test("merge: refuses an undeclared key", () => {
	expect(() => merge(undefined, patch(`{"history":["a"]}`), schema())).toThrow(UnknownKeyError);
	expect(() => merge(undefined, patch(`{"history":["a"]}`), schema())).toThrow(/"history"/);
	// Also refused when the stored document is non-empty.
	expect(() => merge({ objective: "x" }, patch(`{"history":["a"]}`), schema())).toThrow();
});

// The closed key set applies to the patch only; a stored key the schema does not declare
// is kept.
test("merge: carries undeclared stored keys through", () => {
	const doc = { retired: "value from an older schema", objective: "x" };
	const got = merge(doc, patch(`{"objective":"y"}`), schema());
	expect(render(got)).toBe(`{"objective":"y","retired":"value from an older schema"}`);
	// Such a key cannot be deleted by patch.
	expect(() => merge(doc, patch(`{"retired":null}`), schema())).toThrow(UnknownKeyError);
});

describe("merge: refuses a type mismatch", () => {
	test.each([
		["string key gets a number", `{"objective":3}`],
		["number key gets a string", `{"step":"3"}`],
		["bool key gets a string", `{"done":"yes"}`],
		["object key gets an array", `{"findings":["a"]}`],
		["list key gets an object", `{"files":{"a":1}}`],
	])("%s", (_name, raw) => {
		expect(() => merge(undefined, patch(raw), schema())).toThrow(TypeMismatchError);
	});
});

test("merge: refuses an over-long list", () => {
	let error: unknown;
	try {
		merge(undefined, patch(`{"files":["a","b","c","d"]}`), schema());
	} catch (err) {
		error = err;
	}
	expect((error as Error).message).toContain("4 items");
	expect((error as Error).message).toContain("at most 3");
});

// An array nested inside an object value is refused at any depth.
describe("merge: refuses arrays nested in objects", () => {
	test.each([
		["directly under an object key", `{"findings":{"log":["a"]}}`],
		["deeper under an object key", `{"findings":{"a":{"b":{"log":[]}}}}`],
		["inside a list element", `{"files":[{"log":["a"]}]}`],
		["a list of lists", `{"files":[["a"]]}`],
	])("%s", (_name, raw) => {
		expect(() => merge(undefined, patch(raw), schema())).toThrow(/array/);
	});
});

// The cap applies to the merged result, not to the patch.
test("merge: refuses over cap on the merged result", () => {
	const doc = { objective: "x".repeat(200) };
	const small = patch(`{"findings":{"note":"${"y".repeat(100)}"}}`);
	let error: unknown;
	try {
		merge(doc, small, schema());
	} catch (err) {
		error = err;
	}
	expect(error).toBeInstanceOf(TooLargeError);
	expect((error as Error).message).toContain("bytes and the cap is 256 bytes");
});

test("merge: applies the default cap", () => {
	const s = { keys: { objective: { type: "string" as const } } };
	expect(schemaCap(s)).toBe(DEFAULT_MAX_STATE_BYTES);
	expect(() => merge(undefined, { objective: "x".repeat(DEFAULT_MAX_STATE_BYTES + 1) }, s)).toThrow(TooLargeError);
});

// The zero schema declares no keys, so every non-empty patch is refused.
test("the zero schema declares nothing", () => {
	expect(() => merge(undefined, { anything: "x" }, { keys: {} })).toThrow(UnknownKeyError);
	const got = merge({}, {}, { keys: {} });
	expect(Object.keys(got)).toHaveLength(0);
});

test("numbers round trip exactly", () => {
	// Values are not decoded through a JS `number`, which would give 1000000000000000000.
	const got = merge(undefined, patch(`{"step":1000000000000000002}`), schema());
	expect(render(got)).toBe(`{"step":1000000000000000002}`);
	expect(got.step).toBeInstanceOf(JsonNumber);
});

test("unmarshal round trips a stored document", () => {
	const doc = patch(`{"findings":{"a":1},"files":["x"],"objective":"o","step":7,"done":true}`);
	const raw = marshal(doc);
	const back = unmarshal(raw);
	expect(render(back)).toBe(raw);

	const empty = unmarshal("");
	expect(empty).toEqual({});
});

test("parsePatch refuses non-objects", () => {
	for (const raw of ["[]", `"x"`, "3", "null", "{", '{"a":}']) {
		expect(() => parsePatch(raw), `ParsePatch(${raw})`).toThrow();
	}
	expect(() => parsePatch("[]")).toThrow(MalformedPatchError);
	expect(parsePatch("")).toEqual({});
});

test("parseSchema", () => {
	const s = parseSchema(`{"maxStateBytes":1024,"keys":{"a":{"type":"string"},"b":{"type":"list","maxItems":2}}}`);
	expect(schemaCap(s)).toBe(1024);
	expect(s.keys.b.maxItems).toBe(2);
	expect(declaredKeys(s)).toEqual(["a", "b"]);

	const empty = parseSchema("   ");
	expect(Object.keys(empty.keys)).toHaveLength(0);
});

// maxStateBytes has no upper bound.
test("parseSchema accepts a maxStateBytes above 64 KiB", () => {
	const s = parseSchema(`{"maxStateBytes":1048576,"keys":{"a":{"type":"string"}}}`);
	expect(schemaCap(s)).toBe(1048576);
});

test("parseSchema reads autoMaxStateBytesPercent on a schema with no maxStateBytes", () => {
	const s = parseSchema(`{"autoMaxStateBytesPercent":70,"keys":{"a":{"type":"string"}}}`);
	expect(s.maxStateBytes).toBeUndefined();
	expect(s.autoMaxStateBytesPercent).toBe(70);
	// agentstate does not know the context window; schemaCap returns DEFAULT_MAX_STATE_BYTES
	// until a caller resolves auto sizing.
	expect(schemaCap(s)).toBe(DEFAULT_MAX_STATE_BYTES);
});

// A schema with neither maxStateBytes nor autoMaxStateBytesPercent uses auto sizing at
// DEFAULT_AUTO_MAX_STATE_BYTES_PERCENT (65).
test("a schema with no maxStateBytes and no autoMaxStateBytesPercent is still auto, at the default percent", () => {
	const s = parseSchema(`{"keys":{"a":{"type":"string"}}}`);
	expect(s.maxStateBytes).toBeUndefined();
	expect(s.autoMaxStateBytesPercent).toBeUndefined();
	expect(schemaCap(s)).toBe(DEFAULT_MAX_STATE_BYTES);
});

test("parseSchema refuses an autoMaxStateBytesPercent outside 1-100", () => {
	for (const bad of [0, -5, 101, 1000]) {
		expect(() => parseSchema(`{"autoMaxStateBytesPercent":${bad},"keys":{}}`)).toThrow(AgentStateSchemaError);
	}
});

// Schemas with an unbounded list, or other invalid declarations, are refused at parse time.
describe("parseSchema refuses an unbounded list and other mistakes", () => {
	test.each([
		["a list with no maxItems", `{"keys":{"history":{"type":"list"}}}`],
		["a list with maxItems 0", `{"keys":{"history":{"type":"list","maxItems":0}}}`],
		["maxItems on a string", `{"keys":{"a":{"type":"string","maxItems":3}}}`],
		["an unknown type", `{"keys":{"a":{"type":"array"}}}`],
		["an empty key name", `{"keys":{"":{"type":"string"}}}`],
		["a negative cap", `{"maxStateBytes":-1,"keys":{"a":{"type":"string"}}}`],
		["an autoMaxStateBytesPercent below 1", `{"autoMaxStateBytesPercent":0,"keys":{"a":{"type":"string"}}}`],
		["an autoMaxStateBytesPercent above 100", `{"autoMaxStateBytesPercent":101,"keys":{"a":{"type":"string"}}}`],
		["an unknown schema field", `{"maxBytes":10,"keys":{}}`],
		["an unknown field on a key", `{"keys":{"a":{"type":"string","max":3}}}`],
		["malformed json", `{"keys":`],
	])("%s", (_name, raw) => {
		expect(() => parseSchema(raw), `ParseSchema accepted ${raw}`).toThrow();
	});

	test("an unbounded list wraps AgentStateSchemaError", () => {
		expect(() => parseSchema(`{"keys":{"history":{"type":"list"}}}`)).toThrow(AgentStateSchemaError);
	});
});

// merge validates the schema itself, since a hand-built Schema bypasses parseSchema.
test("merge revalidates the schema", () => {
	const bad = { keys: { history: { type: "list" as const } } };
	expect(() => merge(undefined, { history: ["a"] }, bad)).toThrow(AgentStateSchemaError);
});

describe("resolveAutoMaxStateBytes", () => {
	test("the byte-per-token math: contextWindowTokens * bytesPerToken * percent / 100, floored", () => {
		expect(resolveAutoMaxStateBytes(50, 1000, 4)).toBe(2000);
		// The result is floored.
		expect(resolveAutoMaxStateBytes(65, 1000, 4)).toBe(2600);
		expect(resolveAutoMaxStateBytes(33, 1000, 4)).toBe(1320);
	});

	test("defaults bytesPerToken to 4", () => {
		expect(resolveAutoMaxStateBytes(50, 1000)).toBe(resolveAutoMaxStateBytes(50, 1000, 4));
	});

	test("an explicit bytesPerToken overrides the default", () => {
		expect(resolveAutoMaxStateBytes(50, 1000, 2)).toBe(1000);
		expect(resolveAutoMaxStateBytes(50, 1000, 8)).toBe(4000);
	});

	// resolveAutoMaxStateBytes has no default percent; callers pass
	// DEFAULT_AUTO_MAX_STATE_BYTES_PERCENT.
	test("the default-percent case: a caller passing DEFAULT_AUTO_MAX_STATE_BYTES_PERCENT", () => {
		expect(DEFAULT_AUTO_MAX_STATE_BYTES_PERCENT).toBe(65);
		expect(resolveAutoMaxStateBytes(DEFAULT_AUTO_MAX_STATE_BYTES_PERCENT, 200000)).toBe(520000);
	});

	test.each([
		["a zero percent", 0, 1000, 4],
		["a negative percent", -1, 1000, 4],
		["a percent above 100", 101, 1000, 4],
		["a zero context window", 50, 0, 4],
		["a negative context window", 50, -1, 4],
		["a zero bytesPerToken", 50, 1000, 0],
		["a negative bytesPerToken", 50, 1000, -1],
	])("rejects %s", (_name, percent, contextWindowTokens, bytesPerToken) => {
		expect(() => resolveAutoMaxStateBytes(percent, contextWindowTokens, bytesPerToken)).toThrow();
	});
});
