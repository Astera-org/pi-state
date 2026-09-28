// readCarriage: classifies declared keys as carried, not carried, or empty, and reports
// undeclared keys.

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

		// carried and notCarried together partition the declared keys.
		const seen = [...got.carried, ...got.notCarried].sort();
		expect(seen).toEqual(declaredKeys(schema));
		for (const key of got.empty) {
			expect(got.carried).toContain(key);
		}
	});
});

// With no declared keys, carriesNothing is false.
test("a schema that declares no keys is not an empty Sigma", () => {
	const got = readCarriage(`{}`, { keys: {} });
	expect(carriesNothing(got)).toBe(false);
	expect(got.declared).toHaveLength(0);
	expect(got.notCarried).toHaveLength(0);
});

// A key present in the document but not declared by the schema is reported in `undeclared`.
// merge refuses undeclared keys, so this arises only when a schema edit drops a stored key.
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
