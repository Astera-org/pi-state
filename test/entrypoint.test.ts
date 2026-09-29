// End-to-end tests of the standalone entrypoint: a fake `pi` host, the full wiring
// installed against it, a real state file on disk, and `replaceTranscript` receiving the
// bounded transcript after a commit.

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
	await expect(installPiState(pi, { schemaPath, statePath, env: { PI_STATE_MODE: "boundary" } })).rejects.toThrow(
		/replaceTranscript/,
	);
	// No tool or handler is registered.
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
			env: { PI_STATE_MODE: "boundary", PI_STATE_LOOP: "true", PI_STATE_WINDOW_CYCLES: "1" },
			log: (m) => logs.push(m),
		});

		expect([...pi.tools.keys()].sort()).toEqual(["state_commit", "state_get"]);

		// state_get before any commit: exists false, version 0, empty doc.
		const getResult = await pi.tools.get("state_get")!.execute("get-1", {});
		const getPayload = JSON.parse(getResult.content[0]!.text);
		expect(getPayload).toMatchObject({ exists: false, version: 0, doc: {} });

		// Commit a patch.
		const commitResult = await pi.tools
			.get("state_commit")!
			.execute("call-1", { patch: { objective: "ship it", step: 1 }, version: 0 });
		const commitText = commitResult.content[0]!.text;
		const commitPayload = JSON.parse(commitText);
		expect(commitPayload.ok).toBe(true);
		expect(commitPayload.version).toBe(1);
		expect(commitPayload.doc).toEqual({ objective: "ship it", step: 1 });

		// The commit is persisted to the state file.
		const onDisk = await readFileState(statePath);
		expect(onDisk.exists).toBe(true);
		expect(onDisk.version).toBe(1);
		expect(onDisk.doc.objective).toBe("ship it");
		const raw = await readFile(statePath, "utf8");
		expect(() => JSON.parse(raw)).not.toThrow();

		// Deliver tool_result, then turn_end, over the current branch.
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

		// replaceTranscript is called once, with Σ first, then the held cycle.
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

describe("restart survival: Σ outlives the process", () => {
	// The Σ commit cache (statewindow.ts's module-level `bound`) is process-wide, so it is
	// reset before each case.
	beforeEach(() => {
		resetStateCommitCache();
	});

	test("a fresh process re-seeds Σ from the session's own history, not from anything the first process left in memory", async () => {
		// --- Process 1: commits a patch. ---
		const firstProcess = fakePi();
		await installPiState(firstProcess, {
			schemaPath,
			statePath,
			env: { PI_STATE_MODE: "boundary", PI_STATE_LOOP: "true", PI_STATE_WINDOW_CYCLES: "1" },
		});
		const commitResult = await firstProcess.tools
			.get("state_commit")!
			.execute("call-1", { patch: { objective: "ship it", step: 1 }, version: 0 });
		const commitText = commitResult.content[0]!.text;
		expect(JSON.parse(commitText)).toMatchObject({ ok: true, version: 1, doc: { objective: "ship it", step: 1 } });

		// The commit is on disk.
		const onDisk = await readFileState(statePath);
		expect(onDisk.version).toBe(1);
		expect(onDisk.doc.objective).toBe("ship it");

		// Process exit: `firstProcess` is not used again; resetStateCommitCache() clears the
		// module-level cache.
		resetStateCommitCache();
		expect(stateCommitCache().latest(), "a fresh process starts with no Σ cached at all").toBeNull();

		// --- Process 2: new installation against the same state file. ---
		const secondProcess = fakePi();
		const logs: string[] = [];
		await installPiState(secondProcess, {
			schemaPath,
			statePath,
			env: { PI_STATE_MODE: "boundary", PI_STATE_LOOP: "true", PI_STATE_WINDOW_CYCLES: "1" },
			log: (m) => logs.push(m),
		});

		// On `session_start` the branch already contains process 1's commit as a `toolResult`
		// entry (see statewindow.ts's seedStateCommitCache).
		const historicalToolResult = toolResultMsg("call-1", "state_commit", commitText);
		const preRestartBranch = [
			msgEntry(userMsg("go")),
			msgEntry(callMsg("call-1", "state_commit")),
			msgEntry(historicalToolResult),
		];
		const sessionStartCtx = { sessionManager: { getSessionId: () => "S1", getBranch: () => preRestartBranch } };
		for (const h of secondProcess.handlers) if (h.event === "session_start") h.handler({}, sessionStartCtx);

		// The reseed alone recovers Σ, before any live tool_result.
		expect(
			stateCommitCache().latest(),
			"session_start's reseed should have recovered the first process's commit from history",
		).toEqual({ toolName: "state_commit", toolCallId: "call-1", text: commitText });

		// Process 2 observes the tool_result for the call process 1 already executed, then
		// `turn_end` fires over the current branch.
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

		// The boundary fires and carries the Σ process 1 committed.
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

		// state_get reads from the file backend; no session replay is involved.
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

describe("PI_STATE_MODE", () => {
	const handlerEvents = (pi: ReturnType<typeof fakePi>) => pi.handlers.map((h) => h.event);

	test("paper installs the paper handlers and no turn_end boundary", async () => {
		const pi = fakePi();
		await installPiState(pi, { schemaPath, statePath, env: { PI_STATE_MODE: "paper" } });
		const events = handlerEvents(pi);
		for (const event of ["before_agent_start", "context", "message_end", "tool_call"])
			expect(events).toContain(event);
		expect(events).not.toContain("turn_end");
	});

	test("paper installs on a pi without replaceTranscript", async () => {
		const pi = fakePi({ replaceTranscript: undefined });
		await installPiState(pi, { schemaPath, statePath, env: { PI_STATE_MODE: "paper" } });
		expect([...pi.tools.keys()].sort()).toEqual(["state_commit", "state_get"]);
		expect(handlerEvents(pi)).toContain("context");
	});

	test("unset and empty mode install paper mode, without a turn_end boundary", async () => {
		for (const env of [{}, { PI_STATE_MODE: "" }]) {
			const pi = fakePi({ replaceTranscript: undefined });
			await installPiState(pi, { schemaPath, statePath, env });
			const events = handlerEvents(pi);
			expect(events).toContain("context");
			expect(events).not.toContain("turn_end");
		}
	});

	test("boundary refuses a pi without replaceTranscript", async () => {
		const pi = fakePi({ replaceTranscript: undefined });
		await expect(installPiState(pi, { schemaPath, statePath, env: { PI_STATE_MODE: "boundary" } })).rejects.toThrow(
			/replaceTranscript/,
		);
	});

	test("boundary installs the turn_end boundary and no paper handlers", async () => {
		const pi = fakePi();
		await installPiState(pi, { schemaPath, statePath, env: { PI_STATE_MODE: "boundary" } });
		const events = handlerEvents(pi);
		expect(events).toContain("turn_end");
		for (const event of ["before_agent_start", "context", "message_end", "tool_call"])
			expect(events).not.toContain(event);
	});

	test("the system prompt carries the contract in paper mode and not in boundary mode", async () => {
		const prompt = async (env: NodeJS.ProcessEnv) => {
			const pi = fakePi();
			await installPiState(pi, { schemaPath, statePath, env });
			const handler = pi.handlers.find((h) => h.event === "before_agent_start")?.handler;
			return handler?.({ systemPrompt: "base" }, {}) as { systemPrompt: string } | undefined;
		};
		expect((await prompt({ PI_STATE_MODE: "paper" }))?.systemPrompt).toMatch(/^base\n\n.*state_commit/s);
		expect((await prompt({}))?.systemPrompt).toMatch(/^base\n\n.*state_commit/s);
		expect(await prompt({ PI_STATE_MODE: "boundary" })).toBeUndefined();
	});

	test("paper defaults to one trailing cycle and PI_STATE_WINDOW_CYCLES=0 keeps none", async () => {
		const held = [
			userMsg("go"),
			callMsg("a", "read"),
			toolResultMsg("a", "read", "x"),
			callMsg("b", "read"),
			toolResultMsg("b", "read", "y"),
		];
		const project = async (env: NodeJS.ProcessEnv) => {
			const pi = fakePi();
			await installPiState(pi, { schemaPath, statePath, env });
			const context = pi.handlers.find((h) => h.event === "context")!.handler;
			return (context({ messages: held }, {}) as { messages: unknown[] }).messages;
		};
		expect((await project({ PI_STATE_MODE: "paper" })).length).toBe(4);
		expect((await project({ PI_STATE_MODE: "paper", PI_STATE_WINDOW_CYCLES: "0" })).length).toBe(2);
		expect((await project({ PI_STATE_MODE: "paper", PI_STATE_WINDOW_CYCLES: "2" })).length).toBe(6);
	});

	test("an invalid mode is refused: logged, with no mode handlers installed", async () => {
		const pi = fakePi();
		const logs: string[] = [];
		await installPiState(pi, { schemaPath, statePath, env: { PI_STATE_MODE: "papr" }, log: (m) => logs.push(m) });
		expect(pi.handlers.map((h) => h.event).filter((e) => e !== "session_start" && e !== "model_select")).toEqual([
			"tool_result",
		]);
		expect(logs.some((l) => l.includes("[condition=state-mode fault=yes]"))).toBe(true);
	});

	test("an invalid mode on a pi without replaceTranscript is logged as a mode refusal, not thrown", async () => {
		const pi = fakePi({ replaceTranscript: undefined });
		const logs: string[] = [];
		await installPiState(pi, { schemaPath, statePath, env: { PI_STATE_MODE: "papr" }, log: (m) => logs.push(m) });
		expect(logs.some((l) => l.includes("[condition=state-mode fault=yes]"))).toBe(true);
	});

	test("an invalid PI_STATE_REQUIRE_COMMIT is refused in paper mode", async () => {
		for (const bad of ["0", "some", "-2"]) {
			const pi = fakePi();
			const logs: string[] = [];
			await installPiState(pi, {
				schemaPath,
				statePath,
				env: { PI_STATE_MODE: "paper", PI_STATE_REQUIRE_COMMIT: bad },
				log: (m) => logs.push(m),
			});
			expect(handlerEvents(pi), bad).not.toContain("context");
			expect(
				logs.some((l) => l.includes("[condition=require-commit fault=yes]")),
				bad,
			).toBe(true);
		}
	});

	test("PI_STATE_LOOP=off installs no paper handlers", async () => {
		const pi = fakePi();
		await installPiState(pi, {
			schemaPath,
			statePath,
			env: { PI_STATE_MODE: "paper", PI_STATE_LOOP: "off" },
			log: () => {},
		});
		expect(handlerEvents(pi)).not.toContain("context");
	});

	test("PI_STATE_REQUIRE_COMMIT is not read in boundary mode", async () => {
		const pi = fakePi();
		await installPiState(pi, {
			schemaPath,
			statePath,
			env: { PI_STATE_MODE: "boundary", PI_STATE_REQUIRE_COMMIT: "bogus" },
		});
		expect(handlerEvents(pi)).toContain("turn_end");
	});
});
