// End-to-end proof of the standalone entrypoint's whole chain: a fake `pi` host (same
// pattern stateboundary.test.ts/statewindow.test.ts already use), the full wiring
// installed against it, a real file on disk, and `replaceTranscript` receiving the
// correctly bounded transcript after a commit.

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { readFileState } from "../src/backend/index.js";
import { installPiState, type PiExtensionAPI, type PiToolDefinition } from "../src/entrypoint/index.js";
import { resetStateCommitCache, stateCommitCache } from "../src/stateboundary/index.js";

function fakePi(overrides: Partial<PiExtensionAPI> = {}): PiExtensionAPI & {
	handlers: Array<{ event: string; handler: (event: unknown, ctx: unknown) => unknown }>;
	tools: Map<string, PiToolDefinition>;
	calls: Array<{ messages: unknown[]; options: unknown }>;
} {
	const handlers: Array<{ event: string; handler: (event: unknown, ctx: unknown) => unknown }> = [];
	const tools = new Map<string, PiToolDefinition>();
	const calls: Array<{ messages: unknown[]; options: unknown }> = [];
	return {
		handlers,
		tools,
		calls,
		on: (event, handler) => handlers.push({ event, handler }),
		registerTool: (tool) => tools.set(tool.name, tool),
		replaceTranscript: (messages, options) => calls.push({ messages, options }),
		appendEntry: () => {},
		...overrides,
	};
}

const msgEntry = (message: Record<string, unknown>) => ({ type: "message", message });
const userMsg = (text: string) => ({ role: "user", content: text, timestamp: 1 });
const callMsg = (id: string, name: string) => ({
	role: "assistant",
	content: [{ type: "toolCall", id, name, arguments: {} }],
	timestamp: 1,
});
const toolResultMsg = (id: string, name: string, text: string) => ({
	role: "toolResult",
	toolCallId: id,
	toolName: name,
	content: [{ type: "text", text }],
	isError: false,
	timestamp: 1,
});

let dir: string;
let schemaPath: string;
let statePath: string;

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "pi-state-entrypoint-"));
	schemaPath = join(dir, "schema.json");
	statePath = join(dir, "state.json");
	await writeFile(
		schemaPath,
		JSON.stringify({ maxStateBytes: 4096, keys: { objective: { type: "string" }, step: { type: "number" } } }),
		"utf8",
	);
});

afterEach(async () => {
	await rm(dir, { recursive: true, force: true });
});

test("refuses loudly — throws — when this pi exposes no replaceTranscript", async () => {
	const pi = fakePi({ replaceTranscript: undefined });
	await expect(installPiState(pi, { schemaPath, statePath })).rejects.toThrow(/replaceTranscript/);
	// Nothing was registered: the refusal happens before any tool or handler is wired.
	expect(pi.tools.size).toBe(0);
	expect(pi.handlers.length).toBe(0);
});

test("refuses when no schema file is present, naming the path", async () => {
	const pi = fakePi();
	await expect(installPiState(pi, { schemaPath: join(dir, "missing-schema.json"), statePath })).rejects.toThrow(
		/no schema file at/,
	);
});

describe("the full chain: tool call -> file write -> Σ cache -> boundary -> replaceTranscript", () => {
	test("a state_commit call writes the file, and the next turn's boundary carries it", async () => {
		const pi = fakePi();
		const logs: string[] = [];
		await installPiState(pi, {
			schemaPath,
			statePath,
			env: { PI_STATE_LOOP: "true", PI_STATE_WINDOW_CYCLES: "1" },
			log: (m) => logs.push(m),
		});

		expect([...pi.tools.keys()].sort()).toEqual(["state_commit", "state_get"]);

		// state_get before any commit reads as "before the first commit".
		const getResult = await pi.tools.get("state_get")!.execute("get-1", {});
		const getPayload = JSON.parse(getResult.content[0]!.text);
		expect(getPayload).toMatchObject({ exists: false, version: 0, doc: {} });

		// The model commits a patch.
		const commitResult = await pi.tools
			.get("state_commit")!
			.execute("call-1", { patch: { objective: "ship it", step: 1 }, version: 0 });
		const commitText = commitResult.content[0]!.text;
		const commitPayload = JSON.parse(commitText);
		expect(commitPayload.ok).toBe(true);
		expect(commitPayload.version).toBe(1);
		expect(commitPayload.doc).toEqual({ objective: "ship it", step: 1 });

		// It really landed on disk, in a real temp-directory file.
		const onDisk = await readFileState(statePath);
		expect(onDisk.exists).toBe(true);
		expect(onDisk.version).toBe(1);
		expect(onDisk.doc.objective).toBe("ship it");
		const raw = await readFile(statePath, "utf8");
		expect(() => JSON.parse(raw)).not.toThrow();

		// pi delivers the tool_result and then turn_end, with the branch it held at each.
		const branch = [
			msgEntry(userMsg("go")),
			msgEntry(callMsg("call-1", "state_commit")),
			msgEntry(toolResultMsg("call-1", "state_commit", commitText)),
		];
		const ctx = { sessionManager: { getBranch: () => branch } };
		const event = {
			type: "tool_result",
			toolName: "state_commit",
			toolCallId: "call-1",
			isError: false,
			content: [{ type: "text", text: commitText }],
		};

		for (const h of pi.handlers) if (h.event === "tool_result") h.handler(event, ctx);
		for (const h of pi.handlers) if (h.event === "turn_end") h.handler({}, ctx);

		// replaceTranscript was called exactly once, with Σ first, then the held cycle.
		expect(pi.calls.length).toBe(1);
		const { messages, options } = pi.calls[0]!;
		expect((options as Record<string, unknown>).deliverAs).toBe("steer");
		expect(messages.length).toBe(4);
		const sigma = messages[0] as { role: string; content: string };
		expect(sigma.role).toBe("user");
		expect(sigma.content).toContain("durable working state");
		expect(sigma.content).toContain('"objective":"ship it"');
		expect(messages[1]).toEqual(userMsg("go"));
		expect(messages[2]).toEqual(callMsg("call-1", "state_commit"));
		expect(messages[3]).toEqual(toolResultMsg("call-1", "state_commit", commitText));
	});

	test("a stale-version commit throws (isError, in pi's own vocabulary) and writes nothing", async () => {
		const pi = fakePi();
		await installPiState(pi, { schemaPath, statePath });
		await pi.tools.get("state_commit")!.execute("call-1", { patch: { objective: "a" }, version: 0 });
		await expect(
			pi.tools.get("state_commit")!.execute("call-2", { patch: { objective: "b" }, version: 0 }),
		).rejects.toThrow(/stored version is 1/);
		const state = await readFileState(statePath);
		expect(state.version).toBe(1);
		expect(state.doc.objective).toBe("a");
	});

	test("PI_STATE_LOOP=off installs the tools but not the boundary", async () => {
		const pi = fakePi();
		const logs: string[] = [];
		await installPiState(pi, { schemaPath, statePath, env: { PI_STATE_LOOP: "off" }, log: (m) => logs.push(m) });
		expect(pi.tools.size).toBe(2);
		expect(logs.some((l) => l.includes("kill switch is off"))).toBe(true);

		await pi.tools.get("state_commit")!.execute("call-1", { patch: { objective: "a" }, version: 0 });
		const branch = [msgEntry(userMsg("go")), msgEntry(callMsg("call-1", "state_commit"))];
		const ctx = { sessionManager: { getBranch: () => branch } };
		for (const h of pi.handlers) if (h.event === "turn_end") h.handler({}, ctx);
		expect(pi.calls.length).toBe(0);
	});
});

describe("restart survival (ENG-1487's acceptance bar): Σ outlives the process", () => {
	// installStateCommitCache's cache (statewindow.ts's module-level `bound`) is
	// process-wide, not per-`installPiState` call — two real `pi` processes never share
	// it, but two `fakePi` installations in the SAME test process would, unless we tear
	// it down between them exactly like a process exit does. Every case below starts by
	// discarding whatever a previous install left behind.
	beforeEach(() => {
		resetStateCommitCache();
	});

	test("a fresh process re-seeds Σ from the session's own history, not from anything the first process left in memory", async () => {
		// --- "process" #1: commits a patch, then is discarded. ---------------------------
		const firstProcess = fakePi();
		await installPiState(firstProcess, {
			schemaPath,
			statePath,
			env: { PI_STATE_LOOP: "true", PI_STATE_WINDOW_CYCLES: "1" },
		});
		const commitResult = await firstProcess.tools
			.get("state_commit")!
			.execute("call-1", { patch: { objective: "ship it", step: 1 }, version: 0 });
		const commitText = commitResult.content[0]!.text;
		expect(JSON.parse(commitText)).toMatchObject({ ok: true, version: 1, doc: { objective: "ship it", step: 1 } });

		// It really is on disk: the ONLY thing a real restart could ever recover from.
		const onDisk = await readFileState(statePath);
		expect(onDisk.version).toBe(1);
		expect(onDisk.doc.objective).toBe("ship it");

		// The "process" exits. Nothing from `firstProcess` — its handlers, its tools, its
		// closures — is reachable from here on; only `resetStateCommitCache()` stands in
		// for the module-level cache a real restart would never have inherited either.
		resetStateCommitCache();
		expect(stateCommitCache().latest(), "a fresh process starts with no Σ cached at all").toBeNull();

		// --- "process" #2: a brand-new installation against the SAME state file. ---------
		const secondProcess = fakePi();
		const logs: string[] = [];
		await installPiState(secondProcess, {
			schemaPath,
			statePath,
			env: { PI_STATE_LOOP: "true", PI_STATE_WINDOW_CYCLES: "1" },
			log: (m) => logs.push(m),
		});

		// pi reloads the session's transcript on `session_start` — which is what a resumed
		// (or newly started, same working directory) session looks like: the branch it
		// held already carries the FIRST process's commit, persisted the same way any
		// `toolResult` entry survives a reload (see statewindow.ts's seedStateCommitCache).
		const historicalToolResult = toolResultMsg("call-1", "state_commit", commitText);
		const preRestartBranch = [
			msgEntry(userMsg("go")),
			msgEntry(callMsg("call-1", "state_commit")),
			msgEntry(historicalToolResult),
		];
		const sessionStartCtx = { sessionManager: { getSessionId: () => "S1", getBranch: () => preRestartBranch } };
		for (const h of secondProcess.handlers) if (h.event === "session_start") h.handler({}, sessionStartCtx);

		// The reseed alone — before this process has observed a single LIVE tool_result —
		// already recovered Σ. This is the claim seedStateCommitCache exists to make true;
		// asserting it directly (rather than only through a later boundary) is what tells
		// the two survival paths apart if one of them breaks.
		expect(
			stateCommitCache().latest(),
			"session_start's reseed should have recovered the first process's commit from history",
		).toEqual({ toolName: "state_commit", toolCallId: "call-1", text: commitText });

		// Now the turn that was interrupted by the "restart" completes: this process
		// observes the tool_result for the very call the first process already executed
		// and persisted (a real `pi` resuming mid-turn delivers exactly this — the result
		// already exists, only the turn's own completion was cut short), and then
		// `turn_end` fires over the branch as it stands now.
		const toolResultEvent = {
			type: "tool_result",
			toolName: "state_commit",
			toolCallId: "call-1",
			isError: false,
			content: [{ type: "text", text: commitText }],
		};
		const turnCtx = { sessionManager: { getBranch: () => preRestartBranch } };
		for (const h of secondProcess.handlers) if (h.event === "tool_result") h.handler(toolResultEvent, turnCtx);
		for (const h of secondProcess.handlers) if (h.event === "turn_end") h.handler({}, turnCtx);

		// The boundary fired, and it carries the SAME Σ the first process committed — not
		// an empty one, and not a fresh version-0 document.
		expect(secondProcess.calls.length).toBe(1);
		const { messages, options } = secondProcess.calls[0]!;
		expect((options as Record<string, unknown>).deliverAs).toBe("steer");
		const sigma = messages[0] as { role: string; content: string };
		expect(sigma.role).toBe("user");
		expect(sigma.content).toContain("version 1");
		expect(sigma.content).toContain('"objective":"ship it"');
		expect(sigma.content).toContain('"step":1');
	});

	test("state_get on the restarted process reads the persisted version/doc straight off disk", async () => {
		const firstProcess = fakePi();
		await installPiState(firstProcess, { schemaPath, statePath });
		await firstProcess.tools.get("state_commit")!.execute("call-1", { patch: { objective: "ship it" }, version: 0 });

		resetStateCommitCache();

		// This path needs no session replay at all — the file backend is the whole of it —
		// but ENG-1487's bar is "survives a restart", so it is worth confirming explicitly
		// rather than assuming a passing file-backend test elsewhere covers this too.
		const secondProcess = fakePi();
		await installPiState(secondProcess, { schemaPath, statePath });
		const getResult = await secondProcess.tools.get("state_get")!.execute("get-1", {});
		const getPayload = JSON.parse(getResult.content[0]!.text);
		expect(getPayload).toMatchObject({ exists: true, version: 1, doc: { objective: "ship it" } });
	});
});

describe("auto sizing (the default for a schema with no maxStateBytes): resolving it from a context window", () => {
	async function writeAutoSchema(overrides: Record<string, unknown> = {}): Promise<void> {
		await writeFile(schemaPath, JSON.stringify({ keys: { objective: { type: "string" } }, ...overrides }), "utf8");
	}

	async function maxStateBytesFromStateGet(pi: ReturnType<typeof fakePi>): Promise<number> {
		const result = await pi.tools.get("state_get")!.execute("get-1", {});
		return JSON.parse(result.content[0]!.text).maxStateBytes;
	}

	test("with no context window resolvable at all, falls back to DEFAULT_MAX_STATE_BYTES", async () => {
		await writeAutoSchema();
		const pi = fakePi();
		await installPiState(pi, { schemaPath, statePath, env: {} });
		expect(await maxStateBytesFromStateGet(pi)).toBe(4096);
	});

	test("PI_STATE_CONTEXT_WINDOW_TOKENS resolves it at install time, before any session starts", async () => {
		await writeAutoSchema();
		const pi = fakePi();
		await installPiState(pi, { schemaPath, statePath, env: { PI_STATE_CONTEXT_WINDOW_TOKENS: "100000" } });
		expect(await maxStateBytesFromStateGet(pi)).toBe(260000); // 65% of 100000 tokens * 4 bytes/token
	});

	test("session_start's live model.contextWindow supersedes the env-var guess", async () => {
		await writeAutoSchema();
		const pi = fakePi();
		await installPiState(pi, { schemaPath, statePath, env: { PI_STATE_CONTEXT_WINDOW_TOKENS: "100000" } });
		expect(await maxStateBytesFromStateGet(pi)).toBe(260000);

		const ctx = { model: { contextWindow: 200000 }, sessionManager: { getBranch: () => [] } };
		for (const h of pi.handlers) if (h.event === "session_start") h.handler({}, ctx);
		expect(await maxStateBytesFromStateGet(pi)).toBe(520000);
	});

	test("model_select re-resolves it against the newly selected model", async () => {
		await writeAutoSchema({ autoMaxStateBytesPercent: 50 });
		const pi = fakePi();
		await installPiState(pi, { schemaPath, statePath, env: {} });
		expect(await maxStateBytesFromStateGet(pi)).toBe(4096);

		const event = { type: "model_select", model: { contextWindow: 100000 }, source: "set" };
		for (const h of pi.handlers) if (h.event === "model_select") h.handler(event, {});
		expect(await maxStateBytesFromStateGet(pi)).toBe(200000); // 50% of 100000 tokens * 4 bytes/token
	});

	test("an explicit maxStateBytes in the schema file always wins over auto sizing", async () => {
		await writeAutoSchema({ maxStateBytes: 4096 });
		const pi = fakePi();
		await installPiState(pi, { schemaPath, statePath, env: { PI_STATE_CONTEXT_WINDOW_TOKENS: "100000" } });
		expect(await maxStateBytesFromStateGet(pi)).toBe(4096);

		const ctx = { model: { contextWindow: 200000 }, sessionManager: { getBranch: () => [] } };
		for (const h of pi.handlers) if (h.event === "session_start") h.handler({}, ctx);
		expect(await maxStateBytesFromStateGet(pi)).toBe(4096);
	});
});
