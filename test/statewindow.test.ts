// Tests for the state window's Σ machinery: fail-closed configuration parsing, the kill
// switch's asymmetry, the cycle depth grammar, Σ selection, the cache's session identity
// handling, and byte-exact extraction of `doc`/`version` from a state_commit payload.
//
// Configuration cases build a `StateWindowOptions` object directly; `enabled` is a boolean.

import { describe, expect, test } from "vitest";
import { STATE_BOUNDARY_SOURCE, sigmaMessage, writeBoundary } from "../src/stateboundary/stateboundary.js";
import {
	DEFAULT_TOOL_CYCLES,
	installStateCommitCache,
	isStateCommitToolName,
	MAX_TOOL_CYCLES,
	newStateCommitCache,
	observeStateCommitResult,
	parseToolCycles,
	rawJsonMember,
	recordStateWindowIntoTranscript,
	resetStateCommitCache,
	resolveStateWindow,
	STATE_COMMIT_DOC_KEY,
	STATE_COMMIT_TOOL_NAMES,
	STATE_COMMIT_VERSION_KEY,
	STATE_WINDOW_ENTRY_TYPE,
	type StateWindowOff,
	type StateWindowOptions,
	seedStateCommitCache,
	seedStateCommitCacheFromEntries,
	sigmaFromResult,
	stateCommitCache,
	stateWindowPreamble,
	stateWindowSetting,
	toolResultText,
} from "../src/stateboundary/statewindow.js";

const SIGMA = "mcp__sproot__state_commit";

/**
 * A successful state_commit result as an MCP-backed `state_commit` tool returns it: numeric
 * `version`, the committed document under `doc`, plus transport fields; compact rendering
 * with Go's map-key ordering.
 */
const committed = (version: number, doc?: unknown) =>
	JSON.stringify({
		[STATE_COMMIT_DOC_KEY]: doc ?? { done: ["step one"] },
		maxStateBytes: 8192,
		updatedAt: "2026-09-09T14:30:38.127710124Z",
		[STATE_COMMIT_VERSION_KEY]: version,
	});

/**
 * A stale-version CAS refusal as an MCP-backed `state_commit` tool returns it. The bridge
 * throws on the server's `isError`, so pi finalizes the call with `isError: true`.
 */
const staleRefusal = "conflict: state version 7 is stale; re-read with state_get and commit again";

/**
 * pi's `tool_result` event for one finalized state_commit call, shaped as
 * `ToolResultEventBase`: `toolName`, `toolCallId`, `content` blocks and `isError`.
 */
const toolResultEvent = (toolCallId: string, text: string, over: Record<string, unknown> = {}) => ({
	type: "tool_result",
	toolName: SIGMA,
	toolCallId,
	input: {},
	content: [{ type: "text", text }],
	isError: false,
	...over,
});

/**
 * The same result as pi persists it (`createToolResultMessage`'s shape, returned by a
 * reloaded session). The four fields the cache reads have the same names as on the event.
 */
const toolResultMessage = (toolCallId: string, text: string, over: Record<string, unknown> = {}) => ({
	role: "toolResult",
	toolName: SIGMA,
	toolCallId,
	content: [{ type: "text", text }],
	details: {},
	isError: false,
	timestamp: 1787061660811,
	...over,
});

/** One session entry wrapping a message, as pi writes and reloads it. */
const entry = (message: Record<string, unknown>) => ({
	type: "message",
	id: message.toolCallId ?? "e",
	parentId: null,
	message,
});

/** Σ built by the same code the cache uses. */
const sigmaOf = (toolCallId: string, text: string) =>
	sigmaFromResult(observeStateCommitResult(toolResultEvent(toolCallId, text)));

describe("configuration fails closed", () => {
	test("is off unless enabled is true, and unrelated to any raw env spelling", () => {
		expect(resolveStateWindow({ enabled: true })).toEqual({ cycles: DEFAULT_TOOL_CYCLES });
		expect(resolveStateWindow({ enabled: false })).toBeNull();
	});

	test("the kill switch refuses on anything that is not a recognized affirmative", () => {
		for (const off of ["0", "false", "no", "off", "OFF", " No ", "garbage", "truthy", "-1", "2"]) {
			expect(resolveStateWindow({ enabled: true, killSwitch: off }), off).toBeNull();
		}
		// Only an explicit affirmative, or no override, lets the mode run.
		for (const on of ["1", "true", "yes", "on", " ON ", ""]) {
			expect(resolveStateWindow({ enabled: true, killSwitch: on }), on).toEqual({ cycles: DEFAULT_TOOL_CYCLES });
		}
		expect(
			resolveStateWindow({ enabled: false, killSwitch: "1" }),
			"the kill switch alone never enables anything",
		).toBeNull();
	});

	test("a malformed cycle depth turns the mode OFF — it is never clamped or defaulted", () => {
		expect(parseToolCycles(undefined), "unset is not configured, not malformed").toBe(DEFAULT_TOOL_CYCLES);
		expect(parseToolCycles("")).toBe(DEFAULT_TOOL_CYCLES);
		expect(parseToolCycles("0"), "zero is a real setting — Σ and O only").toBe(0);
		expect(parseToolCycles("2")).toBe(2);
		expect(parseToolCycles(String(MAX_TOOL_CYCLES))).toBe(MAX_TOOL_CYCLES);
		for (const bad of ["abc", "4oops", "-3", " 4", "4 ", "4.0", String(MAX_TOOL_CYCLES + 1), "100000", " "]) {
			expect(parseToolCycles(bad), JSON.stringify(bad)).toBeNull();
			expect(resolveStateWindow({ enabled: true, cycles: bad }), JSON.stringify(bad)).toBeNull();
		}
		expect(resolveStateWindow({ enabled: true, cycles: "2" })?.cycles).toBe(2);
	});

	test("every null resolveStateWindow returns is a setting that names its own condition", () => {
		const off: Array<[StateWindowOptions, string]> = [
			[{ enabled: false }, "mode"],
			[{ enabled: true, cycles: "4oops" }, "cycles"],
			[{ enabled: true, cycles: String(MAX_TOOL_CYCLES + 1) }, "cycles"],
			[{ enabled: true, killSwitch: "0" }, "kill-switch"],
			[{ enabled: true, killSwitch: "garbage" }, "kill-switch"],
		];
		for (const [options, condition] of off) {
			const setting = stateWindowSetting(options) as StateWindowOff;
			expect(resolveStateWindow(options), JSON.stringify(options)).toBeNull();
			expect(setting.condition, JSON.stringify(options)).toBe(condition);
			expect(setting.reason.length, `${condition} refused with an empty reason`).toBeGreaterThan(0);
		}
		// A setting that resolves carries the configuration and no condition.
		const on = stateWindowSetting({ enabled: true, cycles: "2" });
		expect("condition" in on).toBe(false);
		expect(on).toEqual({ cycles: 2 });
	});

	// `fault` is false only for a recognized negative kill switch.
	test("only a recognized negative kill switch is somebody's decision; every other refusal is a fault", () => {
		for (const deliberate of ["0", "false", "no", "off", "OFF", " No "]) {
			const setting = stateWindowSetting({ enabled: true, killSwitch: deliberate }) as StateWindowOff;
			expect(setting.condition, deliberate).toBe("kill-switch");
			expect(setting.fault, `${deliberate} reads as a fault, not as the operator's own switch`).toBe(false);
		}
		for (const options of [
			{ enabled: true, killSwitch: "garbage" },
			{ enabled: true, killSwitch: "2" },
			{ enabled: false },
			{ enabled: true, cycles: "-1" },
		]) {
			expect((stateWindowSetting(options) as StateWindowOff).fault, JSON.stringify(options)).toBe(true);
		}
	});

	test("a quoted value cannot run away with the log line", () => {
		const setting = stateWindowSetting({ enabled: true, killSwitch: "x".repeat(4000) }) as StateWindowOff;
		expect(setting.reason.length, `the reason is ${setting.reason.length} characters long`).toBeLessThan(200);
		expect(setting.reason, "a clipped value does not say it was clipped").toContain("…");
	});

	test("the ceiling matches an external write-boundary check", () => {
		expect(MAX_TOOL_CYCLES).toBe(20);
	});
});

describe("Σ selection", () => {
	test("accepts only the bare tool name and the MCP-style spelling", () => {
		expect([...STATE_COMMIT_TOOL_NAMES]).toEqual(["state_commit", "mcp__sproot__state_commit"]);
		expect(isStateCommitToolName("state_commit")).toBe(true);
		expect(isStateCommitToolName("mcp__sproot__state_commit")).toBe(true);
		for (const near of [
			"mcp__sproot-engram__state_commit",
			"mcp__other__state_commit",
			"__state_commit",
			"x__state_commit",
			"state_commit ",
			" state_commit",
			"state_get",
			"mcp__sproot__state_get",
			"prestate_commit",
			undefined,
			42,
		]) {
			expect(isStateCommitToolName(near), String(near)).toBe(false);
		}
	});

	test("ONLY pi's isError === false makes a result Σ — nothing weaker, nothing absent", () => {
		// Success is `isError` compared to the literal `false`; an absent flag or any other
		// value is not a success.
		expect(observeStateCommitResult(toolResultEvent("c1", committed(7)))).toEqual({
			toolName: SIGMA,
			toolCallId: "c1",
			text: committed(7),
		});
		for (const over of [
			{ isError: true },
			{ isError: undefined },
			{ isError: 0 },
			{ isError: "false" },
			{ isError: null },
		]) {
			expect(observeStateCommitResult(toolResultEvent("c1", committed(7), over)), JSON.stringify(over)).toBeNull();
		}
		// The event must name a state_commit and identify its call.
		expect(observeStateCommitResult(toolResultEvent("c1", committed(7), { toolName: "read" }))).toBeNull();
		expect(observeStateCommitResult(toolResultEvent("", committed(7))), "no toolCallId").toBeNull();
		for (const junk of [null, undefined, "tool_result", 42, [toolResultEvent("c1", committed(7))]]) {
			expect(observeStateCommitResult(junk), String(junk)).toBeNull();
		}
	});

	test("a refusal never shadows the newest success", () => {
		// A stale-version CAS refusal arrives with isError: true and leaves the previous Σ
		// standing.
		const cache = newStateCommitCache();
		cache.observe(toolResultEvent("c1", committed(4)));
		cache.observe(toolResultEvent("c2", staleRefusal, { isError: true }));
		expect(cache.latest()).toEqual({ toolName: SIGMA, toolCallId: "c1", text: committed(4) });

		const sigma = sigmaFromResult(cache.latest())!;
		expect(sigma.version, "the newest SUCCESSFUL commit, not the newest commit").toBe(4);
		const carried = sigmaMessage(sigma, 1).content as string;
		expect(carried, "the valid state survived").toContain("step one");
		expect(carried, "the refusal text is not the agent's memory").not.toContain("stale");
		expect(carried, "Σ is the committed doc, not the envelope").not.toContain("maxStateBytes");
		expect(carried.startsWith(stateWindowPreamble("4"))).toBe(true);
	});

	test("a later SUCCESS replaces the earlier one", () => {
		const cache = newStateCommitCache();
		cache.observe(toolResultEvent("c1", committed(4)));
		cache.observe(toolResultEvent("c2", committed(5)));
		expect(sigmaFromResult(cache.latest())?.version).toBe(5);
	});

	test("a result text the window cannot carry is not Σ, however pi flagged it", () => {
		// Extraction fails closed: a version that does not slice out as a JSON number, or a doc
		// that does not slice out as an object, yields no Σ.
		expect(sigmaOf("c1", committed(7))).toEqual({
			toolCallId: "c1",
			// The cached bytes are carried alongside.
			text: committed(7),
			version: 7,
			versionText: "7",
			doc: JSON.stringify({ done: ["step one"] }),
		});
		for (const text of [
			staleRefusal,
			"",
			"{",
			JSON.stringify({ version: 7 }), // no doc
			JSON.stringify({ doc: {} }), // no version
			JSON.stringify({ version: "7", doc: {} }),
			JSON.stringify({ version: null, doc: {} }),
			JSON.stringify({ version: true, doc: {} }),
			JSON.stringify({ version: 7, doc: null }),
			JSON.stringify({ version: 7, doc: [] }),
			JSON.stringify({ version: 7, doc: "the state" }),
			JSON.stringify({ version: 7, doc: 0 }),
			'{"version":1,"doc":{"a":1}', // truncated: the scanner and a parse must not disagree
		]) {
			expect(sigmaFromResult({ toolName: SIGMA, toolCallId: "c1", text }), JSON.stringify(text)).toBeNull();
		}
		expect(sigmaFromResult(null)).toBeNull();
	});

	test("reads the result text out of pi's content blocks as well as a bare string", () => {
		expect(observeStateCommitResult(toolResultEvent("c1", committed(0, { a: 1 })))?.text).toBe(
			committed(0, { a: 1 }),
		);
		expect(
			observeStateCommitResult({ toolName: SIGMA, toolCallId: "c1", isError: false, content: committed(2) })?.text,
		).toBe(committed(2));
	});

	test("preserves arbitrary-precision numbers a JS round trip would CORRUPT", () => {
		// JSON.parse turns 9999999999999999 into 10000000000000000; Σ must carry the committed
		// digits.
		const raw = '{"doc":{"big":9999999999999999,"tiny":1e-400,"neg":-0},"version":9007199254740993}';
		expect(JSON.stringify(JSON.parse(raw).doc.big), "the corruption is real, not hypothetical").toBe(
			"10000000000000000",
		);
		const got = sigmaOf("c1", raw)!;
		expect(got.doc).toBe('{"big":9999999999999999,"tiny":1e-400,"neg":-0}');
		expect(got.versionText, "the version is quoted back exactly as committed").toBe("9007199254740993");

		const rehomed = sigmaMessage(got, 1).content as string;
		expect(rehomed).toBe(stateWindowPreamble("9007199254740993") + got.doc);
		expect(rehomed, "the committed digits reach the prompt").toContain("9999999999999999");
		expect(rehomed, "the reparsed digits never do").not.toContain("10000000000000000");
	});

	test("a document at exactly the 4096-byte cap re-homes as exactly 4096 bytes", () => {
		// The 4096-byte canonical document is 4097 bytes when reserialized.
		let doc: { pad: string } = { pad: "" };
		for (let n = 0; JSON.stringify(doc).length !== 4096 && n < 4200; n++) {
			doc = { pad: "x".repeat(n) };
		}
		const canonical = JSON.stringify(doc);
		expect(Buffer.byteLength(canonical), "the fixture must actually sit on the cap").toBe(4096);
		const raw = `{"doc":${canonical},"maxStateBytes":4096,"version":3}`;
		expect(sigmaOf("c1", raw)?.doc).toBe(canonical);
		const rehomed = sigmaMessage(sigmaOf("c1", raw)!, 1).content as string;
		const carried = rehomed.slice(stateWindowPreamble("3").length);
		expect(carried).toBe(canonical);
		expect(Buffer.byteLength(carried), "the capped bytes and the paid bytes are the same bytes").toBe(4096);
	});

	test("the raw slice respects strings and escapes, and takes the LAST duplicate key like JSON.parse", () => {
		const nasty = '{"a":"}\\"{ \\\\","b":[1,{"c":"]"}]}';
		JSON.parse(nasty); // the fixture must be valid JSON, or the test proves nothing
		const raw = `{"version":1,"doc":${nasty},"updatedAt":"x"}`;
		expect(rawJsonMember(raw, "doc")).toBe(nasty);
		expect(sigmaOf("c1", raw)?.doc).toBe(nasty);

		const dup = '{"version":1,"doc":{"first":1},"doc":{"second":2}}';
		expect(JSON.parse(dup).doc.second, "JSON.parse takes the last").toBe(2);
		expect(rawJsonMember(dup, "doc"), "and so does the slice").toBe('{"second":2}');

		expect(rawJsonMember("not json", "doc")).toBeNull();
		expect(rawJsonMember('["a"]', "doc")).toBeNull();
		expect(rawJsonMember('{"version":1}', "doc")).toBeNull();
	});

	test("a success whose document is missing does not wipe the Σ behind it", () => {
		// The cache holds the docless result (pi reported success) and extraction declines it, so
		// Σ is absent rather than an empty document.
		const docless = JSON.stringify({ version: 7 });
		const cache = newStateCommitCache();
		cache.observe(toolResultEvent("c1", committed(4)));
		cache.observe(toolResultEvent("c2", docless));
		expect(cache.latest()?.text, "pi called it a success, so the cache holds it").toBe(docless);
		expect(sigmaFromResult(cache.latest()), "the empty document never becomes Σ").toBeNull();
	});

	test("a run whose only commit FAILED is the no-Σ case, not a rehomed error string", () => {
		const cache = newStateCommitCache();
		cache.observe(toolResultEvent("c1", staleRefusal, { isError: true }));
		expect(cache.latest(), "a refusal is not Σ, so this run has none").toBeNull();
		expect(sigmaFromResult(cache.latest()), "and the refusal text is never carried as one").toBeNull();
	});

	test("an engram tool result of the same shape is not eligible to become Σ", () => {
		// Tool names match exactly, not by suffix; the cache refuses this name.
		const engram = "mcp__sproot-engram__state_commit";
		const cache = newStateCommitCache();
		expect(isStateCommitToolName(engram), "the name gate is exact, not a suffix match").toBe(false);
		cache.observe(toolResultEvent("c1", committed(9), { toolName: engram }));
		expect(cache.latest(), "so it is not even eligible to become Σ").toBeNull();
	});

	test("a RESUMED session re-derives Σ from the transcript pi reloaded", () => {
		// pi reloads a session's entries but replays no tool execution. pi persists `isError` on
		// every toolResult entry, so the seed consults the same flag a live event does.
		const resumed = newStateCommitCache();
		expect(resumed.latest(), "nothing was executed in this process").toBeNull();
		seedStateCommitCacheFromEntries(resumed, [
			entry(toolResultMessage("c1", committed(4))),
			entry(toolResultMessage("c2", staleRefusal, { isError: true })),
			entry({ role: "assistant", content: "…" }),
			entry(toolResultMessage("c3", committed(5))),
			entry(toolResultMessage("c4", committed(9), { toolName: "mcp__sproot-engram__state_commit" })),
			{ type: "thinking_level_change", thinkingLevel: "off" },
		]);
		expect(
			resumed.latest(),
			"the newest SUCCESS on the branch — not the newest entry, not the refusal, not the engram tool",
		).toEqual({ toolName: SIGMA, toolCallId: "c3", text: committed(5) });

		const sigma = sigmaFromResult(resumed.latest())!;
		expect(sigma.version).toBe(5);
		expect(
			sigmaMessage(sigma, 1).content,
			"…and the re-derived Σ is what the boundary carries, which is where losing it would have hurt",
		).toSatisfy((content: unknown) => typeof content === "string" && content.startsWith(stateWindowPreamble("5")));
	});

	test("the seed reads pi's persisted flag, and a readable branch replaces the cache", () => {
		// The seed hands each entry's message to the same gate a live event goes through.
		const only = (message: Record<string, unknown>) => {
			const c = newStateCommitCache();
			seedStateCommitCacheFromEntries(c, [entry(message)]);
			return c.latest();
		};
		expect(only(toolResultMessage("c1", committed(4), { isError: true }))).toBeNull();
		expect(
			only(toolResultMessage("c1", committed(4), { isError: undefined })),
			"an absent flag is not a success",
		).toBeNull();
		expect(only(toolResultMessage("c1", committed(4)))?.toolCallId).toBe("c1");
		// Non-message and malformed entries are ignored.
		const junk = newStateCommitCache();
		seedStateCommitCacheFromEntries(junk, [null, "nope", 7, {}, { message: null }, { message: "x" }, []]);
		expect(junk.latest()).toBeNull();

		// A readable branch replaces the cache.
		seedStateCommitCache({ sessionManager: { getBranch: () => [entry(toolResultMessage("c7", committed(8)))] } });
		expect(stateCommitCache().latest()?.toolCallId).toBe("c7");
		seedStateCommitCache({ sessionManager: { getBranch: () => [] } });
		expect(stateCommitCache().latest(), "a session that committed nothing carries nothing over").toBeNull();
	});

	test("an unreadable branch keeps Σ only while the session id says it is the SAME session", () => {
		// `session_start` is re-entrant: a reload of this session and a replacement by `/new`,
		// `/fork` or `/resume` arrive through the same event. Only the session id distinguishes
		// them, so the cache is kept only when the id matches the session it was built for.
		const branchOf = (id: string, toolCallId: string, text: string) => ({
			sessionManager: { getSessionId: () => id, getBranch: () => [entry(toolResultMessage(toolCallId, text))] },
		});
		const noBranch = (id: string) => ({ sessionManager: { getSessionId: () => id } });

		seedStateCommitCache(branchOf("S1", "c1", committed(4)));
		expect(stateCommitCache().latest()?.toolCallId).toBe("c1");
		// Live commits after the seed belong to S1 too.
		stateCommitCache().observe(toolResultEvent("c2", committed(5)));

		const kept: string[] = [];
		seedStateCommitCache(noBranch("S1"), (m) => kept.push(m));
		expect(stateCommitCache().latest()?.toolCallId, "a RELOAD of S1 keeps what S1 committed").toBe("c2");
		expect(kept.join("")).toMatch(/still session S1 — kept the Σ already cached/);

		// A different, unreadable or absent id clears.
		for (const [name, ctx] of [
			["a REPLACEMENT session", noBranch("S2")],
			[
				"an unreadable id",
				{
					sessionManager: {
						getSessionId: () => {
							throw new Error("no");
						},
					},
				},
			],
			["a non-string id", { sessionManager: { getSessionId: () => 7 } }],
			["an empty id", { sessionManager: { getSessionId: () => "" } }],
			["no session manager at all", {}],
			["no context at all", undefined],
		] as const) {
			resetStateCommitCache();
			seedStateCommitCache(branchOf("S1", "c1", committed(4)));
			expect(stateCommitCache().latest()?.toolCallId, name as string).toBe("c1");
			const notes: string[] = [];
			seedStateCommitCache(ctx, (m) => notes.push(m));
			expect(
				stateCommitCache().latest(),
				`${name}: S1's Σ survived into a session that is not provably S1`,
			).toBeNull();
			expect(notes.join("")).toMatch(/cleared Σ rather than carry another session's into it/);
		}

		// No identity ever established (a pi exposing neither API): the cache was filled by live
		// events alone, and `null === null` must not count as the same session, so it clears.
		resetStateCommitCache();
		stateCommitCache().observe(toolResultEvent("live", committed(3)));
		expect(stateCommitCache().latest()?.toolCallId).toBe("live");
		seedStateCommitCache({});
		expect(
			stateCommitCache().latest(),
			"an unknown identity matched an unknown identity and Σ was kept — two unknowns are not a session",
		).toBeNull();
	});

	test("a replacement session's OWN Σ survives its reload — the clear records whose session it became", () => {
		// Sequence:
		//   S1 cached -> unreadable replacement by S2 clears
		//             -> S2 commits live
		//             -> unreadable reload of S2 keeps what S2 committed.
		//
		// The last step requires the clear to have recorded that the cache belongs to S2.
		const branchOf = (id: string, toolCallId: string, text: string) => ({
			sessionManager: { getSessionId: () => id, getBranch: () => [entry(toolResultMessage(toolCallId, text))] },
		});
		const noBranch = (id: string) => ({ sessionManager: { getSessionId: () => id } });

		seedStateCommitCache(branchOf("S1", "c1", committed(4)));
		expect(stateCommitCache().latest()?.toolCallId, "S1 is established").toBe("c1");

		seedStateCommitCache(noBranch("S2"));
		expect(stateCommitCache().latest(), "the replacement by S2 clears S1's Σ").toBeNull();

		stateCommitCache().observe(toolResultEvent("c9", committed(7)));
		expect(stateCommitCache().latest()?.toolCallId, "S2 commits for itself").toBe("c9");

		const notes: string[] = [];
		seedStateCommitCache(noBranch("S2"), (m) => notes.push(m));
		expect(
			stateCommitCache().latest()?.toolCallId,
			"a reload of S2 wiped S2's OWN Σ — the clear did not record whose session the cache had become",
		).toBe("c9");
		expect(notes.join("")).toMatch(/still session S2 — kept the Σ already cached/);

		// S3 does not inherit what S2 committed.
		seedStateCommitCache(noBranch("S3"));
		expect(stateCommitCache().latest()).toBeNull();

		// Reset drops the identity along with the contents.
		seedStateCommitCache(branchOf("S4", "c4", committed(2)));
		resetStateCommitCache();
		stateCommitCache().observe(toolResultEvent("after-reset", committed(3)));
		seedStateCommitCache(noBranch("S4"));
		expect(
			stateCommitCache().latest(),
			"reset left S4's identity behind, so an unrelated S4 claimed a cache it never built",
		).toBeNull();
	});

	test("the installed handler feeds the CURRENT cache, not the one bound when it was installed", () => {
		// installStateCommitCache runs once at extension load; each later `session_start` seed
		// replaces the binding. The handler must feed the current cache, not the one bound at
		// install time.
		const handlers: Array<{ event: string; handler: (event: unknown, ctx: unknown) => unknown }> = [];
		installStateCommitCache({ on: (event, handler) => handlers.push({ event, handler }) });
		expect(handlers.map((h) => h.event)).toEqual(["tool_result"]);

		seedStateCommitCache({ sessionManager: { getSessionId: () => "S1", getBranch: () => [] } });
		expect(stateCommitCache().latest(), "the seed replaced the binding").toBeNull();

		expect(handlers[0]!.handler(toolResultEvent("c1", committed(2)), {})).toBeUndefined();
		expect(
			stateCommitCache().latest()?.toolCallId,
			"the live commit landed in an orphaned cache — Σ would freeze at whatever the seed found",
		).toBe("c1");
	});

	test("the boundary resolves Σ at WRITE time, across a rebinding seed", () => {
		// An entrypoint installs the boundary at extension load, before the first `session_start`
		// rebinds the cache. writeBoundary's default supplier is `() => stateCommitCache().latest()`;
		// this drives it without the `sigma` dep so the supplier must resolve the current binding.
		const written: Array<{ messages: unknown[]; options: Record<string, unknown> }> = [];
		const pi = {
			on: () => {},
			replaceTranscript: (messages: unknown[], options: unknown) =>
				written.push({ messages, options: options as Record<string, unknown> }),
		};

		// A session_start rebinds, then the agent commits.
		seedStateCommitCache({ sessionManager: { getSessionId: () => "S1", getBranch: () => [] } });
		stateCommitCache().observe(toolResultEvent("c1", committed(4)));

		const rec = writeBoundary(
			pi,
			{ cycles: 1 },
			{ requests: 1, rewrites: 0, refusals: 0 },
			{ branch: () => [], now: () => 42 },
			null,
		);
		expect(
			"failed" in rec ? rec.reason : undefined,
			"the boundary was frozen on the binding it held before the seed",
		).toBeUndefined();
		expect((rec as { stateVersion: number }).stateVersion).toBe(4);
		expect(written[0]!.options.source).toBe(STATE_BOUNDARY_SOURCE);
		expect((written[0]!.messages[0] as { content: string }).content).toBe(
			stateWindowPreamble("4") + JSON.stringify({ done: ["step one"] }),
		);
	});

	test("nothing can hold a binding that goes stale — every accessor resolves current", () => {
		// The façade and each of its methods are the only handles on the process cache; all read
		// the current binding at call time.
		const facade = stateCommitCache();
		const latest = stateCommitCache().latest;
		const observe = stateCommitCache().observe;

		observe(toolResultEvent("before", committed(1)));
		expect(latest()?.toolCallId).toBe("before");

		seedStateCommitCache({ sessionManager: { getSessionId: () => "S2", getBranch: () => [] } });
		expect(facade.latest(), "a captured façade served a cache the seed replaced").toBeNull();
		expect(latest(), "a captured `latest` served a cache the seed replaced").toBeNull();

		observe(toolResultEvent("after", committed(2)));
		expect(stateCommitCache().latest()?.toolCallId, "a captured `observe` wrote into a cache the seed replaced").toBe(
			"after",
		);
		expect(latest()?.toolCallId).toBe("after");
	});

	test("the accessor hands out no way to rebind, reassign or edit — at RUNTIME, not by type", () => {
		// These are runtime properties, not type-level ones.
		const facade = stateCommitCache();

		// The binding's own controls are absent from the view.
		expect("rebind" in facade, "callers can replace the cache and its identity").toBe(false);
		expect("sessionId" in facade).toBe(false);

		// ESM is strict mode, so assigning to a frozen property throws.
		expect(Object.isFrozen(facade)).toBe(true);
		const orphan = newStateCommitCache();
		expect(() => {
			(facade as { observe: unknown }).observe = orphan.observe;
		}, "`observe` was swapped for a reader that never sees a rebinding").toThrow(TypeError);
		expect(() => {
			(facade as { latest: unknown }).latest = orphan.latest;
		}).toThrow(TypeError);

		// The cached record is not editable in place.
		facade.observe(toolResultEvent("c1", committed(4)));
		const record = facade.latest()!;
		expect(Object.isFrozen(record)).toBe(true);
		expect(() => {
			(record as { text: string }).text = committed(99);
		}, "Σ's bytes could be rewritten after the fact").toThrow(TypeError);
		expect(facade.latest()?.text).toBe(committed(4));

		// The exported factory returns a frozen cache too.
		const own = newStateCommitCache();
		expect(Object.isFrozen(own)).toBe(true);
		expect(() => {
			(own as { observe: unknown }).observe = () => {};
		}, "a caller can silence its own cache's observe").toThrow(TypeError);
	});
});

describe("the transcript record", () => {
	test("writes a sproot-state-window custom entry, and survives a pi without appendEntry", () => {
		const written: Array<[string, unknown]> = [];
		const record = {
			cycles: 1,
			messagesBefore: 12,
			messagesAfter: 5,
			bytesBefore: 400,
			bytesAfter: 90,
			droppedMessages: 7,
			droppedCycles: 3,
			state: "rehomed" as const,
			requests: 1,
			rewrites: 1,
			refusals: 0,
		};
		recordStateWindowIntoTranscript({ appendEntry: (t, d) => written.push([t, d]) }, record);
		expect(written).toEqual([[STATE_WINDOW_ENTRY_TYPE, record]]);

		const notes: string[] = [];
		recordStateWindowIntoTranscript({}, record, (m) => notes.push(m));
		expect(written.length).toBe(1);
		expect(notes.length).toBe(1);

		const thrown: string[] = [];
		recordStateWindowIntoTranscript(
			{
				appendEntry() {
					throw new Error("no");
				},
			},
			record,
			(m) => thrown.push(m),
		);
		expect(thrown.length).toBe(1);
	});

	test("re-homes Σ's document as the payload's OWN BYTES, verbatim", () => {
		// The document is sliced from the payload, not reserialized.
		const sigma = sigmaOf("c1", committed(4))!;
		const rehomed = sigmaMessage(sigma, 1).content as string;
		const doc = rehomed.slice(stateWindowPreamble("4").length);
		expect(doc).toBe(rawJsonMember(committed(4), "doc"));
		expect(doc).toBe(JSON.stringify({ done: ["step one"] }));
		expect(doc.includes("\n"), "no indentation reaches the prompt").toBe(false);
	});

	test("extraction is indifferent to how the payload was rendered", () => {
		// The sliced doc is whatever rendering the payload used; bytes are not normalized.
		const doc = { objective: "ship the core", step: 1 };
		const payload = { version: 1, doc };
		expect(sigmaOf("c1", JSON.stringify(payload))?.doc).toBe(JSON.stringify(doc));
		expect(sigmaOf("c1", JSON.stringify(payload, null, 2))?.doc).toBe(
			JSON.stringify(doc, null, 2).replace(/\n/g, "\n  "),
		);
		// The verbatim shape an MCP-backed backend emits.
		expect(
			sigmaOf(
				"c1",
				'{"doc":{"objective":"ship the core","step":1},"maxStateBytes":256,' +
					'"updatedAt":"2026-09-09T14:30:38.127710124Z","version":1}',
			),
		).toEqual({
			toolCallId: "c1",
			text:
				'{"doc":{"objective":"ship the core","step":1},"maxStateBytes":256,' +
				'"updatedAt":"2026-09-09T14:30:38.127710124Z","version":1}',
			version: 1,
			versionText: "1",
			doc: '{"objective":"ship the core","step":1}',
		});
	});

	test("reads a tool result's text out of both content shapes", () => {
		expect(toolResultText("plain")).toBe("plain");
		expect(
			toolResultText([
				{ type: "text", text: "a" },
				{ type: "text", text: "b" },
			]),
		).toBe("a\nb");
		expect(toolResultText(null)).toBe("");
		expect(toolResultText({ state: 1 })).toBe('{"state":1}');
	});
});
