// Tests for the tool-cycle pairing rule (pairing.ts). The rule never touches
// process.env, so it is driven directly here with no environment setup.

import { describe, expect, test } from "vitest";
import { type PairingShape, pairCycles } from "../src/stateboundary/pairing.js";

/**
 * The pairing RULE, driven directly — not through either shape.
 *
 * `stateboundary.test.ts`'s table guards the pi-native ADAPTER (that the shape is
 * classified correctly); this file guards the rule it shares. The split matters because
 * the two failure modes are different: an adapter bug misreads one shape, a rule bug is
 * wrong for every shape at once — and before this rule was shared out of two copies, only
 * one copy was ever wrong.
 *
 * The shape here is a tiny literal list rather than the real message format, so a case is
 * legible as what the RULE sees: `c` makes calls, `r` answers one, `x` is neither.
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
	// Each refusal is asserted by CODE and by WHERE it points. A test that only checked
	// "something was refused" would pass against a core that returned the first code for
	// everything, and the `at`/`id` are what each caller renders its sentence from — a
	// refusal naming the wrong message is a diagnostic that sends a reader to the wrong
	// place.
	test.each([
		["a result before any call", [result("a")], { code: "stray-result", at: 0 }],
		["a result carrying no id", [calls("a"), result("")], { code: "result-without-id", at: 1 }],
		["an id answered twice", [calls("a", "b"), result("a"), result("a")], { code: "answered-twice", at: 2, id: "a" }],
		// THE ONE A LENGTH-BASED CHECK GOT WRONG: three calls, one result. A rule keyed on
		// "at least one result followed" accepts this, and a cut here sends two unanswered
		// calls to the provider.
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
		// THE OTHER ONE: a call whose id cannot be read, with NO results after it. With the
		// ids reported as an empty list the arity loop has nothing to iterate and the cycle
		// passes, so "unverifiable" has to be its own answer rather than a short list.
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

	// The floor under every row above: without it, a core that refused EVERYTHING would
	// satisfy all of them.
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

	// Order of results within a cycle is not part of the rule — only the SET is. A core
	// that compared sequences would refuse a provider that answered in a different order,
	// which is conforming behaviour.
	test("does not require results in the order the calls were made", () => {
		expect(accept([calls("a", "b"), result("b"), result("a")])).toEqual([{ start: 0, end: 2 }]);
	});

	// A cycle ends where its contiguous run of results ends, so a following cycle's
	// results are never swallowed into the one before it — which would report a span the
	// caller then cuts on, keeping messages it believed it had dropped.
	test("ends a cycle at the first non-result, so spans never overlap", () => {
		const got = accept([calls("a"), result("a"), calls("b", "b2"), result("b"), result("b2")]);
		expect(got).toEqual([
			{ start: 0, end: 1 },
			{ start: 2, end: 4 },
		]);
	});

	// And the converse, which is what makes the span assertion above mean something:
	// results belonging to a LATER assistant cannot be counted as answering an earlier
	// one. A core that scanned forward past a non-result would accept this.
	test("does not let a later cycle's result answer an earlier cycle's call", () => {
		expect(refuse([calls("a"), calls("b"), result("a"), result("b")])).toEqual({
			code: "unanswered-call",
			at: 0,
			id: "a",
		});
	});
});
