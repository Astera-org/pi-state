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
