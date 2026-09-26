// Ported from Astera-org/sproot's agent/pi-extensions/sproot-mcp/stateboundary.test.mjs,
// translated from node:test/node:assert to this repo's vitest convention.
//
// ADAPTED, not copied verbatim:
//   - `installStateBoundary` takes a `StateWindowOptions` object rather than an env-var
//     record, so the refusal table below builds options directly instead of
//     SPROOT_STATE_LOOP/SPROOT_PI_STATE_WINDOW/SPROOT_PI_STATE_WINDOW_CYCLES strings; one
//     row (a misspelled mode variable) is dropped because it tested exact-string env
//     parsing that moved out of the core entirely.
//   - Three tests replayed a recording captured from a pinned `pi-state` binary
//     (`scripts/testdata/eng1269/pi-ordering.json` in sproot, via
//     `scripts/eng1269_pi_ordering_probe.mjs`) to prove this module's assumption about
//     what pi's own branch looks like at `tool_result` versus `turn_end`. Neither the
//     recording nor the probe exists in this repo — capturing one needs the pinned
//     `pi-state` fork sproot builds, which is out of scope here — so the two invariants
//     that recording proved (plan on `turn_end`, not `tool_result`; two commits in one
//     turn collapse to one boundary) are re-proven below with hand-built fixtures
//     instead. That is a weaker guarantee than a measurement against the real binary, and
//     is recorded as a gap for whoever builds the standalone entrypoint against a pinned
//     `pi-state` — that work has the binary to re-capture against.
//   - The "bytes probe" describe block (`scripts/eng1248_pi_state_bytes_probe.mjs`) is
//     dropped for the same reason: it belongs to sproot's own build probe, not this
//     module.
//   - `TOOL_PREFIX` came from sproot's `index.ts` entrypoint, which this repo does not
//     build; the one test that used it now spells the MCP tool name literally.

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
 * A successful state_commit payload as sproot's `internal/mcp` stateCommit renders it:
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
 * The `tool_result` event pi delivers for a given cached Σ, DERIVED from it so the two
 * cannot drift: the arming predicate reads the event's tool name, its `isError` and its
 * text — not just its id — so a hand-written `{ toolCallId }` is not a `tool_result` any
 * production pi would deliver.
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

	test("treats a compaction as a boundary too — pi does, and a walk that did not would hand back messages pi no longer sends", () => {
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

	// The shape this function exists for. ONE assistant message carries N toolCall blocks,
	// each answered by its OWN toolResult message: three parallel `read` calls produce one
	// assistant message with three toolCall blocks and three separate toolResult messages
	// bearing the matching ids.
	test("pairs a MULTI-CALL cycle: N calls in one message, N results after it", () => {
		const held = [user("go"), callsMsg("a", "b", "c"), toolRes("a"), toolRes("b"), toolRes("c")];
		expect((segmentCycles(held) as { cycles: unknown }).cycles).toEqual([{ start: 1, end: 4 }]);
	});
});

/**
 * THE PI-NATIVE ADAPTER'S REFUSAL TABLE. `pairing.test.ts` drives the shared rule through
 * a synthetic shape and so cannot see an adapter that misreads what a call, a result or an
 * id looks like in pi's own messages — this table is what catches that.
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
			// THE ONE A LENGTH-BASED CHECK ACCEPTED: three calls, one result.
			name: "a call left unanswered in a multi-call cycle",
			want: "the tool call b at message 0 has no matching tool result",
			native: [callsMsg("a", "b", "c"), toolRes("a")],
		},
		{
			name: "a result answering a call this assistant did not make",
			want: "a tool result after message 0 answers ghost, which that message did not request",
			native: [callsMsg("a"), toolRes("a"), toolRes("ghost")],
		},
		// EVERY ROW ABOVE HAS AT LEAST ONE RESULT, and that shared shape is what let a real
		// hole through: with zero results the loops that catch the others have nothing to
		// iterate.
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

	// Each row asserts the refusal's WORDING, not merely that something was refused. An
	// adapter that misreads one field still refuses most malformed shapes — it just
	// refuses them for the wrong reason, pointing a reader at the wrong message.
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

	// The floor under the table: the adapter must ACCEPT the well-formed multi-call cycle,
	// or "refuses everything" would satisfy every row above.
	test("accepts a well-formed multi-call cycle", () => {
		const got = segmentCycles([user("go"), callsMsg("a", "b"), toolRes("a"), toolRes("b")]);
		expect("cycles" in got, `stateboundary refused a valid cycle: ${JSON.stringify(got)}`).toBe(true);
	});
});

describe("sigmaMessage", () => {
	test("carries the committed document's OWN BYTES, never a reserialization", () => {
		// 9999999999999999 becomes 10000000000000000 through JSON.parse/stringify, and
		// sproot's go-core keeps json.Number — so the raw bytes are the only faithful
		// carrier.
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

	test("puts Σ FIRST — a user message before the turn it precedes is the ordering every provider accepts", () => {
		const plan = boundaryMessages(sigmaOf(5, doc), 2, heldMessages(branchWith(1)), 1);
		expect((plan.messages[0]!.content as string).startsWith(stateWindowPreamble("5"))).toBe(true);
	});

	test("keeps the messages pi's own objects, by reference — that IS the pairing guarantee", () => {
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
		// HELD versus SENT.
		expect("bytesBefore" in rec && "bytesAfter" in rec && rec.bytesBefore > rec.bytesAfter).toBe(true);
	});

	test("refuses without writing when there is no proven commit to re-home", () => {
		const pi = fakePi();
		const rec = writeBoundary(pi, cfg, tally, deps(branchWith(1), null), null);
		expect(pi.calls.length).toBe(0);
		expect("failed" in rec && rec.failed).toBe(true);
		expect("reason" in rec && rec.reason).toMatch(/no proven state_commit result/);
	});

	test("refuses on a pi with no replaceTranscript rather than silently doing nothing", () => {
		const pi = fakePi({ replaceTranscript: undefined });
		const rec = writeBoundary(pi, cfg, tally, deps(branchWith(1), cached(1, "{}")), null);
		expect("failed" in rec && rec.failed).toBe(true);
		expect("reason" in rec && rec.reason).toMatch(/no replaceTranscript/);
	});

	test("refuses when the branch cannot be read — what was dropped would otherwise be unaccounted for", () => {
		const pi = fakePi();
		const rec = writeBoundary(pi, cfg, tally, { branch: () => null, sigma: () => cached(1, "{}") }, null);
		expect(pi.calls.length).toBe(0);
		expect("reason" in rec && rec.reason).toMatch(/no readable session branch/);
	});

	test("refuses rather than throws when replaceTranscript throws — a refusal must never cost the turn", () => {
		const pi = fakePi({
			replaceTranscript: () => {
				throw new Error("boom");
			},
		});
		const rec = writeBoundary(pi, cfg, tally, deps(branchWith(1), cached(1, "{}")), null);
		expect("failed" in rec && rec.failed).toBe(true);
		expect("reason" in rec && rec.reason).toMatch(/boom/);
	});

	test("refuses a payload whose doc does not slice out — a contract drift is not a Σ to re-home", () => {
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
	// A commit now takes BOTH events: `tool_result` arms it (that is where pi's `isError`
	// lives) and `turn_end` plans it (that is where the finished cycle is on the branch).
	// The helper drives the pair, so every test below exercises the real sequence rather
	// than half of it.
	const fire = (pi: ReturnType<typeof fakePi>, event: unknown, ctx: unknown) => {
		for (const h of pi.handlers) if (h.event === "tool_result") h.handler(event, ctx);
		for (const h of pi.handlers) if (h.event === "turn_end") h.handler({}, ctx);
	};

	/**
	 * Each refusal gets its own case, and each asserts WHICH condition was named: one test
	 * over one condition is what let several of them share a single silent `return` for
	 * separate defects. `installed` is asserted beside the log every time, because a module
	 * that logged and installed anyway would satisfy the message alone.
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
			// THE ASYMMETRY. `resolveStateWindow` is permissive toward off and strict toward
			// on, so an operator's own `0` is configuration and must not read as a defect —
			// a benchmark's negative control arm sets exactly this, every run, on purpose.
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

	test("says NOTHING when it installs — a line on every start would train an operator to ignore it", () => {
		const pi = fakePi();
		const logs: string[] = [];
		installStateBoundary(pi, options, undefined, { log: (m) => logs.push(m) });
		expect(logs).toEqual([]);
		expect(
			pi.handlers.some((h) => h.event === "turn_end"),
			"no turn_end handler was installed",
		).toBe(true);
	});

	// THE ANTI-ROT HALF, and the reason the cases above are not the whole test. They pin the
	// conditions that exist TODAY; this one fails on a fourth condition added to
	// `stateWindowSetting` without a voice.
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

	// The default sink is `console.error`, which is what puts the report on pi's own
	// stderr.
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

	test("plans on turn_end, not tool_result — a boundary is never written before the turn completes", () => {
		// The invariant a real entrypoint's event choice depends on: at `tool_result` pi has
		// not yet persisted the closing tool result, so planning there would read an
		// UNPAIRED branch and collapse retention to Σ alone on every turn. This module's
		// own structure is what actually guarantees it — `writeBoundary` is called from
		// nowhere but the `turn_end` handler — so this is a regression guard against that
		// moving, not a measurement against a real pi binary's branch snapshots (that
		// measurement lives in sproot's own recorded-turn replay, which needs the pinned
		// `pi-state` fork this repo does not build).
		const pi = fakePi();
		resetStateCommitCache();
		installStateCommitCache(pi);
		const sigma = cached(4, '{"step":1}');
		installStateBoundary(pi, options, undefined, { branch: () => branchWith(1), now: () => 1 });

		for (const h of pi.handlers) if (h.event === "tool_result") h.handler(commitEvent(sigma), null);
		expect(pi.calls.length, "tool_result must only ARM the boundary, never write it").toBe(0);

		for (const h of pi.handlers) if (h.event === "turn_end") h.handler({}, null);
		expect(pi.calls.length, "turn_end must write the boundary once armed").toBe(1);
	});

	/**
	 * A `tool_call_id` REUSED across turns must not arm the boundary. The defect this
	 * guards: `answeredBy` once compared only `event.toolCallId === sigma.toolCallId`, on
	 * the reasoning that the cache had already decided what counts as an accepted commit.
	 * That reasoning is wrong in exactly one place: when a commit is REFUSED the cache
	 * deliberately RETAINS the previous Σ, because a stale-version refusal is the designed
	 * retry path and must not erase the agent's memory. So after one accepted commit under
	 * id `X`, any later result reusing `X` still matched the standing Σ on its id — and pi
	 * replays a repeated id verbatim, onto failed results too.
	 *
	 * Driven through the REAL cache, registered first exactly as sproot's entrypoint does,
	 * because the coupling between the two handlers is the thing under test.
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

		// (1) A REFUSED commit reusing the id. The cache keeps Σ v1 standing, so an id-only
		// match reads the retained Σ as this turn's acceptance.
		fire(pi, result({ isError: true, content: [{ type: "text", text: "the state moved under you" }] }), null);
		expect(
			pi.calls.length,
			"a REFUSED commit reusing the id bounded the transcript on a turn that committed nothing",
		).toBe(1);

		// (2) An unrelated SUCCESSFUL tool reusing the id. `isError` cannot reject this one,
		// which is why the tool NAME is part of the predicate rather than the flag alone.
		fire(pi, result({ toolName: "read", content: [{ type: "text", text: "file contents" }] }), null);
		expect(pi.calls.length, "an unrelated successful tool reusing the id armed the boundary").toBe(1);

		// (3) THE FLOOR, without which "reject everything" would satisfy the two above: a
		// genuine SECOND commit that also reuses the id still arms it, and carries the NEW
		// version.
		fire(pi, result({ content: [{ type: "text", text: commitText(2, '{"step":2}') }] }), null);
		expect(pi.calls.length, "a real second commit reusing the id was refused a boundary").toBe(2);
		expect(
			records.map((r) => (r as { stateVersion: number }).stateVersion),
			"the boundaries do not carry one version each — a retained Σ was re-recorded as a new commit",
		).toEqual([1, 2]);
	});

	/**
	 * THE ORDERING COUPLING, made checkable rather than assumed. An entrypoint registers
	 * the Σ cache BEFORE the boundary, and the whole of the coupling between the two is
	 * that ordering: the boundary asks `stateCommitCache().latest()` and expects an
	 * accepted commit to have already landed there. Nothing enforces it, so the arming
	 * predicate compares the event's TEXT against the standing Σ rather than trusting the
	 * order.
	 */
	test("refuses rather than arming against a stale Σ when the cache handler runs AFTER it", () => {
		const pi = fakePi();
		resetStateCommitCache();
		installStateBoundary(pi, options, undefined, { branch: () => branchWith(1), now: () => 1 });
		installStateCommitCache(pi); // inverted: the cache observes only after the boundary has looked

		const first = cached(1, '{"step":1}', "reused");
		fire(pi, commitEvent(first), null);
		// Nothing is cached when the boundary looks, so the first commit arms nothing
		// either — but it seeds the cache for the turn that follows, which is the
		// arrangement under test.
		expect(pi.calls.length).toBe(0);

		// A REAL second commit, same id, new bytes. The standing Σ is still v1 at the
		// moment the boundary reads it; an id-only match would bound the transcript to the
		// superseded v1.
		fire(pi, commitEvent(cached(2, '{"step":2}', "reused")), null);
		expect(
			pi.calls.length,
			"the boundary armed against the Σ standing BEFORE this commit — it would bound to a superseded document",
		).toBe(0);
	});

	// The invariant, stated as what it IS: not "one per accepted commit" — two
	// `state_commit` calls CAN land in one turn (parallel tool calls), and they collapse to
	// one boundary carrying the newest Σ. That is correct rather than a rounding: Σ is
	// CAS-versioned, so the later commit supersedes the earlier one. Built from two
	// `tool_result` events firing before the turn's single `turn_end`, standing in for the
	// recorded parallel-call turn a real pi produces.
	test("writes one boundary per TURN that accepted a commit, carrying the newest Σ", () => {
		const pi = fakePi();
		const records: unknown[] = [];
		resetStateCommitCache();
		installStateCommitCache(pi);
		installStateBoundary(pi, options, (d) => records.push(d), { branch: () => branchWith(1), now: () => 1 });

		const first = cached(2, '{"step":1}', "c-a");
		const second = cached(3, '{"step":2}', "c-b");
		for (const h of pi.handlers) if (h.event === "tool_result") h.handler(commitEvent(first), null);
		for (const h of pi.handlers) if (h.event === "tool_result") h.handler(commitEvent(second), null);
		expect(pi.calls.length, "two commits in one turn wrote a boundary before turn_end").toBe(0);
		for (const h of pi.handlers) if (h.event === "turn_end") h.handler({}, null);

		expect(pi.calls.length, "two commits in one turn did not collapse to exactly one boundary").toBe(1);
		expect((records[0] as { stateVersion: number }).stateVersion, "the boundary carries the newest Σ").toBe(3);
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

	test("records a refusal rather than staying silent — 'asked and failed' must not read as 'nobody asked'", () => {
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
