// Per-key `desc` prose: storage, byte ceiling, and the guide and summary renderings.

import { expect, test } from "vitest";
import { declaredGuide, declaredSummary, described, MAX_DESC_BYTES, parseSchema } from "../src/agentstate/index.js";

test("a schema carries per-key prose", () => {
	const schema = parseSchema(`{"keys":{"files":{"type":"object","desc":"path → why it was touched"}}}`);
	expect(schema.keys.files.desc).toBe("path → why it was touched");
	expect(described(schema)).toBe(true);

	const bare = parseSchema(`{"keys":{"files":{"type":"object"}}}`);
	expect(described(bare)).toBe(false);
});

// `desc` is included in the system prompt, so it is capped at MAX_DESC_BYTES.
test("prose over the ceiling is refused", () => {
	const long = "x".repeat(MAX_DESC_BYTES + 1);
	let error: unknown;
	try {
		parseSchema(`{"keys":{"objective":{"type":"string","desc":"${long}"}}}`);
	} catch (err) {
		error = err;
	}
	expect(error).toBeDefined();
	expect((error as Error).message).toContain("system prompt");

	expect(() =>
		parseSchema(`{"keys":{"objective":{"type":"string","desc":"${"x".repeat(MAX_DESC_BYTES)}"}}}`),
	).not.toThrow();
});

// The guide includes each key's `desc`; the summary lists keys and types only.
test("the guide carries the prose and the summary stays terse", () => {
	const schema = parseSchema(
		`{"keys":{` +
			`"objective":{"type":"string","desc":"what the change must achieve"},` +
			`"files":{"type":"object","desc":"path → why it was touched"},` +
			`"notes":{"type":"list","maxItems":3}}}`,
	);

	const guide = declaredGuide(schema);
	for (const want of [
		"files (object) — path → why it was touched",
		"objective (string) — what the change must achieve",
		// A key without `desc` renders its type only.
		"notes (list[3])",
	]) {
		expect(guide).toContain(want);
	}
	// Keys are sorted.
	expect(guide.startsWith("files (object)")).toBe(true);

	const summary = declaredSummary(schema);
	expect(summary).not.toContain("why it was touched");
	expect(summary).toContain("files object");
});
