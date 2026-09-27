// Tests for the canonical number form and its byte cap (number.ts).

import { describe, expect, test } from "vitest";
import {
	canonicalize,
	MAX_NUMBER_BYTES,
	merge,
	NumberRangeError,
	parsePatch,
	parseSchema,
	type Schema,
	size,
	TooLargeError,
	TrailingContentError,
	unmarshal,
} from "../src/agentstate/index.js";
import { patch, render, schema } from "./helpers.js";

// The byte cap is measured on the form the document is STORED as, so a number is
// expanded out of exponent notation before it is sized.
describe("numbers are stored in expanded decimal form", () => {
	test.each([
		["a positive exponent expands", `{"step":1e3}`, `{"step":1000}`],
		["a mantissa and exponent expand", `{"step":1.5e3}`, `{"step":1500}`],
		["a negative exponent expands", `{"step":1.5e-7}`, `{"step":0.00000015}`],
		["an explicitly signed exponent expands", `{"step":2E+2}`, `{"step":200}`],
		["the leading zero run the shift produces is collapsed", `{"step":0.10e1}`, `{"step":1.0}`],
		["a plain decimal is untouched", `{"step":1.50}`, `{"step":1.50}`],
		["a large integer literal is untouched", `{"step":1000000000000000002}`, `{"step":1000000000000000002}`],
		// numeric has no negative zero, so neither does the canonical form.
		["negative zero loses its sign", `{"step":-0}`, `{"step":0}`],
		["negative zero keeps its scale", `{"step":-0.00}`, `{"step":0.00}`],
		["a negative value keeps its sign", `{"step":-1.5e2}`, `{"step":-150}`],
		["a nested number expands too", `{"findings":{"p":1e-3}}`, `{"findings":{"p":0.001}}`],
		["a list item expands too", `{"files":[1e2]}`, `{"files":[100]}`],
	])("%s", (_name, rawPatch, want) => {
		const got = merge(undefined, patch(rawPatch), schema());
		expect(render(got)).toBe(want);
		// What was sized IS what is rendered — the whole point.
		expect(size(got)).toBe(want.length);
	});
});

// The refusal fires on the CANONICAL LENGTH and nothing else, not on the exponent.
test("number length is judged on the canonical form, not the exponent", () => {
	const sixtyFourBytes = `1${"0".repeat(63)}`;
	const cases: Array<[string, string, string]> = [
		["exactly at the limit", `{"step":1e63}`, `{"step":${sixtyFourBytes}}`],
		["the same value written with a cancelling exponent", `{"step":0.01e65}`, `{"step":${sixtyFourBytes}}`],
		["a mantissa that uses the last two bytes", `{"step":1.5e63}`, `{"step":15${"0".repeat(62)}}`],
		["a fraction exactly at the limit", `{"step":1e-62}`, `{"step":0.${"0".repeat(61)}1}`],
		// Zero cancels entirely: numeric carries no magnitude and no negative zero for it.
		["zero with a large exponent", `{"step":0e65}`, `{"step":0}`],
		["negative zero with a large exponent", `{"step":-0e65}`, `{"step":0}`],
		["a zero mantissa with a fraction", `{"step":0.00e9}`, `{"step":0}`],
	];
	for (const [, rawPatch, want] of cases) {
		const got = merge(undefined, patch(rawPatch), schema());
		expect(render(got)).toBe(want);
	}

	// One byte over is refused, and the message quotes the REAL length.
	let error: unknown;
	try {
		merge(undefined, patch(`{"step":1e64}`), schema());
	} catch (err) {
		error = err;
	}
	expect(error).toBeInstanceOf(NumberRangeError);
	expect((error as Error).message).toContain("65 bytes");
	expect((error as Error).message).toContain("limit is 64");

	// A zero that keeps a long SCALE is genuinely long, so it is refused.
	expect(() => merge(undefined, patch(`{"step":0e-70}`), schema())).toThrow(NumberRangeError);
});

// A number whose expanded form cannot be stored identically by both back-ends is
// refused, in one place.
describe("numbers outside the storable range are refused", () => {
	test.each([
		["the exponent bomb the cap could not see", `{"step":1e10000}`],
		["the same bomb in the other direction", `{"step":1e-10000}`],
		["an exponent too large for an int", `{"step":1e999999999999999999999}`],
		["a literal longer than the limit", `{"step":${"9".repeat(MAX_NUMBER_BYTES + 1)}}`],
		["a nested exponent bomb", `{"findings":{"p":1e10000}}`],
		["an exponent bomb in a list item", `{"files":[1e10000]}`],
	])("%s", (_name, rawPatch) => {
		expect(() => merge(undefined, patch(rawPatch), schema())).toThrow(NumberRangeError);
	});

	// The refusal is about the STORED size, so it fires under the generous default cap too.
	test("fires under a 64 KiB cap too", () => {
		const big: Schema = { maxStateBytes: 64 * 1024, keys: { step: { type: "number" } } };
		expect(() => merge(undefined, patch(`{"step":1e10000}`), big)).toThrow(NumberRangeError);
	});
});

// The expanded form counts toward the cap.
test("expanded numbers count toward the cap", () => {
	const doc = { objective: "x".repeat(200) };
	const tiny = patch(`{"step":1e60}`);
	expect(size(tiny)).toBeLessThanOrEqual(20);
	expect(() => merge(doc, tiny, schema())).toThrow(TooLargeError);
});

// A second JSON value after the first is refused everywhere a document is parsed.
describe("trailing content is refused", () => {
	test("parsePatch", () => {
		for (const raw of [`{}[]`, `{"a":1} {"b":2}`, `{} garbage`, `{}{`, `{}null`]) {
			expect(() => parsePatch(raw), raw).toThrow(TrailingContentError);
		}
		// A single value, with whitespace around it, is still fine.
		expect(() => parsePatch('  {"a":1}\n\t')).not.toThrow();
	});

	test("parseSchema", () => {
		for (const raw of [`{"keys":{}}{"extra":1}`, `{"keys":{}} []`, `{"keys":{}} oops`]) {
			expect(() => parseSchema(raw), raw).toThrow(TrailingContentError);
		}
		expect(() => parseSchema(`{"keys":{"a":{"type":"string"}}}\n`)).not.toThrow();
	});

	test("unmarshal", () => {
		expect(() => unmarshal(`{"a":1}{"b":2}`)).toThrow(TrailingContentError);
	});
});

// Canonicalize is what makes the two back-ends answer with the same bytes.
test("canonicalize absorbs the storage rendering", () => {
	const jsonbish = `{"step": 2, "objective": "x", "findings": {"b": 1, "a": 2}}`;
	const got = canonicalize(jsonbish);
	expect(got).toBe(`{"findings":{"a":2,"b":1},"objective":"x","step":2}`);

	// It normalizes SHAPE, never size: an expanded number stays expanded.
	const expanded = canonicalize(`{"step": 1000000000000000000000}`);
	expect(expanded).toBe(`{"step":1000000000000000000000}`);
});
