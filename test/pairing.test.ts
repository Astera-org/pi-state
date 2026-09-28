// Tests for the tool-cycle pairing rule (pairing.ts).

import { describe, expect, test } from "vitest";
import { type PairingShape, pairCycles } from "../src/stateboundary/pairing.js";

/**
 * Drives the pairing rule directly through a synthetic shape. `stateboundary.test.ts` covers
 * the pi-native adapter.
 *
 * Each spec entry is `c` (makes calls), `r` (answers one call) or `{}` (neither).
 */
type Spec = Array<{ c?: readonly string[] | "unverifiable"; r?: string }>;

function shapeOf(spec: Spec): PairingShape {
	return {
		length: spec.length,
		isResult: (i) => spec[i]!.r !== undefined,
		callIds: (i) => spec[i]!.c ?? null,
		resultId: (i) => (spec[i]!.r === "" ? null : (spec[i]!.r ?? null)),
	};
}
const calls = (...ids: string[]) => ({ c: ids });
const result = (id: string) => ({ r: id });
const other = () => ({});

function refuse(spec: Spec) {
	const got = pairCycles(shapeOf(spec));
	expect("refusal" in got, `accepted what must be refused: ${JSON.stringify(got)}`).toBe(true);
	return (got as { refusal: unknown }).refusal;
}
function accept(spec: Spec) {
	const got = pairCycles(shapeOf(spec));
	expect("cycles" in got, `refused what must be accepted: ${JSON.stringify(got)}`).toBe(true);
	return (got as { cycles: unknown }).cycles;
}

describe("the shared pairing core", () => {
	// Each refusal is asserted by code and by `at`/`id`, which callers render into their
	// messages.
	test.each([
		["a result before any call", [result("a")], { code: "stray-result", at: 0 }],
		["a result carrying no id", [calls("a"), result("")], { code: "result-without-id", at: 1 }],
		["an id answered twice", [calls("a", "b"), result("a"), result("a")], { code: "answered-twice", at: 2, id: "a" }],
		// Three calls, one result: a check on "at least one result followed" would accept this.
		[
			"a call left unanswered in a multi-call cycle",
			[calls("a", "b", "c"), result("a")],
			{ code: "unanswered-call", at: 0, id: "b" },
		],
		[
			"a result answering a call this assistant did not make",
			[calls("a"), result("a"), result("ghost")],
			{ code: "unrequested-result", at: 0, id: "ghost" },
		],
		// An unreadable call id with no results after it: reported as an empty list, the arity
		// loop would have nothing to iterate and the cycle would pass.
		["an id-less call with no results", [{ c: "unverifiable" as const }], { code: "unverifiable-call", at: 0 }],
		[
			"an id-less call WITH results",
			[{ c: "unverifiable" as const }, result("a")],
			{ code: "unverifiable-call", at: 0 },
		],
		["a call with no results at all", [calls("a")], { code: "unanswered-call", at: 0, id: "a" }],
	])("refuses: %s", (_name, spec, want) => {
		expect(refuse(spec)).toEqual(want);
	});

	// Guards against a core that refuses everything.
	test("accepts a well-formed multi-call cycle, and reports its span", () => {
		expect(accept([calls("a", "b"), result("a"), result("b")])).toEqual([{ start: 0, end: 2 }]);
	});

	test("accepts back-to-back cycles and messages that are neither", () => {
		expect(accept([other(), calls("a"), result("a"), other(), calls("b"), result("b")])).toEqual([
			{ start: 1, end: 2 },
			{ start: 4, end: 5 },
		]);
	});

	test("accepts a run with no cycles in it at all", () => {
		expect(accept([other(), other()])).toEqual([]);
		expect(accept([])).toEqual([]);
	});

	// Only the set of result ids matters, not their order.
	test("does not require results in the order the calls were made", () => {
		expect(accept([calls("a", "b"), result("b"), result("a")])).toEqual([{ start: 0, end: 2 }]);
	});

	// A cycle ends where its contiguous run of results ends.
	test("ends a cycle at the first non-result, so spans never overlap", () => {
		const got = accept([calls("a"), result("a"), calls("b", "b2"), result("b"), result("b2")]);
		expect(got).toEqual([
			{ start: 0, end: 1 },
			{ start: 2, end: 4 },
		]);
	});

	// Results after a later assistant message cannot answer an earlier one.
	test("does not let a later cycle's result answer an earlier cycle's call", () => {
		expect(refuse([calls("a"), calls("b"), result("a"), result("b")])).toEqual({
			code: "unanswered-call",
			at: 0,
			id: "a",
		});
	});
});
