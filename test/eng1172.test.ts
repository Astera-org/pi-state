// Ported 1:1 from Astera-org/sproot's internal/agentstate/eng1172_test.go — ENG-1172:
// the content reading, against its own two failure modes (calling an absence a finding,
// or a finding an absence).

import { describe, expect, test } from "vitest";
import { carriesNothing, declaredKeys, readCarriage, type Schema } from "../src/agentstate/index.js";

const schema: Schema = {
	keys: {
		objective: { type: "string" },
		next: { type: "string" },
		files: { type: "object" },
		blocked: { type: "string" },
		steps: { type: "number" },
		done: { type: "bool" },
	},
};

describe("carriage reads what the schema asked for", () => {
	test.each([
		{
			name: "the empty document carries none of them, which is THE signature",
			doc: `{}`,
			carried: [] as string[],
			notCarried: ["blocked", "done", "files", "next", "objective", "steps"],
			empty: [] as string[],
			nothing: true,
		},
		{
			name: "a document holding every declared key carries every one",
			doc:
				`{"blocked":"waiting on CI","done":true,"files":{"a.go":"read"},"next":"run the tests",` +
				`"objective":"fix the flake","steps":4}`,
			carried: ["blocked", "done", "files", "next", "objective", "steps"],
			notCarried: [] as string[],
			empty: [] as string[],
			nothing: false,
		},
		{
			name: "an EMPTY VALUE is carried and is named as empty",
			doc: `{"blocked":"","files":{},"next":"   ","objective":"fix the flake"}`,
			carried: ["blocked", "files", "next", "objective"],
			notCarried: ["done", "steps"],
			empty: ["blocked", "files", "next"],
			nothing: false,
		},
		{
			name: "a zero number and a false boolean are VALUES the agent chose, not emptiness",
			doc: `{"done":false,"steps":0}`,
			carried: ["done", "steps"],
			notCarried: ["blocked", "files", "next", "objective"],
			empty: [] as string[],
			nothing: false,
		},
		{
			name: "a stored null is not carried — null is how the merge DELETES",
			doc: `{"blocked":null,"objective":"fix the flake"}`,
			carried: ["objective"],
			notCarried: ["blocked", "done", "files", "next", "steps"],
			empty: [] as string[],
			nothing: false,
		},
	])("$name", ({ doc, carried, notCarried, empty, nothing }) => {
		const got = readCarriage(doc, schema);
		expect(got.carried).toEqual(carried);
		expect(got.notCarried).toEqual(notCarried);
		expect(got.empty).toEqual(empty);
		expect(carriesNothing(got)).toBe(nothing);

		// The partition, checked by identity: equal totals are not a partition.
		const seen = [...got.carried, ...got.notCarried].sort();
		expect(seen).toEqual(declaredKeys(schema));
		for (const key of got.empty) {
			expect(got.carried).toContain(key);
		}
	});
});

// A schema that declares NO keys makes "carried none of them" vacuous.
test("a schema that declares no keys is not an empty Sigma", () => {
	const got = readCarriage(`{}`, { keys: {} });
	expect(carriesNothing(got)).toBe(false);
	expect(got.declared).toHaveLength(0);
	expect(got.notCarried).toHaveLength(0);
});

// A key the DOCUMENT holds and the SCHEMA does not declare is near-unreachable — merge
// refuses an undeclared key — and is read out for exactly that reason.
test("a stranded key is named", () => {
	const got = readCarriage(`{"gone":"left behind by a schema edit","next":"carry on"}`, {
		keys: { next: { type: "string" } },
	});
	expect(got.undeclared).toEqual(["gone"]);
	expect(got.carried).toEqual(["next"]);
});

test("carriage refuses a document that does not parse", () => {
	expect(() => readCarriage(`{"next":`, { keys: { next: { type: "string" } } })).toThrow();
});
