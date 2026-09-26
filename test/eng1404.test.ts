// Ported from Astera-org/sproot's internal/agentstate/eng1404_test.go — ENG-1404: a
// declared key can say what it HOLDS via `desc`.
//
// NOT ported: TestAPreENG1404ParserCannotReadTheProseENG1404,
// TestThePinnedDecoderShapeIsFrozenENG1404, and TestDescIsTheOnlyMemberThisReleaseAddedENG1404.
// Those pin sproot's two-release rollback story (a previous server binary's decoder must
// still refuse a schema carrying `desc`, checked by literally running that old decoder).
// This package has no such rollback contract — it is a fresh port, not a deployed
// service with an "old" binary anywhere — so there is nothing here for that story to be
// about. The schema/prose behaviour itself (desc storage, its byte ceiling, and the two
// renderings) is ported below.

import { expect, test } from "vitest";
import { declaredGuide, declaredSummary, described, MAX_DESC_BYTES, parseSchema } from "../src/agentstate/index.js";

test("a schema carries per-key prose", () => {
	const schema = parseSchema(`{"keys":{"files":{"type":"object","desc":"path → why it was touched"}}}`);
	expect(schema.keys.files.desc).toBe("path → why it was touched");
	expect(described(schema)).toBe(true);

	const bare = parseSchema(`{"keys":{"files":{"type":"object"}}}`);
	expect(described(bare)).toBe(false);
});

// The prose ships in the system prompt of every request of a bounded run, so it is a
// clause with a ceiling — not a second place to write a prompt.
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

// What each rendering is FOR: the guide is read by an agent deciding what to write; the
// summary is quoted back by a refusal to an agent that already has the guide.
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
		// A key with no prose still renders, with its type and nothing invented.
		"notes (list[3])",
	]) {
		expect(guide).toContain(want);
	}
	// Sorted, like every other rendering of the key set.
	expect(guide.startsWith("files (object)")).toBe(true);

	const summary = declaredSummary(schema);
	expect(summary).not.toContain("why it was touched");
	expect(summary).toContain("files object");
});
