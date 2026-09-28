// Transcript boundary tests: pairing, refusals, and branch snapshots around a commit.
// `test/testdata/turn-event-ordering/pi-ordering.json` records a pinned pi-state binary.
// At tool_result the closing result is not persisted; at turn_end the cycle is complete.
// The capture script is external to this repository. The fixture can become stale
// when the pinned binary changes. Refusal tests supply StateWindowOptions directly.

import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
	type BoundaryAPI,
	boundaryMessages,
	heldMessages,
	installStateBoundary,
	STATE_BOUNDARY_SOURCE,
	type StateWindowOptions,
	segmentCycles,
	sigmaMessage,
	writeBoundary,
} from "../src/stateboundary/stateboundary.js";
import {
	installStateCommitCache,
	resetStateCommitCache,
	sigmaFromResult,
	stateWindowPreamble,
} from "../src/stateboundary/statewindow.js";

const SIGMA_TOOL = "mcp__sproot__state_commit";

/**
 * A successful state_commit payload as an MCP-backed `state_commit` tool renders it:
 * compact, numeric `version`, the committed document under `doc`, transport beside them.
 */
const commitText = (version: number | string, doc: string) =>
	`{"doc":${doc},"maxStateBytes":4096,"updatedAt":"2026-09-16T00:00:00Z","version":${version}}`;

const cached = (version: number | string, doc: string, toolCallId = "call-1") => ({
	toolName: SIGMA_TOOL,
	toolCallId,
	text: commitText(version, doc),
});

const sigmaOf = (version: number | string, doc: string, id?: string) => sigmaFromResult(cached(version, doc, id))!;

/**
 * The `tool_result` event pi delivers for a given cached Σ, derived from it. The arming
 * predicate reads the event's tool name, `isError` and text as well as its id.
 */
const commitEvent = (c: ReturnType<typeof cached>, over: Record<string, unknown> = {}) => ({
	type: "tool_result",
	toolName: c.toolName,
	toolCallId: c.toolCallId,
	content: [{ type: "text", text: c.text }],
	isError: false,
	...over,
});

const msgEntry = (message: Record<string, unknown>) => ({ type: "message", message });
const user = (text: string) => ({ role: "user", content: text, timestamp: 1 });
const callsMsg = (...ids: string[]) => ({
	role: "assistant",
	content: ids.map((id) => ({ type: "toolCall", id, name: "read", arguments: {} })),
	timestamp: 1,
});
const toolRes = (id: string) => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "read",
	content: [] as unknown[],
	isError: false,
	timestamp: 1,
});

/** A branch: N complete read cycles after one user turn. */
const branchWith = (cycles: number) => {
	const entries = [msgEntry({ role: "system", content: "", timestamp: 1 }), msgEntry(user("go"))];
	for (let i = 0; i < cycles; i++) {
		entries.push(msgEntry(callsMsg(`c${i}`)), msgEntry(toolRes(`c${i}`)));
	}
	return entries;
};

describe("heldMessages", () => {
	test("drops system messages so pi re-emits the CURRENT prompt, role policy included", () => {
		const held = heldMessages(branchWith(1));
		expect(held.map((m) => m.role)).toEqual(["user", "assistant", "toolResult"]);
	});

	test("starts after the newest boundary entry, not at the root", () => {
		const entries = [
			msgEntry(user("ancient")),
			{ type: "transcript", messages: [user("old boundary")] },
			msgEntry(user("since")),
		];
		expect(heldMessages(entries).map((m) => m.content)).toEqual(["since"]);
	});

	test("treats a compaction as a boundary", () => {
		const entries = [msgEntry(user("before")), { type: "compaction", summary: "s" }, msgEntry(user("after"))];
		expect(heldMessages(entries).map((m) => m.content)).toEqual(["after"]);
	});

	test("ignores entries that are not messages", () => {
		const entries = [{ type: "custom", customType: "x" }, msgEntry(user("keep")), null, { type: "message" }];
		expect(heldMessages(entries).map((m) => m.content)).toEqual(["keep"]);
	});
});

describe("segmentCycles over pi's native message shape", () => {
	test("pairs an assistant toolCall block with the contiguous run of toolResult messages", () => {
		const held = heldMessages(branchWith(2));
		const out = segmentCycles(held);
		expect((out as { cycles: unknown }).cycles).toEqual([
			{ start: 1, end: 2 },
			{ start: 3, end: 4 },
		]);
	});

	// One assistant message carries N toolCall blocks, each answered by its own toolResult
	// message bearing the matching id.
	test("pairs a MULTI-CALL cycle: N calls in one message, N results after it", () => {
		const held = [user("go"), callsMsg("a", "b", "c"), toolRes("a"), toolRes("b"), toolRes("c")];
		expect((segmentCycles(held) as { cycles: unknown }).cycles).toEqual([{ start: 1, end: 4 }]);
	});
});

/**
 * Refusal table for the pi-native adapter. `pairing.test.ts` covers the rule through a
 * synthetic shape; this table covers how calls, results and ids are read from pi's messages.
 */
describe("the pi-native adapter refuses every unpairable shape", () => {
	const CASES: Array<{ name: string; want: string; native: Record<string, unknown>[] }> = [
		{
			name: "a result before any call",
			want: "the tool result at message 0 answers no tool call before it",
			native: [toolRes("orphan")],
		},
		{
			name: "a result carrying no id",
			want: "the tool result at message 1 carries no toolCallId",
			native: [callsMsg("a"), { role: "toolResult", toolName: "read", content: [], timestamp: 1 }],
		},
		{
			name: "an id answered twice",
			want: "the tool result at message 2 answers a twice",
			native: [callsMsg("a", "b"), toolRes("a"), toolRes("a")],
		},
		{
			// Three calls, one result.
			name: "a call left unanswered in a multi-call cycle",
			want: "the tool call b at message 0 has no matching tool result",
			native: [callsMsg("a", "b", "c"), toolRes("a")],
		},
		{
			name: "a result answering a call this assistant did not make",
			want: "a tool result after message 0 answers ghost, which that message did not request",
			native: [callsMsg("a"), toolRes("a"), toolRes("ghost")],
		},
		// Zero-result cases must also reject unusable call ids.
		{
			name: "a call with NO results at all",
			want: "the tool call a at message 0 has no matching tool result",
			native: [callsMsg("a")],
		},
		{
			name: "a call with an unusable id and NO results — unverifiable, not call-free",
			want: "the assistant message at 0 carries a tool call with no id, so this cycle cannot be verified",
			native: [{ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: {} }], timestamp: 1 }],
		},
	];

	// Each row asserts the refusal wording.
	test.each(CASES.map((c) => [c.name, c] as const))("refuses: %s", (_name, c) => {
		const got = segmentCycles(c.native);
		expect(
			"reason" in got,
			`stateboundary accepted ${c.name}: ${JSON.stringify(got)} — a cut here sends an unpaired tool call`,
		).toBe(true);
		expect((got as { reason: string }).reason).toBe(c.want);
	});

	test("covers both the with-results and the zero-result shapes", () => {
		const zero = CASES.filter((c) => !c.native.some((m) => (m as { role?: string }).role === "toolResult"));
		const some = CASES.filter((c) => c.native.some((m) => (m as { role?: string }).role === "toolResult"));
		expect(
			zero.length,
			`only ${zero.length} zero-result rows — the shape that hid a real hole`,
		).toBeGreaterThanOrEqual(2);
		expect(some.length, `only ${some.length} rows with results`).toBeGreaterThanOrEqual(3);
	});

	// The adapter must accept a well-formed multi-call cycle.
	test("accepts a well-formed multi-call cycle", () => {
		const got = segmentCycles([user("go"), callsMsg("a", "b"), toolRes("a"), toolRes("b")]);
		expect("cycles" in got, `stateboundary refused a valid cycle: ${JSON.stringify(got)}`).toBe(true);
	});
});

describe("sigmaMessage", () => {
	test("carries the committed document's OWN BYTES, never a reserialization", () => {
		// 9999999999999999 becomes 10000000000000000 through JSON.parse/stringify.
		const doc = '{"cursor":9999999999999999,"ratio":0.30000000000000004441}';
		const m = sigmaMessage(sigmaOf(7, doc), 123);
		expect(m.role).toBe("user");
		expect(m.content).toBe(stateWindowPreamble("7") + doc);
		expect(m.content, "the arbitrary-precision integer was rewritten").toContain("9999999999999999");
		expect(m.content, "the high-precision float was rewritten").toContain("0.30000000000000004441");
	});

	test("quotes the version back as its own bytes, so a CAS token survives a JavaScript number", () => {
		const m = sigmaMessage(sigmaOf("9007199254740993", "{}"), 1);
		expect((m.content as string).includes("version 9007199254740993"), (m.content as string).slice(0, 120)).toBe(
			true,
		);
	});
});

describe("boundaryMessages", () => {
	const doc = '{"step":3}';

	test("at N=0 replaces the transcript with Σ alone", () => {
		const plan = boundaryMessages(sigmaOf(1, doc), 0, heldMessages(branchWith(3)), 1);
		expect(plan.messages.length).toBe(1);
		expect(plan.messages[0]!.role).toBe("user");
		expect(plan.dropped.cycles).toBe(3);
		expect(plan.dropped.messages).toBe(7);
	});

	test("keeps Σ, the newest user turn and the last N complete cycles", () => {
		const held = heldMessages(branchWith(4));
		const plan = boundaryMessages(sigmaOf(1, doc), 2, held, 1);
		expect(plan.messages.map((m) => m.role)).toEqual([
			"user", // Σ
			"user", // O
			"assistant",
			"toolResult", // cycle 3
			"assistant",
			"toolResult", // cycle 4
		]);
		expect(plan.dropped.cycles).toBe(2);
		expect(plan.dropped.roles).toEqual({ assistant: 2, toolResult: 2 });
	});

	test("keeps everything when the branch holds fewer than N cycles", () => {
		const held = heldMessages(branchWith(1));
		const plan = boundaryMessages(sigmaOf(1, doc), 4, held, 1);
		expect(plan.messages.length).toBe(1 + held.length);
		expect(plan.dropped.messages).toBe(0);
		expect(plan.dropped.cycles).toBe(0);
	});

	test("puts Σ first", () => {
		const plan = boundaryMessages(sigmaOf(5, doc), 2, heldMessages(branchWith(1)), 1);
		expect((plan.messages[0]!.content as string).startsWith(stateWindowPreamble("5"))).toBe(true);
	});

	test("keeps the messages as pi's own objects, by reference", () => {
		const held = heldMessages(branchWith(2));
		const plan = boundaryMessages(sigmaOf(1, doc), 1, held, 1);
		for (const m of plan.messages.slice(1)) {
			expect(held.includes(m), "a kept message was rebuilt rather than passed through").toBe(true);
		}
	});

	test("falls back to Σ ALONE when the branch cannot be segmented, and says why", () => {
		const held = [user("go"), toolRes("orphan")];
		const plan = boundaryMessages(sigmaOf(1, doc), 4, held, 1);
		expect(plan.messages.length).toBe(1);
		expect(plan.narrowed).toMatch(/answers no tool call/);
	});

	test("never emits a preamble message — pi rebuilds the system prompt itself", () => {
		const plan = boundaryMessages(sigmaOf(1, doc), 4, heldMessages(branchWith(2)), 1);
		expect(plan.messages.filter((m) => m.role === "system" || m.role === "developer").length).toBe(0);
	});
});

/** A fake pi: records the replacement and the options it was handed. */
function fakePi(overrides: Partial<BoundaryAPI> = {}): BoundaryAPI & {
	handlers: Array<{ event: string; handler: (event: unknown, ctx: unknown) => unknown }>;
	calls: Array<{ messages: unknown[]; options: unknown }>;
	entries: Array<{ customType: string; data: unknown }>;
} {
	const handlers: Array<{ event: string; handler: (event: unknown, ctx: unknown) => unknown }> = [];
	const calls: Array<{ messages: unknown[]; options: unknown }> = [];
	const entries: Array<{ customType: string; data: unknown }> = [];
	return {
		handlers,
		calls,
		entries,
		on: (event, handler) => handlers.push({ event, handler }),
		replaceTranscript: (messages, options) => calls.push({ messages, options }),
		appendEntry: (customType, data) => entries.push({ customType, data }),
		...overrides,
	};
}

const ctxWith = (branch: unknown[]) => ({ sessionManager: { getBranch: () => branch } });

/**
 * Recording of pi's behavior: the event delivered and the branch `getBranch()` held at each
 * event of a real `state_commit` cycle, captured from a pinned `pi-state` binary. The replay
 * below drives this module against it. Planning on `tool_result` (last cycle unpaired) would
 * collapse every boundary to Σ alone.
 */
const RECORDING = JSON.parse(
	readFileSync(new URL("./testdata/turn-event-ordering/pi-ordering.json", import.meta.url), "utf8"),
);

/** One recorded arm's snapshots, with the entry pool resolved back into whole branches. */
function recordedTurn(arm: string) {
	const recorded = RECORDING.ordering?.[arm];
	expect(recorded, `the recording holds no ${arm} arm`).toBeTruthy();
	return recorded.snapshots.map((snapshot: { event: string; payload: unknown; branch: string[] }) => ({
		event: snapshot.event,
		payload: snapshot.payload,
		branch: snapshot.branch.map((id) => {
			const entry = recorded.entries[id];
			expect(
				entry,
				`${arm}'s ${snapshot.event} snapshot names ${id}, which the entry pool does not hold`,
			).toBeTruthy();
			return entry;
		}),
	}));
}

/**
 * Replay a recorded turn through the real Σ cache and the boundary writer, handing each
 * handler the recorded event and the branch held at that time. The arming predicate reads
 * the recorded `tool_result`'s tool name, `isError` and bytes.
 */
function replayRecordedTurn(arm: string, options: StateWindowOptions, record?: (data: unknown) => void) {
	const pi = fakePi();
	let branch: unknown[] = [];
	installStateCommitCache(pi);
	installStateBoundary(pi, options, record, { branch: () => branch, now: () => 1 });
	const afterEach: string[] = [];
	for (const snapshot of recordedTurn(arm)) {
		branch = snapshot.branch;
		for (const h of pi.handlers) if (h.event === snapshot.event) h.handler(snapshot.payload, null);
		afterEach.push(`${snapshot.event}:${pi.calls.length}`);
	}
	return { pi, afterEach };
}

describe("writeBoundary", () => {
	const cfg = { cycles: 2 };
	const tally = { requests: 1, rewrites: 0, refusals: 0 };
	const deps = (branch: unknown[] | null, sigma: ReturnType<typeof cached> | null) => ({
		branch: () => branch,
		sigma: () => sigma,
		now: () => 42,
	});

	test("writes the boundary as a steer and records held-versus-sent", () => {
		const pi = fakePi();
		const branch = branchWith(4);
		const rec = writeBoundary(pi, cfg, tally, deps(branch, cached(9, '{"a":1}')), null);
		expect(pi.calls.length).toBe(1);
		expect((pi.calls[0]!.options as Record<string, unknown>).deliverAs).toBe("steer");
		expect((pi.calls[0]!.options as Record<string, unknown>).source).toBe(STATE_BOUNDARY_SOURCE);
		expect("state" in rec && rec.state).toBe("rehomed");
		expect("stateVersion" in rec && rec.stateVersion).toBe(9);
		expect("cycles" in rec && rec.cycles).toBe(2);
		expect("messagesBefore" in rec && rec.messagesBefore).toBe(9);
		expect("messagesAfter" in rec && rec.messagesAfter).toBe(6);
		expect("droppedCycles" in rec && rec.droppedCycles).toBe(2);
		// bytesBefore is the held branch, bytesAfter the replacement.
		expect("bytesBefore" in rec && "bytesAfter" in rec && rec.bytesBefore > rec.bytesAfter).toBe(true);
	});

	test("refuses without writing when there is no proven commit to re-home", () => {
		const pi = fakePi();
		const rec = writeBoundary(pi, cfg, tally, deps(branchWith(1), null), null);
		expect(pi.calls.length).toBe(0);
		expect("failed" in rec && rec.failed).toBe(true);
		expect("reason" in rec && rec.reason).toMatch(/no proven state_commit result/);
	});

	test("refuses on a pi with no replaceTranscript", () => {
		const pi = fakePi({ replaceTranscript: undefined });
		const rec = writeBoundary(pi, cfg, tally, deps(branchWith(1), cached(1, "{}")), null);
		expect("failed" in rec && rec.failed).toBe(true);
		expect("reason" in rec && rec.reason).toMatch(/no replaceTranscript/);
	});

	test("refuses when the branch cannot be read", () => {
		const pi = fakePi();
		const rec = writeBoundary(pi, cfg, tally, { branch: () => null, sigma: () => cached(1, "{}") }, null);
		expect(pi.calls.length).toBe(0);
		expect("reason" in rec && rec.reason).toMatch(/no readable session branch/);
	});

	test("returns a refusal instead of throwing when replaceTranscript throws", () => {
		const pi = fakePi({
			replaceTranscript: () => {
				throw new Error("boom");
			},
		});
		const rec = writeBoundary(pi, cfg, tally, deps(branchWith(1), cached(1, "{}")), null);
		expect("failed" in rec && rec.failed).toBe(true);
		expect("reason" in rec && rec.reason).toMatch(/boom/);
	});

	test("refuses a payload whose doc does not slice out", () => {
		const pi = fakePi();
		const broken = { toolName: SIGMA_TOOL, toolCallId: "c", text: '{"doc":"not an object","version":1}' };
		const rec = writeBoundary(pi, cfg, tally, deps(branchWith(1), broken), null);
		expect(pi.calls.length).toBe(0);
		expect("reason" in rec && rec.reason).toMatch(/no proven state_commit result/);
	});

	test("reads the real session manager when no branch dep is given", () => {
		const pi = fakePi();
		const rec = writeBoundary(pi, cfg, tally, { sigma: () => cached(2, "{}"), now: () => 1 }, ctxWith(branchWith(1)));
		expect(pi.calls.length).toBe(1);
		expect("stateVersion" in rec && rec.stateVersion).toBe(2);
	});
});

describe("installStateBoundary", () => {
	const options: StateWindowOptions = { enabled: true, cycles: "1" };
	// A commit takes both events: `tool_result` arms it (where pi's `isError` is available) and
	// `turn_end` plans it (where the finished cycle is on the branch). The helper drives both.
	const fire = (pi: ReturnType<typeof fakePi>, event: unknown, ctx: unknown) => {
		for (const h of pi.handlers) if (h.event === "tool_result") h.handler(event, ctx);
		for (const h of pi.handlers) if (h.event === "turn_end") h.handler({}, ctx);
	};

	/**
	 * One case per refusal, each asserting which condition was named. `installed` is asserted
	 * alongside the log.
	 */
	const refusals: Array<{
		what: string;
		options: StateWindowOptions;
		condition: string;
		fault: "yes" | "no";
		says: string[];
	}> = [
		{
			what: "the mode is not enabled — nothing configured this session",
			options: { enabled: false },
			condition: "mode",
			fault: "yes",
			says: ["enabled", "false"],
		},
		{
			what: "N will not parse",
			options: { enabled: true, cycles: "4oops" },
			condition: "cycles",
			fault: "yes",
			says: ["cycles", '"4oops"', "0..20"],
		},
		{
			what: "the kill switch carries a value this module cannot read",
			options: { enabled: true, killSwitch: "maybe" },
			condition: "kill-switch",
			fault: "yes",
			says: ["killSwitch", '"maybe"', "1/true/yes/on"],
		},
		{
			// An explicit kill switch has fault=no.
			what: "the operator set the kill switch off",
			options: { enabled: true, killSwitch: "0" },
			condition: "kill-switch",
			fault: "no",
			says: ["killSwitch", '"0"', "kill switch"],
		},
	];

	test.each(refusals.map((c) => [c.what, c] as const))("says which condition refused when %s", (_what, c) => {
		const pi = fakePi();
		const logs: string[] = [];
		installStateBoundary(pi, c.options, undefined, { log: (m) => logs.push(m) });
		expect(pi.handlers.length, "the mode was installed anyway").toBe(0);
		expect(logs.length, `logged ${logs.length} lines: ${JSON.stringify(logs)}`).toBe(1);
		expect(logs[0]).toMatch(new RegExp(`^\\[${STATE_BOUNDARY_SOURCE}\\] `));
		expect(
			logs[0]!.includes(`[condition=${c.condition} fault=${c.fault}]`),
			`the report does not name condition=${c.condition} fault=${c.fault}: ${logs[0]}`,
		).toBe(true);
		for (const fragment of c.says) {
			expect(logs[0]!.includes(fragment), `the report never mentions ${fragment}: ${logs[0]}`).toBe(true);
		}
	});

	test("logs nothing when it installs", () => {
		const pi = fakePi();
		const logs: string[] = [];
		installStateBoundary(pi, options, undefined, { log: (m) => logs.push(m) });
		expect(logs).toEqual([]);
		expect(
			pi.handlers.some((h) => h.event === "turn_end"),
			"no turn_end handler was installed",
		).toBe(true);
	});

	// Fails if a condition is added to `stateWindowSetting` without an install-time report.
	test("no configuration turns the mode off without saying which condition did it", () => {
		const candidates: StateWindowOptions[] = [
			{ enabled: false },
			{ enabled: true, cycles: "-3" },
			{ enabled: true, cycles: "21" },
			{ enabled: true, cycles: " 4" },
			{ enabled: true, killSwitch: "off" },
			{ enabled: true, killSwitch: "2" },
			{ enabled: false, killSwitch: "1" },
		];
		for (const candidate of candidates) {
			const pi = fakePi();
			const logs: string[] = [];
			installStateBoundary(pi, candidate, undefined, { log: (m) => logs.push(m) });
			expect(pi.handlers.length, JSON.stringify(candidate)).toBe(0);
			expect(logs.length, `${JSON.stringify(candidate)} refused silently`).toBe(1);
			expect(logs[0]).toMatch(/\[condition=(kill-switch|mode|cycles) fault=(yes|no)\]: \S/);
		}
	});

	// The default diagnostic sink is console.error (stderr).
	test("reports on console.error when the caller supplies no log sink", () => {
		const pi = fakePi();
		const lines: string[] = [];
		const original = console.error;
		console.error = (...args: unknown[]) => lines.push(args.join(" "));
		try {
			installStateBoundary(pi, { enabled: false });
		} finally {
			console.error = original;
		}
		expect(lines.length, `console.error saw ${lines.length} lines`).toBe(1);
		expect(lines[0]).toContain("[condition=mode fault=yes]");
	});

	/**
	 * Replays event ordering: an unpaired branch at tool_result, a complete one at turn_end.
	 * Checks boundary counts after each event and retained roles to detect early writes
	 * and unintended fallback to Σ alone.
	 */
	test("plans on turn_end, not tool_result", () => {
		resetStateCommitCache();
		const { pi, afterEach } = replayRecordedTurn("single-cycle", options);
		expect(
			afterEach,
			"a boundary was planned where pi has not yet persisted the closing tool result, or a turn that accepted nothing wrote one",
		).toEqual(["tool_result:0", "turn_end:1", "turn_end:1"]);
		expect(
			pi.calls[0]!.messages.map((m) => (m as { role: string }).role),
			"retention collapsed: the boundary carries Σ without the cycle it was supposed to keep",
		).toEqual(["user", "user", "assistant", "toolResult"]);
	});

	/** At `tool_result` the closing result is not on the branch; at `turn_end` it is. */
	test("records a branch whose closing tool result is absent at tool_result and present at turn_end", () => {
		const [atToolResult, atTurnEnd] = recordedTurn("single-cycle");
		expect(heldMessages(atToolResult.branch).map((m) => m.role)).toEqual(["user", "assistant"]);
		expect(heldMessages(atTurnEnd.branch).map((m) => m.role)).toEqual(["user", "assistant", "toolResult"]);
		expect(
			"reason" in segmentCycles(heldMessages(atToolResult.branch)),
			"the recorded tool_result branch pairs — the whole reason the boundary is planned on turn_end is that it does not",
		).toBe(true);
		expect(
			"cycles" in segmentCycles(heldMessages(atTurnEnd.branch)),
			"the recorded turn_end branch does not pair",
		).toBe(true);
	});

	/**
	 * Refused commits and unrelated results reusing an accepted call id must not arm
	 * a boundary. The real cache is registered first and retains the previous Σ on refusal.
	 */
	test("a REUSED tool_call_id does not arm the boundary unless the event is itself an accepted commit", () => {
		const pi = fakePi();
		const records: unknown[] = [];
		resetStateCommitCache();
		installStateCommitCache(pi);
		installStateBoundary(pi, options, (d) => records.push(d), { branch: () => branchWith(1), now: () => 1 });

		const result = (over: Record<string, unknown>) => ({
			type: "tool_result",
			toolName: SIGMA_TOOL,
			toolCallId: "reused",
			content: [{ type: "text", text: commitText(1, '{"step":1}') }],
			isError: false,
			...over,
		});

		fire(pi, result({}), null);
		expect(pi.calls.length, "the accepted commit did not write its boundary").toBe(1);

		// (1) A refused commit reusing the id; the cache keeps Σ v1 standing.
		fire(pi, result({ isError: true, content: [{ type: "text", text: "the state moved under you" }] }), null);
		expect(
			pi.calls.length,
			"a REFUSED commit reusing the id bounded the transcript on a turn that committed nothing",
		).toBe(1);

		// (2) An unrelated successful tool reusing the id; only the tool name rejects it.
		fire(pi, result({ toolName: "read", content: [{ type: "text", text: "file contents" }] }), null);
		expect(pi.calls.length, "an unrelated successful tool reusing the id armed the boundary").toBe(1);

		// (3) A genuine second commit that also reuses the id still arms, and carries the new version.
		fire(pi, result({ content: [{ type: "text", text: commitText(2, '{"step":2}') }] }), null);
		expect(pi.calls.length, "a real second commit reusing the id was refused a boundary").toBe(2);
		expect(
			records.map((r) => (r as { stateVersion: number }).stateVersion),
			"the boundaries do not carry one version each — a retained Σ was re-recorded as a new commit",
		).toEqual([1, 2]);
	});

	/**
	 * The boundary must reject a result whose text differs from the cached Σ,
	 * including when handlers run in the wrong order.
	 */
	test("refuses rather than arming against a stale Σ when the cache handler runs AFTER it", () => {
		const pi = fakePi();
		resetStateCommitCache();
		installStateBoundary(pi, options, undefined, { branch: () => branchWith(1), now: () => 1 });
		installStateCommitCache(pi); // inverted: the cache observes only after the boundary has looked

		const first = cached(1, '{"step":1}', "reused");
		fire(pi, commitEvent(first), null);
		// Nothing is cached when the boundary looks, so the first commit arms nothing, but it seeds the cache.
		expect(pi.calls.length).toBe(0);

		// A second commit with the same id and new bytes; the standing Σ is still v1 when the boundary reads it.
		fire(pi, commitEvent(cached(2, '{"step":2}', "reused")), null);
		expect(
			pi.calls.length,
			"the boundary armed against the Σ standing BEFORE this commit — it would bound to a superseded document",
		).toBe(0);
	});

	// Two `state_commit` calls in one turn (parallel tool calls) produce two `tool_result`
	// events and one `turn_end`, and collapse to one boundary carrying the newest Σ.
	test("writes one boundary per TURN that accepted a commit, carrying the newest Σ", () => {
		const records: unknown[] = [];
		resetStateCommitCache();
		const { pi, afterEach } = replayRecordedTurn("parallel-cycle", options, (d) => records.push(d));
		expect(afterEach, "two commits in one recorded turn did not collapse to exactly one boundary").toEqual([
			"tool_result:0",
			"tool_result:0",
			"turn_end:1",
			"turn_end:1",
		]);
		expect(
			(records[0] as { stateVersion: number }).stateVersion,
			"the boundary carries the older Σ, not the newest",
		).toBe(2);
		expect(
			pi.calls[0]!.messages.map((m) => (m as { role: string }).role),
			"the retained multi-call cycle lost a result",
		).toEqual(["user", "user", "assistant", "toolResult", "toolResult"]);
	});

	test("writes nothing for a turn that accepted no commit, and leaves every other tool result alone", () => {
		const pi = fakePi();
		const records: unknown[] = [];
		const sigma = cached(3, '{"s":1}', "call-sigma");
		installStateBoundary(pi, options, (d) => records.push(d), {
			branch: () => branchWith(2),
			sigma: () => sigma,
			now: () => 1,
		});
		fire(
			pi,
			commitEvent(sigma, { toolCallId: "call-other", toolName: "read", content: [{ type: "text", text: "x" }] }),
			null,
		);
		expect(pi.calls.length, "a non-commit tool result moved the boundary").toBe(0);
		expect(records.length).toBe(0);

		fire(pi, commitEvent(sigma), null);
		expect(pi.calls.length).toBe(1);
		expect(records.length).toBe(1);
		expect((records[0] as { state: string }).state).toBe("rehomed");
		expect((records[0] as { stateVersion: number }).stateVersion).toBe(3);
	});

	test("carries a running tally INCLUDING the record being written", () => {
		const pi = fakePi();
		const records: unknown[] = [];
		const sigma = cached(1, "{}", "c");
		installStateBoundary(pi, options, (d) => records.push(d), {
			branch: () => branchWith(1),
			sigma: () => sigma,
			now: () => 1,
		});
		fire(pi, commitEvent(sigma), null);
		fire(pi, commitEvent(sigma), null);
		expect(
			records.map((r) => [
				(r as { requests: number }).requests,
				(r as { rewrites: number }).rewrites,
				(r as { refusals: number }).refusals,
			]),
		).toEqual([
			[1, 1, 0],
			[2, 2, 0],
		]);
	});

	test("records a refusal", () => {
		const pi = fakePi();
		const records: unknown[] = [];
		const logged: string[] = [];
		const unwritable = cached(1, "{}", "c");
		installStateBoundary(pi, options, (d) => records.push(d), {
			branch: () => null,
			sigma: () => unwritable,
			log: (m) => logged.push(m),
		});
		fire(pi, commitEvent(unwritable), null);
		expect(records.length).toBe(1);
		expect((records[0] as { failed: boolean }).failed).toBe(true);
		expect((records[0] as { refusals: number }).refusals).toBe(1);
		expect(logged.length).toBe(1);
	});

	test("returns undefined from BOTH handlers so pi records the tool result unmodified", () => {
		const pi = fakePi();
		const only = cached(1, "{}", "c");
		installStateBoundary(pi, options, undefined, {
			branch: () => branchWith(1),
			sigma: () => only,
			now: () => 1,
		});
		for (const h of pi.handlers) {
			expect(h.handler(commitEvent(only), null)).toBeUndefined();
		}
	});
});

describe("the byte count is counted, never materialized", () => {
	// `bytesBefore` and `bytesAfter` are the held branch and the replacement.
	const multibyte = (n: number) => "héllo 日本 \u{1F600} ".repeat(n);
	const cfg = { cycles: 2 };
	const tally = { requests: 1, rewrites: 0, refusals: 0 };
	const branchSaying = (text: string) => [msgEntry(user(text)), ...branchWith(3).slice(1)];

	test("agrees with TextEncoder on every shape, unpaired surrogates included", () => {
		// `Buffer.byteLength` must equal `TextEncoder#encode().length`. An unpaired surrogate is
		// not encodable; both count it as U+FFFD's three bytes.
		for (const text of [
			"",
			"ascii only",
			multibyte(3),
			"a\uD800b",
			"a\uDC00b",
			"abc\uD83D",
			"\uDC00\uD800",
			"a\u{1F600}b\uD800c日",
		]) {
			const branch = branchSaying(text);
			const rec = writeBoundary(
				fakePi(),
				cfg,
				tally,
				{ branch: () => branch, sigma: () => cached(9, '{"a":1}'), now: () => 42 },
				null,
			);
			expect("failed" in rec ? rec.reason : undefined, JSON.stringify(text)).toBeUndefined();
			expect(
				"bytesBefore" in rec ? rec.bytesBefore : undefined,
				`bytesBefore disagrees with TextEncoder for ${JSON.stringify(text)}`,
			).toBe(new TextEncoder().encode(JSON.stringify(heldMessages(branch))).length);
		}
	});

	test("never builds a byte copy of the held transcript", () => {
		// Watches only TextEncoder#encode and Buffer.from; it cannot detect a copy made by any
		// other route.
		const branch = branchSaying(multibyte(2000));
		const held = JSON.stringify(heldMessages(branch));
		const seen: number[] = [];
		const realEncode = TextEncoder.prototype.encode;
		const realFrom = Buffer.from;
		TextEncoder.prototype.encode = function (this: InstanceType<typeof TextEncoder>, input?: string) {
			seen.push(String(input ?? "").length);
			return realEncode.call(this, input);
		};
		Buffer.from = ((...args: any[]) => {
			if (typeof args[0] === "string") seen.push(args[0].length);
			return (realFrom as (...a: any[]) => Buffer)(...args);
		}) as any;
		let rec: ReturnType<typeof writeBoundary>;
		try {
			rec = writeBoundary(
				fakePi(),
				cfg,
				tally,
				{ branch: () => branch, sigma: () => cached(9, '{"a":1}'), now: () => 42 },
				null,
			);
			expect("failed" in rec ? rec.reason : undefined).toBeUndefined();
		} finally {
			TextEncoder.prototype.encode = realEncode;
			Buffer.from = realFrom;
		}
		const biggest = seen.length ? Math.max(...seen) : 0;
		expect(biggest, `an allocation of ${biggest} chars was made over a ${held.length}-char transcript`).toBeLessThan(
			held.length,
		);
	});
});
