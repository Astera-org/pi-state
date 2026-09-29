// Paper mode: settings parsing, per-call projection, and commit enforcement, driven
// through the handlers `installPaperMode` registers on a fake `pi`.

import { beforeEach, describe, expect, test } from "vitest";
import {
	installPaperMode,
	PAPER_COMMIT_REQUIRED_REASON,
	PAPER_CONTRACT,
	paperMessages,
	paperSetting,
	stateModeSetting,
} from "../src/stateboundary/paper.js";
import { resetStateCommitCache, sigmaFromResult, stateWindowPreamble } from "../src/stateboundary/statewindow.js";

const user = (text: string) => ({ role: "user", content: text, timestamp: 1 });
const callsMsg = (...calls: Array<[id: string, name: string]>) => ({
	role: "assistant",
	content: calls.map(([id, name]) => ({ type: "toolCall", id, name, arguments: {} })),
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

/** One user turn followed by `cycles` complete read cycles. */
const conversation = (cycles: number) => {
	const out: Array<Record<string, unknown>> = [user("go")];
	for (let i = 0; i < cycles; i++) out.push(callsMsg([`c${i}`, "read"]), toolRes(`c${i}`));
	return out;
};

const sigma = sigmaFromResult({
	toolName: "state_commit",
	toolCallId: "k1",
	text: '{"ok":true,"version":3,"doc":{"step":3}}',
});

type Handler = (event: unknown, ctx: unknown) => unknown;

function install(options: Parameters<typeof paperSetting>[0] = {}, latest: typeof sigma = sigma) {
	const handlers = new Map<string, Handler>();
	const logs: string[] = [];
	const config = paperSetting(options);
	if ("condition" in config) throw new Error(config.reason);
	installPaperMode({ on: (event, handler) => handlers.set(event, handler) }, config, {
		sigma: () =>
			latest === null ? null : { toolName: "state_commit", toolCallId: latest.toolCallId, text: latest.text },
		now: () => 7,
		log: (m) => logs.push(m),
	});
	const call = (event: string, payload: unknown) => handlers.get(event)?.(payload, {});
	const context = (messages: unknown[]) => (call("context", { messages }) as { messages: unknown[] }).messages;
	const roles = (messages: unknown[]) => messages.map((m) => (m as { role: string }).role);
	return { handlers, logs, call, context, roles };
}

/** Delivers an assistant message with the named tool calls, then the tool_call event for `target`. */
function toolCallOutcome(h: ReturnType<typeof install>, names: string[], target: string) {
	h.call("message_end", { message: callsMsg(...names.map((n, i): [string, string] => [`t${i}`, n])) });
	return h.call("tool_call", { toolName: target, toolCallId: "x", input: {} });
}

beforeEach(() => resetStateCommitCache());

describe("stateModeSetting", () => {
	test("unset, empty and paper select paper; boundary selects boundary", () => {
		expect(stateModeSetting(undefined)).toBe("paper");
		expect(stateModeSetting("")).toBe("paper");
		expect(stateModeSetting("paper")).toBe("paper");
		expect(stateModeSetting("boundary")).toBe("boundary");
	});

	test("any other spelling is refused as a fault", () => {
		for (const bad of ["Paper", " paper", "papr", "1"]) {
			expect(stateModeSetting(bad), bad).toMatchObject({ condition: "state-mode", fault: true });
		}
	});
});

describe("paperSetting", () => {
	test("defaults to one trailing cycle and per-message commit enforcement", () => {
		expect(paperSetting({})).toEqual({ cycles: 1, requireCommit: "every" });
		expect(paperSetting({ cycles: "", requireCommit: "" })).toEqual({ cycles: 1, requireCommit: "every" });
	});

	test("accepts zero cycles, explicit cycles, every, off and positive integers", () => {
		expect(paperSetting({ cycles: "0" })).toMatchObject({ cycles: 0 });
		expect(paperSetting({ cycles: "3" })).toMatchObject({ cycles: 3 });
		expect(paperSetting({ requireCommit: "off" })).toMatchObject({ requireCommit: "off" });
		expect(paperSetting({ requireCommit: "every" })).toMatchObject({ requireCommit: "every" });
		expect(paperSetting({ requireCommit: "4" })).toMatchObject({ requireCommit: 4 });
	});

	test("refuses a malformed requireCommit", () => {
		for (const bad of ["0", "-1", "1.5", "two", " 2", "Every", "9".repeat(20)]) {
			expect(paperSetting({ requireCommit: bad }), bad).toMatchObject({ condition: "require-commit", fault: true });
		}
	});

	test("refuses a malformed cycle count and honors the kill switch", () => {
		expect(paperSetting({ cycles: "21" })).toMatchObject({ condition: "cycles" });
		expect(paperSetting({ killSwitch: "off" })).toMatchObject({ condition: "kill-switch", fault: false });
	});
});

describe("paperMessages", () => {
	test("returns Σ, the newest user turn and the last N complete cycles", () => {
		const out = paperMessages(sigma, 2, conversation(4), 1).messages;
		expect(out.map((m) => m.role)).toEqual(["user", "user", "assistant", "toolResult", "assistant", "toolResult"]);
		expect((out[0]!.content as string).startsWith(stateWindowPreamble("3"))).toBe(true);
	});

	test("with N=0 returns Σ and the newest user turn only", () => {
		const out = paperMessages(sigma, 0, conversation(3), 1).messages;
		expect(out.map((m) => m.role)).toEqual(["user", "user"]);
		expect(out[1]).toMatchObject({ content: "go" });
	});

	test("returns `{}` at version 0 when no state was committed", () => {
		const out = paperMessages(null, 1, conversation(1), 1).messages;
		expect(out[0]!.content).toBe(`${stateWindowPreamble("0")}{}`);
	});

	test("selects the newest of several user turns", () => {
		const held = [user("first"), ...conversation(1), user("second"), callsMsg(["z", "read"]), toolRes("z")];
		const out = paperMessages(sigma, 1, held, 1).messages;
		expect(out.map((m) => m.content)).toContain("second");
		expect(out.map((m) => m.content)).not.toContain("first");
	});

	test("falls back to Σ and the newest user turn, with the reason, when the tail cannot be paired", () => {
		const held = [user("go"), callsMsg(["a", "read"]), toolRes("a"), callsMsg(["b", "read"])];
		const out = paperMessages(sigma, 2, held, 1);
		expect(out.messages.map((m) => m.role)).toEqual(["user", "user"]);
		expect(out.messages[1]).toBe(held[0]);
		expect(out.narrowed).toMatch(/no matching tool result/);
	});

	test("returns Σ alone when there is no user turn and no cycles", () => {
		expect(paperMessages(sigma, 1, [], 1).messages.length).toBe(1);
	});

	test("passes retained messages through by reference", () => {
		const held = conversation(2);
		const out = paperMessages(sigma, 1, held, 1).messages;
		for (const m of out.slice(1)) expect(held.includes(m as Record<string, unknown>)).toBe(true);
	});
});

describe("installPaperMode: context", () => {
	test("projects on every call, with and without a commit in the current turn", () => {
		const h = install({ cycles: "1" });
		const withoutCommit = conversation(3);
		expect(h.roles(h.context(withoutCommit))).toEqual(["user", "user", "assistant", "toolResult"]);

		const withCommit = [
			...conversation(2),
			callsMsg(["k", "state_commit"], ["r", "read"]),
			toolRes("k"),
			toolRes("r"),
		];
		const out = h.context(withCommit);
		expect(h.roles(out)).toEqual(["user", "user", "assistant", "toolResult", "toolResult"]);
		expect(out.at(-1)).toBe(withCommit.at(-1));
	});

	test("keeps only Σ and the user turn at N=0", () => {
		const h = install({ cycles: "0" });
		expect(h.roles(h.context(conversation(3)))).toEqual(["user", "user"]);
	});

	test("shows `{}` at version 0 before any commit", () => {
		const h = install({}, null);
		const out = h.context(conversation(1)) as Array<{ content: string }>;
		expect(out[0]!.content).toBe(`${stateWindowPreamble("0")}{}`);
	});

	test("falls back to Σ and the user turn on an unpairable tail and logs the reason", () => {
		const h = install({ cycles: "2" });
		const out = h.context([user("go"), callsMsg(["a", "read"])]);
		expect(h.roles(out)).toEqual(["user", "user"]);
		expect(h.logs.length).toBe(1);
	});

	test("installs no turn_end handler", () => {
		expect([...install().handlers.keys()]).not.toContain("turn_end");
	});
});

describe("installPaperMode: system prompt", () => {
	test("appends the contract to the current system prompt", () => {
		const h = install();
		const out = h.call("before_agent_start", { systemPrompt: "base prompt" }) as { systemPrompt: string };
		expect(out.systemPrompt).toBe(`base prompt\n\n${PAPER_CONTRACT}`);
		expect(PAPER_CONTRACT).toContain("state_commit");
	});
});

describe("installPaperMode: commit enforcement", () => {
	test("every: blocks a lone non-commit call with the reason", () => {
		const h = install({ requireCommit: "every" });
		expect(toolCallOutcome(h, ["read"], "read")).toEqual({ block: true, reason: PAPER_COMMIT_REQUIRED_REASON });
		expect(PAPER_COMMIT_REQUIRED_REASON).toBe("include a state_commit call in the same message as this action");
	});

	test("every: allows a call alongside a state_commit and the state_commit itself", () => {
		const h = install({ requireCommit: "every" });
		h.call("message_end", { message: callsMsg(["a", "state_commit"], ["b", "read"]) });
		expect(h.call("tool_call", { toolName: "read" })).toBeUndefined();
		expect(h.call("tool_call", { toolName: "state_commit" })).toBeUndefined();
	});

	test("every: accepts the MCP-prefixed state_commit name as a commit", () => {
		const h = install();
		expect(toolCallOutcome(h, ["mcp__sproot__state_commit", "read"], "read")).toBeUndefined();
	});

	test("every: judges each assistant message by its own calls", () => {
		const h = install();
		expect(toolCallOutcome(h, ["state_commit", "read"], "read")).toBeUndefined();
		expect(toolCallOutcome(h, ["read"], "read")).toMatchObject({ block: true });
	});

	test("every: ignores assistant messages that carry no tool calls", () => {
		const h = install();
		h.call("message_end", { message: callsMsg(["a", "state_commit"], ["b", "read"]) });
		h.call("message_end", { message: { role: "assistant", content: [{ type: "text", text: "hi" }] } });
		h.call("message_end", { message: user("hello") });
		expect(h.call("tool_call", { toolName: "read" })).toBeUndefined();
	});

	test("off: never blocks and registers no enforcement handlers", () => {
		const h = install({ requireCommit: "off" });
		expect(toolCallOutcome(h, ["read"], "read")).toBeUndefined();
		expect(h.handlers.has("tool_call")).toBe(false);
		expect(h.handlers.has("message_end")).toBe(false);
	});

	test("K: blocks only once K consecutive commit-less messages have occurred", () => {
		const h = install({ requireCommit: "3" });
		expect(toolCallOutcome(h, ["read"], "read")).toBeUndefined();
		expect(toolCallOutcome(h, ["read"], "read")).toBeUndefined();
		expect(toolCallOutcome(h, ["read"], "read")).toMatchObject({ block: true });
		expect(toolCallOutcome(h, ["read"], "read")).toMatchObject({ block: true });
	});

	test("K: a state_commit message resets the count", () => {
		const h = install({ requireCommit: "2" });
		expect(toolCallOutcome(h, ["read"], "read")).toBeUndefined();
		expect(toolCallOutcome(h, ["state_commit", "read"], "read")).toBeUndefined();
		expect(toolCallOutcome(h, ["read"], "read")).toBeUndefined();
		expect(toolCallOutcome(h, ["read"], "read")).toMatchObject({ block: true });
	});

	test("K: allows a call alongside a state_commit even past K", () => {
		const h = install({ requireCommit: "1" });
		expect(toolCallOutcome(h, ["read"], "read")).toMatchObject({ block: true });
		expect(toolCallOutcome(h, ["state_commit", "read"], "read")).toBeUndefined();
	});

	test("resets the count at the start of a new prompt", () => {
		const h = install({ requireCommit: "2" });
		toolCallOutcome(h, ["read"], "read");
		h.call("before_agent_start", { systemPrompt: "" });
		expect(toolCallOutcome(h, ["read"], "read")).toBeUndefined();
	});
});
