// Ported 1:1 from Astera-org/sproot's internal/agentstate/agentstate_test.go and
// merge_test cases embedded in it. See that file's comments for the rationale behind
// each case; kept here only where it explains something not obvious from the assertion.

import { describe, expect, test } from "vitest";
import {
	AgentStateSchemaError,
	DEFAULT_MAX_STATE_BYTES,
	declaredKeys,
	JsonNumber,
	MalformedPatchError,
	marshal,
	merge,
	parsePatch,
	parseSchema,
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
	// The inputs are untouched — a caller that refuses the result must still hold the
	// document it started from.
	expect(render(doc)).toBe(`{"objective":"old","step":1}`);
});

// A JSON null DELETES its key. Storing null instead would let a working set
// accumulate dead keys that keep paying their bytes in every request.
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

// Objects merge DEEP, and null deletes at depth too.
test("merge: objects are deep", () => {
	const doc = patch(`{"findings":{"a":1,"b":{"c":2,"d":3}}}`);
	const got = merge(doc, patch(`{"findings":{"b":{"c":9,"d":null},"e":"new"}}`), schema());
	expect(render(got)).toBe(`{"findings":{"a":1,"b":{"c":9},"e":"new"}}`);
});

// An object patched onto a non-object value replaces it rather than failing.
test("merge: object onto scalar replaces", () => {
	const doc = { findings: "not an object" };
	const got = merge(doc, patch(`{"findings":{"a":1}}`), schema());
	expect(render(got)).toBe(`{"findings":{"a":1}}`);
});

// Arrays REPLACE. Appending would be the one semantics that turns Sigma into a log.
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

// The closed key set. An undeclared key is refused, and the error NAMES it.
test("merge: refuses an undeclared key", () => {
	expect(() => merge(undefined, patch(`{"history":["a"]}`), schema())).toThrow(UnknownKeyError);
	expect(() => merge(undefined, patch(`{"history":["a"]}`), schema())).toThrow(/"history"/);
	// It must not have been kept OR dropped silently.
	expect(() => merge({ objective: "x" }, patch(`{"history":["a"]}`), schema())).toThrow();
});

// The closed key set governs the PATCH; a key the schema no longer declares survives
// in the stored document rather than being pruned.
test("merge: carries undeclared stored keys through", () => {
	const doc = { retired: "value from an older schema", objective: "x" };
	const got = merge(doc, patch(`{"objective":"y"}`), schema());
	expect(render(got)).toBe(`{"objective":"y","retired":"value from an older schema"}`);
	// And the agent cannot null it out, which is the cost this behaviour accepts.
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

// An array nested inside an object value is the append-only log the schema cannot
// bound, so it is refused wherever it appears.
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

// The cap is enforced on the MERGED result, not on the patch.
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

// The zero schema declares nothing, so it refuses every non-empty patch.
test("the zero schema declares nothing", () => {
	expect(() => merge(undefined, { anything: "x" }, { keys: {} })).toThrow(UnknownKeyError);
	const got = merge({}, {}, { keys: {} });
	expect(Object.keys(got)).toHaveLength(0);
});

test("numbers round trip exactly", () => {
	// Decoding through a JS `number` would turn this into 1000000000000000000 (and 1e6
	// for a plain million), which is a different value than the agent stored.
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

// The growth-shaped schema is refused at AUTHORING time: an unbounded list cannot be
// written down, so the "history array" shape has nowhere to live.
describe("parseSchema refuses an unbounded list and other mistakes", () => {
	test.each([
		["a list with no maxItems", `{"keys":{"history":{"type":"list"}}}`],
		["a list with maxItems 0", `{"keys":{"history":{"type":"list","maxItems":0}}}`],
		["maxItems on a string", `{"keys":{"a":{"type":"string","maxItems":3}}}`],
		["an unknown type", `{"keys":{"a":{"type":"array"}}}`],
		["an empty key name", `{"keys":{"":{"type":"string"}}}`],
		["a cap above the ceiling", `{"maxStateBytes":1048576,"keys":{"a":{"type":"string"}}}`],
		["a negative cap", `{"maxStateBytes":-1,"keys":{"a":{"type":"string"}}}`],
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

// Merge revalidates the schema rather than trusting its caller: a hand-built Schema
// never went through parseSchema.
test("merge revalidates the schema", () => {
	const bad = { keys: { history: { type: "list" as const } } };
	expect(() => merge(undefined, { history: ["a"] }, bad)).toThrow(AgentStateSchemaError);
});
