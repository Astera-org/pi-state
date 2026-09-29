// Per-key `desc` prose: storage and byte ceiling.

import { expect, test } from "vitest";
import { MAX_DESC_BYTES, parseSchema } from "../src/agentstate/index.js";

test("a schema carries per-key prose", () => {
	const schema = parseSchema(`{"keys":{"files":{"type":"object","desc":"path → why it was touched"}}}`);
	expect(schema.keys.files.desc).toBe("path → why it was touched");
});

// `desc` ships in every request, so it is capped at MAX_DESC_BYTES.
test("prose over the ceiling is refused", () => {
	const long = "x".repeat(MAX_DESC_BYTES + 1);
	let error: unknown;
	try {
		parseSchema(`{"keys":{"objective":{"type":"string","desc":"${long}"}}}`);
	} catch (err) {
		error = err;
	}
	expect(error).toBeDefined();
	expect((error as Error).message).toContain("ceiling");

	expect(() =>
		parseSchema(`{"keys":{"objective":{"type":"string","desc":"${"x".repeat(MAX_DESC_BYTES)}"}}}`),
	).not.toThrow();
});
